// src/workers/maintainer/commands.js
// Command handlers for the maintainer comment-command system.
// Each command is a self-contained async function that returns response text
// (or null if no comment should be posted).

import { maintainerQueue } from "../../lib/queue.js";
import { maintainerService } from "../../services/maintainerService.js";
import { wrapOctokit } from "../../lib/githubWrapper.js";
import { getInstallationClient } from "../../lib/github.js";
import { db } from "../../lib/db.js";
import { logger } from "../../lib/logger.js";

const DEFAULT_STALE_ISSUE_DAYS = 60;
const DEFAULT_STALE_PR_DAYS = 30;
const DEFAULT_WARN_DAYS = 7;

// ── Command Registry ──────────────────────────────────────────────────────

const COMMANDS = {
  stale_scan:           cmdStaleScan,
  branch_cleanup:      cmdBranchCleanup,
  set_stale_issue_days: cmdSetStaleIssueDays,
  set_stale_pr_days:    cmdSetStalePrDays,
  stop:                 cmdStop,
  status:               cmdStatus,
  show_settings:        cmdShowSettings,
};

/**
 * Thin dispatcher — looks up the command handler and returns response text.
 * CC target: ~3
 */
export async function dispatchCommand(data) {
  const handler = COMMANDS[data.action];
  if (!handler) return null;
  return handler(data);
}

// ── Simple Commands ───────────────────────────────────────────────────────

async function cmdStaleScan({ installationId, repoFullName }) {
  await maintainerQueue.add("stale-scan", { installationId, repoFullName });
  return "\u2705 **GitWire:** Stale scan triggered for this repo. Results will appear as comments on stale items.";
}

async function cmdBranchCleanup({ installationId, repoFullName }) {
  await maintainerQueue.add("branch-cleanup", { installationId, repoFullName });
  return "\u2705 **GitWire:** Branch cleanup triggered for this repo.";
}

async function cmdSetStaleIssueDays(data) {
  const repoRow = await findRepo(data.repoFullName);
  if (!repoRow) return null;
  await maintainerService.upsertSettings(repoRow.github_id, { stale_issue_days: data.value });
  return "\u2705 **GitWire:** Stale issue threshold set to **" + data.value + " days**.";
}

async function cmdSetStalePrDays(data) {
  const repoRow = await findRepo(data.repoFullName);
  if (!repoRow) return null;
  await maintainerService.upsertSettings(repoRow.github_id, { stale_pr_days: data.value });
  return "\u2705 **GitWire:** Stale PR threshold set to **" + data.value + " days**.";
}

async function cmdStop(data) {
  const repoRow = await findRepo(data.repoFullName);
  if (!repoRow) return null;
  await maintainerService.upsertSettings(repoRow.github_id, { enabled: false });
  return "\u23f8\ufe0f **GitWire:** Maintainer automation paused for this repo.";
}

async function cmdShowSettings({ repoFullName }) {
  const repoRow = await findRepo(repoFullName);
  if (!repoRow) return null;
  const s = await maintainerService.getSettings(repoRow.github_id);
  return [
    "**GitWire Maintainer Settings**",
    "",
    "Stale issue threshold: **" + (s?.stale_issue_days || 60) + " days**",
    "Stale PR threshold: **" + (s?.stale_pr_days || 30) + " days**",
    "Warning period: **" + (s?.stale_warn_days || 7) + " days**",
    "Branch cleanup: **" + ((s?.cleanup_branches ?? true) ? "on" : "off") + "**",
    "",
    "Change with: `/gitwire settings stale <days>` or `/gitwire settings pr-stale <days>`",
  ].join("\n");
}

// ── Status Command (the complex one) ──────────────────────────────────────

async function cmdStatus({ installationId, repoFullName, issueNumber }) {
  const repoRow = await findRepo(repoFullName);
  if (!repoRow) return null;

  const octokit = wrapOctokit(await getInstallationClient(installationId));
  const [owner, repo] = repoFullName.split("/");

  // Fetch GitHub item
  const { data: ghItem } = await octokit.request("GET /repos/{owner}/{repo}/issues/{issue_number}", {
    owner, repo, issue_number: issueNumber,
  });

  const isPR = !!ghItem.pull_request;
  const daysSinceUpdate = ((Date.now() - new Date(ghItem.updated_at).getTime()) / (1000 * 60 * 60 * 24)).toFixed(1);
  const settings = await maintainerService.getSettings(repoRow.github_id);

  // Build context
  const lines = [];
  lines.push("**GitWire Status for #" + issueNumber + "**");
  lines.push("");
  lines.push("Type: **" + (isPR ? "Pull Request" : "Issue") + "** | State: **" + ghItem.state + "** | Updated **" + daysSinceUpdate + "d ago**");

  // Triage info
  appendTriageInfo(lines, repoRow.github_id, issueNumber, isPR);

  // Labels
  const labelNames = (ghItem.labels || []).map(l => l.name).filter(Boolean);
  if (labelNames.length > 0) {
    lines.push("Labels: " + labelNames.map(l => "`" + l + "`").join(", "));
  }

  // CI info (PRs only)
  if (isPR) {
    await appendCIInfo(lines, repoRow.github_id, issueNumber);
  }

  // Stale countdown
  appendStaleCountdown(lines, ghItem.state, parseFloat(daysSinceUpdate), settings, isPR);

  // Action history
  await appendActionHistory(lines, repoRow.github_id, issueNumber);

  // Footer
  const stats = await maintainerService.getActionStats(repoRow.github_id);
  const staleIssueDays = settings?.stale_issue_days ?? DEFAULT_STALE_ISSUE_DAYS;
  const stalePrDays = settings?.stale_pr_days ?? DEFAULT_STALE_PR_DAYS;
  lines.push("");
  lines.push("---");
  lines.push("_Repo: maintainer " + ((settings?.enabled ?? true) ? "\u2705 on" : "\u23f8\ufe0f paused") + " | " + (stats?.last_7_days || 0) + " actions (7d) | stale issue " + staleIssueDays + "d / PR " + stalePrDays + "d_");

  return lines.join("\n");
}

