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

import { getActionsNeedingReconciliation, getStaleActions, reconcile, logReconciliationCheck } from "../services/actionStateMachine.js";
import { getInstallationClient } from "../lib/github.js";
import { wrapOctokit } from "../lib/githubWrapper.js";
import { logger } from "../lib/logger.js";
import { db } from "../lib/db.js";

/**
 * Run reconciliation for all eligible actions.
 * Called periodically (every 6 hours) or via API trigger.
 */
export async function runReconciliation() {
  logger.info("Reconciliation scan starting");

  // Phase 1: Stale actions cleanup
  const staleActions = await getStaleActions();
  let staleFailed = 0;
  let staleCancelled = 0;
  for (const action of staleActions) {
    try {
      // Transition stale actions to failed or cancelled depending on state
      if (action.status === "executing") {
        await db.query(
          `UPDATE managed_actions SET status = 'failed', resolved_at = NOW(), error_message = 'Reconciled: stuck in executing for >6h' WHERE id = $1`,
          [action.id]
        );
        staleFailed++;
      } else {
        await db.query(
          `UPDATE managed_actions SET status = 'cancelled', resolved_at = NOW(), error_message = 'Reconciled: stuck in ' || status || ' state' WHERE id = $1`,
          [action.id]
        );
        staleCancelled++;
      }
    } catch (err) {
      logger.warn({ err, actionId: action.id }, "Stale action cleanup failed");
    }
  }
  if (staleActions.length > 0) {
    logger.info({ staleFailed, staleCancelled }, "Stale actions cleaned up");
  }

  // Phase 2: Reconcile succeeded actions against GitHub
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

  // Phase 3: Reconcile heal PR outcomes
  const healResult = await reconcileHealPRs();

  return { total: actions.length, confirmed, drifted, errors, healPRs: healResult };
}

/**
 * Reconcile a single action against GitHub's current state.
 */
async function reconcileAction(action) {
  if (!action.repo_full_name) {
    logger.warn({ actionId: action.id }, "Reconciliation skipped: no repo_full_name");
    return { drifted: false };
  }
  const [owner, repo] = action.repo_full_name.split("/");

  // Resolve installation_id from repositories table
  const { rows: repoRows } = await db.query(
    "SELECT installation_id FROM repositories WHERE github_id = $1",
    [action.repo_id]
  );
  const installationId = repoRows[0]?.installation_id;
  if (!installationId) {
    logger.warn({ actionId: action.id, repoId: action.repo_id }, "Reconciliation skipped: no installation found for repo");
    return { drifted: false };
  }
  const octokit = wrapOctokit(await getInstallationClient(installationId));

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
/**
 * Reconcile heal PRs — check GitHub state and update heal_prs.status + managed_actions.heal_outcome.
 * Runs alongside the periodic reconciliation scan.
 */
async function reconcileHealPRs() {
  const { rows: openHeals } = await db.query(
    `SELECT h.id, h.github_pr_number, h.repo_id, h.ci_run_id, h.status, h.created_at,
            r.full_name, r.installation_id,
            c.branch AS ci_branch
     FROM heal_prs h
     JOIN repositories r ON r.github_id = h.repo_id
     LEFT JOIN ci_runs c ON c.id = h.ci_run_id
     WHERE h.status = 'open'
     ORDER BY h.created_at ASC`
  );

  if (openHeals.length === 0) {
    return { checked: 0, updated: 0 };
  }

  logger.info({ count: openHeals.length }, "Heal PR reconciliation starting");

  // Group by installation to reuse octokit instances
  const byInstallation = new Map();
  for (const heal of openHeals) {
    if (!byInstallation.has(heal.installation_id)) {
      byInstallation.set(heal.installation_id, []);
    }
    byInstallation.get(heal.installation_id).push(heal);
  }

  let updated = 0;
  let verified = 0;
  let ineffective = 0;
  let rejected = 0;

  for (const [installationId, heals] of byInstallation) {
    let octokit;
    try {
      octokit = wrapOctokit(await getInstallationClient(installationId));
    } catch (_e) {
      logger.warn({ installationId }, "Heal reconciliation: no installation client");
      continue;
    }

    for (const heal of heals) {
      const [owner, repo] = heal.full_name.split("/");
      const prNumber = heal.github_pr_number;

      try {
        const { data: pr } = await octokit.request(
          "GET /repos/{owner}/{repo}/pulls/{pull_number}",
          { owner, repo, pull_number: prNumber }
        );

        if (pr.state === "open") continue; // Still pending

        const newStatus = pr.merged ? "merged" : "closed";

        // Update heal_prs.status
        await db.query(
          "UPDATE heal_prs SET status = $1, updated_at = NOW() WHERE id = $2",
          [newStatus, heal.id]
        );

        // Update managed_actions.heal_outcome
        if (pr.merged) {
          // Check if the next CI run on that branch passed
          let outcome = "unknown";

          if (heal.ci_branch) {
            const { rows: nextRuns } = await db.query(
              `SELECT conclusion FROM ci_runs
               WHERE repo_id = $1 AND branch = $2
                 AND created_at > $3
               ORDER BY created_at ASC LIMIT 1`,
              [heal.repo_id, heal.ci_branch, heal.created_at]
            );

            if (nextRuns.length > 0) {
              outcome = nextRuns[0].conclusion === "success" ? "verified" : "ineffective";
            }
          }

          await db.query(
            `UPDATE managed_actions SET heal_outcome = $1
             WHERE pillar = 'ci_healing'
               AND action_type = 'create-patch-pr'
               AND repo_id = $2
               AND heal_outcome IS NULL
               AND evidence @>('{"pr_number":' || $3 || '}')::jsonb`,
            [outcome, heal.repo_id, prNumber]
          );

          if (outcome === "verified") verified++;
          else if (outcome === "ineffective") ineffective++;
        } else {
          // Closed without merge — human rejected
          await db.query(
            `UPDATE managed_actions SET heal_outcome = 'rejected'
             WHERE pillar = 'ci_healing'
               AND action_type = 'create-patch-pr'
               AND repo_id = $1
               AND heal_outcome IS NULL
               AND evidence @>('{"pr_number":' || $2 || '}')::jsonb`,
            [heal.repo_id, prNumber]
          );
          rejected++;
        }

        updated++;
        logger.info(
          { repo: heal.full_name, pr: prNumber, newStatus, healOutcome: pr.merged ? "pending-check" : "rejected" },
          "Heal PR reconciled"
        );
      } catch (err) {
        logger.warn({ err: err.message, repo: heal.full_name, pr: prNumber }, "Heal PR reconciliation check failed");
      }
    }
  }

  logger.info(
    { checked: openHeals.length, updated, verified, ineffective, rejected },
    "Heal PR reconciliation complete"
  );

  return { checked: openHeals.length, updated, verified, ineffective, rejected };
}

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
    logger.debug({ actionId: action?.id, err: _e }, "Label drift check failed — assuming no drift");
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
    logger.debug({ actionId: action?.id, err: _e }, "Review drift check failed — assuming no drift");
    return false;
  }
