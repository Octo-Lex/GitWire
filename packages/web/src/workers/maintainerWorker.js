// src/workers/maintainerWorker.js
// Scheduled maintainer: stale issue/PR management, merged branch cleanup.
//
// Runs every 6 hours via BullMQ repeatable job.
// Pattern: scan repos → find stale items → warn → close → cleanup branches.
// All mutations check idempotency key before acting.

import { createWorker, QUEUES } from "../lib/queue.js";
import { maintainerQueue } from "../lib/queue.js";
import { getInstallationClient } from "../lib/github.js";
import { maintainerService } from "../services/maintainerService.js";
import { getConfigForRepo } from "../services/configService.js";
import { isPillarEnabled, getStaleConfig, isStaleExempt } from "@gitwire/rules";
import { db } from "../lib/db.js";
import { logger } from "../lib/logger.js";

const DEFAULT_STALE_ISSUE_DAYS = 60;
const DEFAULT_STALE_PR_DAYS = 30;
const DEFAULT_WARN_DAYS = 7;
const GITWIRE_BRANCH_PREFIX = "gitwire/heal-";

export function startMaintainerWorker() {
  return createWorker(QUEUES.MAINTAINER, async (job) => {
    switch (job.name) {
      case "stale-scan":
        await runStaleScan(job.data);
        break;
      case "branch-cleanup":
        await runBranchCleanup(job.data);
        break;
      case "comment-command":
        await runCommentCommand(job.data);
        break;
    }
  });
}

// ── Stale Issue/PR Scanner ────────────────────────────────────────────────────

async function runStaleScan({ installationId, repoFullName }) {
  logger.info({ repo: repoFullName }, "Stale scan started");

  const octokit = await getInstallationClient(installationId);
  const [owner, repo] = repoFullName.split("/");

  // Load repo settings
  const repoRow = await findRepo(repoFullName);
  if (!repoRow) return;

  // ── Check .gitwire.yml pillar config ────────────────────────────────────
  const repoConfig = await getConfigForRepo(repoFullName);
  if (!isPillarEnabled("maintainer", repoConfig)) {
    logger.info({ repo: repoFullName }, "Maintainer disabled via .gitwire.yml — skipping");
    return;
  }

  const settings = await maintainerService.getSettings(repoRow.github_id);
  const enabled = settings?.enabled ?? true;
  if (!enabled) {
    logger.info({ repo: repoFullName }, "Maintainer disabled — skipping");
    return;
  }

  // Stale config: .gitwire.yml overrides DB settings, DB overrides defaults
  const issueStale = getStaleConfig("issues", repoConfig);
  const prStale = getStaleConfig("prs", repoConfig);
  const staleIssueDays = settings?.stale_issue_days ?? issueStale.warn_days ?? DEFAULT_STALE_ISSUE_DAYS;
  const stalePrDays = settings?.stale_pr_days ?? prStale.warn_days ?? DEFAULT_STALE_PR_DAYS;
  const warnDays = settings?.stale_warn_days ?? DEFAULT_WARN_DAYS;

  // Process issues
  await processStaleItems(octokit, owner, repo, "issue", staleIssueDays, warnDays, repoRow.github_id, repoConfig);
  // Process PRs
  await processStaleItems(octokit, owner, repo, "pr", stalePrDays, warnDays, repoRow.github_id, repoConfig);
}