// ── Status Sub-functions ──────────────────────────────────────────────────

async function appendTriageInfo(lines, repoId, issueNumber, isPR) {
  const { rows: issueRows } = await db.query(
    "SELECT triage_type, triage_priority, triage_summary FROM issues WHERE repo_id = $1 AND number = $2",
    [repoId, issueNumber]
  );
  const { rows: prRows } = await db.query(
    "SELECT triage_type, triage_size, triage_risk, triage_summary, head_branch FROM pull_requests WHERE repo_id = $1 AND number = $2",
    [repoId, issueNumber]
  );
  const triageRow = issueRows[0] || prRows[0];
  if (triageRow && triageRow.triage_type) {
    const t = triageRow;
    const priorityLabel = isPR ? (t.triage_size || t.triage_risk) : t.triage_priority;
    lines.push("Triage: **" + t.triage_type + "** (" + (priorityLabel || "unknown") + ") — " + (t.triage_summary || "no summary"));
  } else {
    lines.push("Triage: _not yet classified_");
  }
}

async function appendCIInfo(lines, repoId, issueNumber) {
  const { rows: prRows } = await db.query(
    "SELECT head_branch FROM pull_requests WHERE repo_id = $1 AND number = $2",
    [repoId, issueNumber]
  );
  const prRow = prRows[0];
  if (!prRow) return;

  const { rows: ciRows } = await db.query(
    "SELECT heal_status, heal_failure_type FROM ci_runs WHERE repo_id = $1 AND branch = $2 ORDER BY created_at DESC LIMIT 3",
    [repoId, prRow.head_branch]
  );
  if (ciRows.length > 0) {
    const ci = ciRows[0];
    lines.push("CI heal: **" + (ci.heal_status || "unknown") + "**" + (ci.heal_failure_type ? " (" + ci.heal_failure_type + ")" : ""));
  } else {
    lines.push("CI heal: _no CI runs found for this PR_");
  }
}

function appendStaleCountdown(lines, state, daysSinceUpdate, settings, isPR) {
  if (state !== "open") return;

  const staleIssueDays = settings?.stale_issue_days ?? DEFAULT_STALE_ISSUE_DAYS;
  const stalePrDays = settings?.stale_pr_days ?? DEFAULT_STALE_PR_DAYS;
  const staleThreshold = isPR ? stalePrDays : staleIssueDays;
  const daysUntilStale = Math.max(0, staleThreshold - daysSinceUpdate);

  if (daysUntilStale <= 0) {
    lines.push("Stale: \u26a0\ufe0f **Past threshold** — eligible for closure");
  } else if (daysUntilStale <= (settings?.stale_warn_days ?? DEFAULT_WARN_DAYS)) {
    lines.push("Stale: \u23f0 **" + Math.ceil(daysUntilStale) + " days** until closure");
  } else {
    lines.push("Stale: \u2705 " + Math.ceil(daysUntilStale) + " days until stale threshold");
  }
}

async function appendActionHistory(lines, repoId, issueNumber) {
  const { rows: itemActions } = await db.query(
    "SELECT action_type, status, created_at FROM maintainer_actions WHERE repo_id = $1 AND target_number = $2 ORDER BY created_at DESC LIMIT 3",
    [repoId, String(issueNumber)]
  );
  if (itemActions.length > 0) {
    lines.push("Actions: " + itemActions.map(a => a.action_type + " (" + a.status + " " + new Date(a.created_at).toISOString().split("T")[0] + ")").join(", "));
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

async function findRepo(fullName) {
  const { rows } = await db.query(
    "SELECT github_id, installation_id FROM repositories WHERE full_name = $1",
    [fullName]
  );
  return rows[0] || null;
}
