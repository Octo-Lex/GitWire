// src/lib/checkStatus.js
// Creates and updates GitHub Check Runs to show GitWire's evaluation
// status on every PR. This makes GitWire's footprint visible in the
// GitHub PR UI checks panel.
//
// Check states:
//   queued     — GitWire is evaluating this PR
//   completed  — Evaluation done (conclusion: success, neutral, failure)
//
// Usage:
//   const checkRunId = await createGitwireCheck({ octokit, owner, repo, headSha, status: "queued" });
//   await updateGitwireCheck({ octokit, owner, repo, checkRunId, conclusion: "success", ... });

import { logger } from "./logger.js";

const CHECK_NAME = "GitWire";
const CHECK_DETAILS_BASE = "https://gitwire.erlab.uk/activity";

/**
 * Create a new GitWire check run on a commit.
 * Returns the check run ID for later updates.
 *
 * @param {object} params
 * @param {object} params.octokit - Authenticated Octokit instance
 * @param {string} params.owner - Repository owner
 * @param {string} params.repo - Repository name
 * @param {string} params.headSha - Commit SHA to attach the check to
 * @param {string} [params.status="queued"] - "queued" | "in_progress" | "completed"
 * @param {string} [params.title] - Check title (for output)
 * @param {string} [params.summary] - Markdown summary for details
 * @returns {Promise<number|null>} check run ID
 */
export async function createGitwireCheck({ octokit, owner, repo, headSha, status, title, summary }) {
  try {
    const { data } = await octokit.request("POST /repos/{owner}/{repo}/check-runs", {
      owner,
      repo,
      name: CHECK_NAME,
      head_sha: headSha,
      status: status || "queued",
      ...(title ? {
        output: {
          title: title,
          summary: summary || "GitWire is evaluating this commit.",
        },
      } : {}),
    });

    logger.debug({ owner, repo, headSha, checkRunId: data.id, status }, "GitWire check created");
    return data.id;
  } catch (err) {
    // Check runs require `checks: write` permission — may not be available
    logger.warn({ err: err.message, owner, repo }, "Failed to create GitWire check (non-fatal, may need checks:write permission)");
    return null;
  }
}

/**
 * Update an existing GitWire check run.
 *
 * @param {object} params
 * @param {object} params.octokit
 * @param {string} params.owner
 * @param {string} params.repo
 * @param {number} params.checkRunId - From createGitwireCheck()
 * @param {string} [params.status="completed"]
 * @param {string} [params.conclusion] - "success" | "failure" | "neutral" | "cancelled" | "timed_out"
 * @param {string} [params.title] - Output title
 * @param {string} [params.summary] - Markdown summary
 * @param {Array}  [params.actions] - GitHub check actions (buttons)
 */
export async function updateGitwireCheck({ octokit, owner, repo, checkRunId, status, conclusion, title, summary, actions }) {
  if (!checkRunId) return;

  try {
    await octokit.request("PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}", {
      owner,
      repo,
      check_run_id: checkRunId,
      status: status || "completed",
      ...(conclusion ? { conclusion } : {}),
      ...(title ? {
        output: {
          title: title,
          summary: summary || "",
        },
      } : {}),
      ...(actions ? { actions } : {}),
    });

    logger.debug({ owner, repo, checkRunId, conclusion }, "GitWire check updated");
  } catch (err) {
    logger.warn({ err: err.message, checkRunId }, "Failed to update GitWire check (non-fatal)");
  }
}

/**
 * Build a markdown summary for the check run from worker results.
 *
 * @param {object} results
 * @param {Array} [results.actions] - Managed actions taken
 * @param {string} [results.decision] - 'acted', 'skipped', 'dry_run', 'blocked'
 * @param {string} [results.reason] - Human-readable reason
 * @param {boolean} [results.isDryRun] - Whether dry run mode was active
 * @param {string} [results.repoFullName] - For linking to dashboard
 * @returns {string} markdown summary
 */
export function buildCheckSummary({ actions, decision, reason, isDryRun, repoFullName }) {
  const lines = [];

  if (isDryRun) {
    lines.push("**⚠️ Dry Run Mode** — no actions were applied to GitHub");
    lines.push("");
  }

  if (reason) {
    lines.push(reason);
    lines.push("");
  }

  if (actions && actions.length > 0) {
    lines.push("| Action | Type | Detail |");
    lines.push("|--------|------|--------|");
    for (const a of actions) {
      lines.push("| " + a.actionKey + " | " + a.actionType + " | " + (a.actionValue || "—") + " |");
    }
    lines.push("");
  }

  if (decision === "skipped") {
    lines.push("_No applicable rules for this event._");
  } else if (decision === "acted" && !isDryRun) {
    lines.push("_" + (actions ? actions.length : 0) + " action(s) applied by GitWire._");
  }

  if (repoFullName) {
    lines.push("");
    lines.push("[View in GitWire Dashboard](" + CHECK_DETAILS_BASE + "?repo=" + encodeURIComponent(repoFullName) + ")");
  }

  return lines.join("\n");
}

/**
 * Determine conclusion from decision and actions.
 *
 * @param {string} decision - 'acted', 'skipped', 'dry_run', 'blocked', 'error'
 * @returns {string} GitHub check conclusion
 */
export function conclusionFromDecision(decision) {
  switch (decision) {
    case "acted": return "success";
    case "skipped": return "neutral";
    case "dry_run": return "neutral";
    case "blocked": return "failure";
    case "error": return "failure";
    default: return "neutral";
  }
}