async function processStaleItems(octokit, owner, repo, type, staleDays, warnDays, repoId, repoConfig) {
  const apiPath = type === "issue"
    ? "GET /repos/{owner}/{repo}/issues"
    : "GET /repos/{owner}/{repo}/pulls";

  const state = "open";
  const perPage = 100;
  let page = 1;
  let processed = 0;

  while (true) {
    const { data: items } = await octokit.request(apiPath, {
      owner, repo, state, per_page: perPage, page,
      sort: "updated", direction: "asc",
    });

    if (items.length === 0) break;

    for (const item of items) {
      // Skip items with recent activity
      const updatedAt = new Date(item.updated_at);
      const daysSinceUpdate = (Date.now() - updatedAt.getTime()) / (1000 * 60 * 60 * 24);

      if (daysSinceUpdate < staleDays - warnDays) continue;

      // Skip if bot-authored (avoid recursion)
      if (item.user && item.user.login.includes("[bot]")) continue;

      // Skip if exempt by .gitwire.yml config
      const itemLabels = (item.labels || []).map((l) => typeof l === "string" ? l : l.name);
      if (isStaleExempt(itemLabels, type === "issue" ? "issues" : "prs", repoConfig)) continue;

      const number = item.number;
      const idempotencyBase = "stale:" + repoId + ":" + type + ":" + number;

      if (daysSinceUpdate >= staleDays) {
        // Close stale item
        const closeKey = idempotencyBase + ":close";
        if (await maintainerService.actionExists(closeKey)) continue;

        await closeStaleItem(octokit, owner, repo, type, number, staleDays, repoId, closeKey);
        processed++;
      } else if (daysSinceUpdate >= staleDays - warnDays) {
        // Warn about upcoming closure
        const warnKey = idempotencyBase + ":warn";
        if (await maintainerService.actionExists(warnKey)) continue;

        await warnStaleItem(octokit, owner, repo, type, number, staleDays, daysSinceUpdate, repoId, warnKey);
        processed++;
      }
    }

    if (items.length < perPage) break;
    page++;
  }

  if (processed > 0) {
    logger.info({ repo: owner + "/" + repo, type, processed }, "Stale items processed");
  }
}

async function warnStaleItem(octokit, owner, repo, type, number, staleDays, daysIdle, repoId, idempotencyKey) {
  const daysLeft = Math.ceil(staleDays - daysIdle);
  const body = [
    "⏰ **GitWire Stale Warning**",
    "",
    "This " + type + " has had no activity for **" + Math.floor(daysIdle) + " days**.",
    "It will be automatically closed in **" + daysLeft + " days** if no further activity occurs.",
    "",
    "To keep it open, leave a comment or push an update.",
    "",
    "<!-- gitwire:stale-warn -->",
  ].join("\n");

  try {
    await octokit.request("POST /repos/{owner}/{repo}/issues/{issue_number}/comments", {
      owner, repo, issue_number: number, body: body,
    });

    await maintainerService.recordAction(repoId, {
      actionType: "stale_warn", targetType: type, targetNumber: String(number),
      idempotencyKey, status: "applied",
      result: "Warned: " + daysLeft + " days remaining",
    });
  } catch (err) {
    logger.error({ err, type, number }, "Failed to warn stale item");
    await maintainerService.recordAction(repoId, {
      actionType: "stale_warn", targetType: type, targetNumber: String(number),
      idempotencyKey, status: "failed", result: err.message,
    });
  }
}

async function closeStaleItem(octokit, owner, repo, type, number, staleDays, repoId, idempotencyKey) {
  // Re-fetch to verify still open and unchanged
  const { data: item } = await octokit.request("GET /repos/{owner}/{repo}/issues/{issue_number}", {
    owner, repo, issue_number: number,
  });

  if (item.state !== "open") {
    await maintainerService.recordAction(repoId, {
      actionType: "stale_close", targetType: type, targetNumber: String(number),
      idempotencyKey, status: "skipped", result: "Already closed",
    });
    return;
  }

  const body = [
    "🔒 **GitWire Auto-Close: Stale " + type + "**",
    "",
    "This " + type + " has had no activity for **" + staleDays + " days** and has been automatically closed.",
    "",
    "If this was closed in error, leave a comment and a maintainer can reopen it.",
    "",
    "<!-- gitwire:stale-close -->",
  ].join("\n");

  try {
    // Comment first
    await octokit.request("POST /repos/{owner}/{repo}/issues/{issue_number}/comments", {
      owner, repo, issue_number: number, body: body,
    });

    // Add label
    try {
      await octokit.request("POST /repos/{owner}/{repo}/issues/{issue_number}/labels", {
        owner, repo, issue_number: number, labels: ["gitwire:stale-closed"],
      });
    } catch (_) { /* label may not exist, that's OK */ }

    // Close
    await octokit.request("PATCH /repos/{owner}/{repo}/issues/{issue_number}", {
      owner, repo, issue_number: number, state: "closed",
    });

    await maintainerService.recordAction(repoId, {
      actionType: "stale_close", targetType: type, targetNumber: String(number),
      idempotencyKey, status: "applied", result: "Closed after " + staleDays + " days idle",
    });

    logger.info({ type, number, repo: owner + "/" + repo }, "Stale item closed");
  } catch (err) {
    logger.error({ err, type, number }, "Failed to close stale item");
    await maintainerService.recordAction(repoId, {
      actionType: "stale_close", targetType: type, targetNumber: String(number),
      idempotencyKey, status: "failed", result: err.message,
    });
  }
}

