// src/workers/maintainerWorker.js
// Scheduled maintainer: stale issue/PR management, merged branch cleanup.
//
// Runs every 6 hours via BullMQ repeatable job.
// Pattern: scan repos → find stale items → warn → close → cleanup branches.
// All mutations check idempotency key before acting.

import { createWorker, QUEUES, maintainerQueue } from "../lib/queue.js";
import { getInstallationClient } from "../lib/github.js";
import { wrapOctokit } from "../lib/githubWrapper.js";
import { maintainerService } from "../services/maintainerService.js";
import { getConfigForRepo } from "../services/configService.js";
import { isPillarEnabled, getStaleConfig, isStaleExempt, isDryRun } from "@gitwire/rules";
import { db } from "../lib/db.js";
import { logger } from "../lib/logger.js";
import { dispatchCommand } from "./maintainer/commands.js";

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

  const octokit = wrapOctokit(await getInstallationClient(installationId));
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

        await closeStaleItem(octokit, owner, repo, type, number, staleDays, repoId, closeKey, repoConfig);
        processed++;
      } else if (daysSinceUpdate >= staleDays - warnDays) {
        // Warn about upcoming closure
        const warnKey = idempotencyBase + ":warn";
        if (await maintainerService.actionExists(warnKey)) continue;

        await warnStaleItem(octokit, owner, repo, type, number, staleDays, daysSinceUpdate, repoId, warnKey, repoConfig);
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

async function warnStaleItem(octokit, owner, repo, type, number, staleDays, daysIdle, repoId, idempotencyKey, repoConfig) {
  if (isDryRun(repoConfig)) {
    logger.info({ type, number, daysIdle: Math.floor(daysIdle), repo: owner + "/" + repo }, "DRY RUN: would warn stale item");
    await maintainerService.recordAction(repoId, {
      actionType: "stale_warn", targetType: type, targetNumber: String(number),
      idempotencyKey, status: "skipped", result: "Dry run: would warn",
    });
    return;
  }
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

async function closeStaleItem(octokit, owner, repo, type, number, staleDays, repoId, idempotencyKey, repoConfig) {
  if (isDryRun(repoConfig)) {
    logger.info({ type, number, staleDays, repo: owner + "/" + repo }, "DRY RUN: would close stale item");
    await maintainerService.recordAction(repoId, {
      actionType: "stale_close", targetType: type, targetNumber: String(number),
      idempotencyKey, status: "skipped", result: "Dry run: would close",
    });
    return;
  }

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

  const octokit = wrapOctokit(await getInstallationClient(installationId));
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
      if (isDryRun(repoConfig)) {
        logger.info({ branch: branch.name, repo: repoFullName }, "DRY RUN: would delete branch");
        await maintainerService.recordAction(repoRow.github_id, {
          actionType: "branch_cleanup", targetType: "branch", targetNumber: branch.name,
          idempotencyKey, status: "skipped", result: "Dry run: would delete",
        });
        continue;
      }
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
  const { installationId, repoFullName, issueNumber } = data;
  logger.info({ action: data.action, repo: repoFullName, author: data.authorLogin }, "Processing comment command");

  const responseText = await dispatchCommand(data);

  // Post response as a comment
  if (responseText) {
    try {
      const octokit = wrapOctokit(await getInstallationClient(installationId));
      const [owner, repo] = repoFullName.split("/");
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
