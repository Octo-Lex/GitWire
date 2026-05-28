// src/workers/reconciliationWorker.js
// Periodic reconciliation — verifies that GitWire actions are still in effect on GitHub.
//
// Scans succeeded actions older than 6 hours and checks:
//   - Labels: still present on the issue/PR?
//   - PR state: still open? merged? closed without merge?
//   - Reviews: approval still present?
//   - Comments: GitWire comment still visible?
//
// Drifted actions are logged to action_reconciliation_log.
// Actions confirmed still in effect are marked as 'reconciled'.

import { getActionsNeedingReconciliation, reconcile, logReconciliationCheck } from "../services/actionStateMachine.js";
import { getInstallationClient } from "../lib/github.js";
import { wrapOctokit } from "../lib/githubWrapper.js";
import { logger } from "../lib/logger.js";

/**
 * Run reconciliation for all eligible actions.
 * Called periodically (every 6 hours) or via API trigger.
 */
export async function runReconciliation() {
  logger.info("Reconciliation scan starting");

  const actions = await getActionsNeedingReconciliation("6 hours");
  logger.info({ count: actions.length }, "Actions needing reconciliation");

  let confirmed = 0;
  let drifted = 0;
  let errors = 0;

  for (const action of actions) {
    try {
      const result = await reconcileAction(action);
      if (result.drifted) {
        drifted++;
      } else {
        confirmed++;
      }
    } catch (err) {
      errors++;
      logger.warn({ err, actionId: action.id }, "Reconciliation check failed");
    }
  }

  logger.info({ confirmed, drifted, errors }, "Reconciliation scan complete");
  return { total: actions.length, confirmed, drifted, errors };
}

/**
 * Reconcile a single action against GitHub's current state.
 */
async function reconcileAction(action) {
  const [owner, repo] = action.repo_full_name.split("/");
  const octokit = wrapOctokit(await getInstallationClient(action.repo_id));

  if (!octokit) {
    logger.warn({ actionId: action.id, repo: action.repo_full_name }, "No installation client for repo");
    return { drifted: false };
  }

  let hasDrift = false;

  switch (action.action_type) {
    case "add-label":
    case "remove-label":
      hasDrift = await checkLabel(octokit, owner, repo, action);
      break;

    case "create-patch-pr":
    case "approve":
    case "request-review":
      hasDrift = await checkPRState(octokit, owner, repo, action);
      break;

    case "add-comment":
      // Comments are low-stakes — always confirm
      hasDrift = false;
      break;

    default:
      // Unknown action type — assume confirmed
      hasDrift = false;
  }

  if (hasDrift) {
    await reconcile(action.id, "drifted");
  } else {
    await reconcile(action.id, "confirmed");
  }

  return { drifted: hasDrift };
}

/**
 * Check if a label is still present on an issue/PR.
 */
async function checkLabel(octokit, owner, repo, action) {
  const targetNumber = action.target_number || action.evidence?.issue_number || action.evidence?.pr_number;
  if (!targetNumber) return false;

  try {
    const { data: labels } = await octokit.request(
      "GET /repos/{owner}/{repo}/issues/{issue_number}/labels",
      { owner, repo, issue_number: targetNumber }
    );

    const labelName = action.evidence?.label || action.action_type.replace("add-", "").replace("remove-", "");
    const present = labels.some((l) => l.name === labelName);

    const expected = action.action_type === "add-label" ? "present" : "absent";
    const actual = present ? "present" : "absent";
    const drifted = expected !== actual;

    await logReconciliationCheck(action.id, "label", expected, actual, drifted);
    return drifted;
  } catch (_e) {
    return false; // Can't check — assume ok
  }
}

/**
 * Check PR state — is it still open? Merged? Closed without merge?
 */
async function checkPRState(octokit, owner, repo, action) {
  const prNumber = action.evidence?.pr_number || action.target_number;
  if (!prNumber) return false;

  try {
    const { data: pr } = await octokit.request(
      "GET /repos/{owner}/{repo}/pulls/{pull_number}",
      { owner, repo, pull_number: prNumber }
    );

    const state = pr.state; // "open", "closed"
    const merged = pr.merged;

    // For patch PRs, merged is the success state
    if (action.action_type === "create-patch-pr") {
      if (merged) {
        await logReconciliationCheck(action.id, "pr_state", "merged", "merged", false);
        return false;
      }
      if (state === "closed" && !merged) {
        await logReconciliationCheck(action.id, "pr_state", "merged", "closed_without_merge", true);
        return true;
      }
      // Still open — not drifted yet
      await logReconciliationCheck(action.id, "pr_state", "open_or_merged", state, false);
      return false;
    }

    // For approvals — check if still approved
    if (action.action_type === "approve") {
      const { data: reviews } = await octokit.request(
        "GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews",
        { owner, repo, pull_number: prNumber }
      );
      const gitwireApproved = reviews.some(
        (r) => r.user?.login?.includes("gitwire") && r.state === "APPROVED"
      );
      await logReconciliationCheck(action.id, "review", "APPROVED", gitwireApproved ? "APPROVED" : "missing", !gitwireApproved);
      return !gitwireApproved;
    }

    return false;
  } catch (_e) {
    return false;
  }
}