// ── Merged Branch Cleanup ─────────────────────────────────────────────────────

async function runBranchCleanup({ installationId, repoFullName }) {
  logger.info({ repo: repoFullName }, "Branch cleanup started");

  const octokit = await getInstallationClient(installationId);
  const [owner, repo] = repoFullName.split("/");

  const repoRow = await findRepo(repoFullName);
  if (!repoRow) return;

  // ── Check .gitwire.yml pillar config ────────────────────────────────────
  const repoConfig = await getConfigForRepo(repoFullName);
  if (!isPillarEnabled("maintainer", repoConfig)) {
    logger.info({ repo: repoFullName }, "Maintainer disabled via .gitwire.yml — skipping branch cleanup");
    return;
  }

  const branchCleanupOpts = repoConfig.pillars?.maintainer?.branch_cleanup || {};
  if (branchCleanupOpts.enabled === false) {
    logger.info({ repo: repoFullName }, "Branch cleanup disabled via .gitwire.yml — skipping");
    return;
  }

  const settings = await maintainerService.getSettings(repoRow.github_id);
  if (settings && !settings.cleanup_branches) {
    logger.info({ repo: repoFullName }, "Branch cleanup disabled — skipping");
    return;
  }

  // List all branches with the gitwire/ prefix
  let cleaned = 0;
  let page = 1;

  while (true) {
    const { data: branches } = await octokit.request("GET /repos/{owner}/{repo}/branches", {
      owner, repo, per_page: 100, page,
    });

    if (branches.length === 0) break;

    for (const branch of branches) {
      if (!branch.name.startsWith(GITWIRE_BRANCH_PREFIX)) continue;

      // Check if associated PR exists and is merged or closed
      const runId = branch.name.replace(GITWIRE_BRANCH_PREFIX, "");
      const idempotencyKey = "branch-cleanup:" + repoRow.github_id + ":" + branch.name;

      if (await maintainerService.actionExists(idempotencyKey)) continue;

      // Check for open PRs on this branch
      const { data: prs } = await octokit.request("GET /repos/{owner}/{repo}/pulls", {
        owner, repo, head: owner + ":" + branch.name, state: "open",
      });

      if (prs.length > 0) {
        // Branch has open PR — don't delete
        continue;
      }

      // Safe to delete — no open PRs
      try {
        await octokit.request("DELETE /repos/{owner}/{repo}/git/refs/heads/{branch}", {
          owner, repo, branch: branch.name,
        });

        await maintainerService.recordAction(repoRow.github_id, {
          actionType: "branch_cleanup", targetType: "branch", targetNumber: branch.name,
          idempotencyKey, status: "applied", result: "Deleted (no open PR)",
        });

        cleaned++;
        logger.info({ branch: branch.name, repo: repoFullName }, "Merged branch cleaned up");
      } catch (err) {
        if (err.status === 404) {
          // Already deleted
          await maintainerService.recordAction(repoRow.github_id, {
            actionType: "branch_cleanup", targetType: "branch", targetNumber: branch.name,
            idempotencyKey, status: "skipped", result: "Already deleted",
          });
        } else {
          logger.error({ err, branch: branch.name }, "Failed to delete branch");
          await maintainerService.recordAction(repoRow.github_id, {
            actionType: "branch_cleanup", targetType: "branch", targetNumber: branch.name,
            idempotencyKey, status: "failed", result: err.message,
          });
        }
      }
    }

    if (branches.length < 100) break;
    page++;
  }

  if (cleaned > 0) {
    logger.info({ repo: repoFullName, cleaned }, "Branches cleaned up");
  }
}

// ── Comment Command Handler ──────────────────────────────────────────────────

async function runCommentCommand(data) {
  const { action, installationId, repoFullName, issueNumber, commentId, authorLogin, value } = data;
  logger.info({ action, repo: repoFullName, author: authorLogin }, "Processing comment command");

  const octokit = await getInstallationClient(installationId);
  const [owner, repo] = repoFullName.split("/");
  const repoRow = await findRepo(repoFullName);
  if (!repoRow) return;

  let responseText = null;

  switch (action) {
    case "stale_scan":
      await maintainerQueue.add("stale-scan", {
        installationId, repoFullName,
      });
      responseText = "\u2705 **GitWire:** Stale scan triggered for this repo. Results will appear as comments on stale items.";
      break;

    case "branch_cleanup":
      await maintainerQueue.add("branch-cleanup", {
        installationId, repoFullName,
      });
      responseText = "\u2705 **GitWire:** Branch cleanup triggered for this repo.";
      break;

    case "set_stale_issue_days":
      await maintainerService.upsertSettings(repoRow.github_id, { stale_issue_days: value });
      responseText = "\u2705 **GitWire:** Stale issue threshold set to **" + value + " days**.";
      break;

    case "set_stale_pr_days":
      await maintainerService.upsertSettings(repoRow.github_id, { stale_pr_days: value });
      responseText = "\u2705 **GitWire:** Stale PR threshold set to **" + value + " days**.";
      break;

    case "stop":
      await maintainerService.upsertSettings(repoRow.github_id, { enabled: false });
      responseText = "\u23f8\ufe0f **GitWire:** Maintainer automation paused for this repo.";
      break;

    case "status": {
      // Fetch the specific issue/PR for context
      const { data: ghItem } = await octokit.request("GET /repos/{owner}/{repo}/issues/{issue_number}", {
        owner, repo, issue_number: issueNumber,
      });
      const isPR = !!ghItem.pull_request;
      const daysSinceUpdate = ((Date.now() - new Date(ghItem.updated_at).getTime()) / (1000 * 60 * 60 * 24)).toFixed(1);
      const settings = await maintainerService.getSettings(repoRow.github_id);
      const staleIssueDays = settings?.stale_issue_days ?? DEFAULT_STALE_ISSUE_DAYS;
      const stalePrDays = settings?.stale_pr_days ?? DEFAULT_STALE_PR_DAYS;
      const staleThreshold = isPR ? stalePrDays : staleIssueDays;
      const daysUntilStale = Math.max(0, staleThreshold - parseFloat(daysSinceUpdate));

      // Build context about THIS item
      const lines = [];
      lines.push("**GitWire Status for #" + issueNumber + "**");
      lines.push("");
      lines.push("Type: **" + (isPR ? "Pull Request" : "Issue") + "** | State: **" + ghItem.state + "** | Updated **" + daysSinceUpdate + "d ago**");

      // Triage info from DB - try issues first, then PRs
      const { rows: issueRows } = await db.query(
        "SELECT triage_type, triage_priority, triage_summary FROM issues WHERE repo_id = $1 AND number = $2",
        [repoRow.github_id, issueNumber]
      );
      const { rows: prRows } = await db.query(
        "SELECT triage_type, triage_size, triage_risk, triage_summary, head_branch FROM pull_requests WHERE repo_id = $1 AND number = $2",
        [repoRow.github_id, issueNumber]
      );
      const triageRow = issueRows[0] || prRows[0];
      if (triageRow && triageRow.triage_type) {
        const t = triageRow;
        const priorityLabel = isPR ? (t.triage_size || t.triage_risk) : t.triage_priority;
        lines.push("Triage: **" + t.triage_type + "** (" + (priorityLabel || "unknown") + ") — " + (t.triage_summary || "no summary"));
      } else {
        lines.push("Triage: _not yet classified_");
      }

      // Labels
      const labelNames = (ghItem.labels || []).map(l => l.name).filter(Boolean);
      if (labelNames.length > 0) {
        lines.push("Labels: " + labelNames.map(l => "`" + l + "`").join(", "));
      }

      // CI info (PRs only) - match by head_branch
      if (isPR) {
        const prRow = prRows[0];
        if (prRow) {
          const { rows: ciRows } = await db.query(
            "SELECT heal_status, heal_failure_type FROM ci_runs WHERE repo_id = $1 AND branch = $2 ORDER BY created_at DESC LIMIT 3",
            [repoRow.github_id, prRow.head_branch]
          );
          if (ciRows.length > 0) {
            const ci = ciRows[0];
            lines.push("CI heal: **" + (ci.heal_status || "unknown") + "**" + (ci.heal_failure_type ? " (" + ci.heal_failure_type + ")" : ""));
          } else {
            lines.push("CI heal: _no CI runs found for this PR_");
          }
        }
      }

      // Stale countdown
      if (ghItem.state === "open") {
        if (daysUntilStale <= 0) {
          lines.push("Stale: \u26a0\ufe0f **Past threshold** — eligible for closure");
        } else if (daysUntilStale <= (settings?.stale_warn_days ?? DEFAULT_WARN_DAYS)) {
          lines.push("Stale: \u23f0 **" + Math.ceil(daysUntilStale) + " days** until closure");
        } else {
          lines.push("Stale: \u2705 " + Math.ceil(daysUntilStale) + " days until stale threshold");
        }
      }

      // Maintainer actions on this item
      const { rows: itemActions } = await db.query(
        "SELECT action_type, status, created_at FROM maintainer_actions WHERE repo_id = $1 AND target_number = $2 ORDER BY created_at DESC LIMIT 3",
        [repoRow.github_id, String(issueNumber)]
      );
      if (itemActions.length > 0) {
        lines.push("Actions: " + itemActions.map(a => a.action_type + " (" + a.status + " " + new Date(a.created_at).toISOString().split("T")[0] + ")").join(", "));
      }

      // Footer with repo-level info
      const stats = await maintainerService.getActionStats(repoRow.github_id);
      lines.push("");
      lines.push("---");
      lines.push("_Repo: maintainer " + ((settings?.enabled ?? true) ? "\u2705 on" : "\u23f8\ufe0f paused") + " | " + (stats?.last_7_days || 0) + " actions (7d) | stale issue " + staleIssueDays + "d / PR " + stalePrDays + "d_");

      responseText = lines.join("\n");
      break;
    }

    case "show_settings": {
      const s = await maintainerService.getSettings(repoRow.github_id);
      responseText = [
        "**GitWire Maintainer Settings**",
        "",
        "Stale issue threshold: **" + (s?.stale_issue_days || 60) + " days**",
        "Stale PR threshold: **" + (s?.stale_pr_days || 30) + " days**",
        "Warning period: **" + (s?.stale_warn_days || 7) + " days**",
        "Branch cleanup: **" + ((s?.cleanup_branches ?? true) ? "on" : "off") + "**",
        "",
        "Change with: `/gitwire settings stale <days>` or `/gitwire settings pr-stale <days>`",
      ].join("\n");
      break;
    }
  }

  // Post response as a comment
  if (responseText) {
    try {
      await octokit.request("POST /repos/{owner}/{repo}/issues/{issue_number}/comments", {
        owner, repo, issue_number: issueNumber, body: responseText,
      });
    } catch (err) {
      logger.error({ err }, "Failed to post command response");
    }
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────────

async function findRepo(fullName) {
  const { rows } = await db.query(
    "SELECT github_id, installation_id FROM repositories WHERE full_name = $1",
    [fullName]
  );
  return rows[0] || null;
}

// ── Scheduled Jobs ────────────────────────────────────────────────────────────

export async function scheduleMaintainerJobs() {
  // Find all installed repos
  const { rows: repos } = await db.query(
    "SELECT r.github_id, r.full_name, r.installation_id FROM repositories r"
  );

  for (const repo of repos) {
    // Stale scan every 6 hours
    await maintainerQueue.add(
      "stale-scan",
      { installationId: repo.installation_id, repoFullName: repo.full_name },
      { repeat: { every: 6 * 60 * 60 * 1000 }, jobId: "stale-scan-" + repo.github_id }
    );

    // Branch cleanup daily
    await maintainerQueue.add(
      "branch-cleanup",
      { installationId: repo.installation_id, repoFullName: repo.full_name },
      { repeat: { every: 24 * 60 * 60 * 1000 }, jobId: "branch-cleanup-" + repo.github_id }
    );
  }

  logger.info("Maintainer jobs scheduled (stale scan every 6h, branch cleanup daily)");
}
