// src/services/checkRunFinalizer.js
// Finalizes the top-level "GitWire" check run created in the webhook route.
//
// The webhook route creates a "GitWire" check run (queued) for every PR
// on open/reopen/ready_for_review events and passes the checkRunId through
// the job payload. This module finalizes it with the appropriate conclusion
// based on the pipeline result.
//
// When an explicit checkRunId is provided (the normal automatic path), it
// is used directly. Redis lookup is a compatibility fallback for callers
// that do not carry a checkRunId (e.g. manual /gitwire run review).
//
// The Redis pointer is only deleted after a successful GitHub PATCH, using
// an atomic compare-and-delete Lua script that prevents a race where an
// older job deletes a newer job's pointer.

import { redis } from "../lib/queue.js";
import { updateGitwireCheck } from "../lib/checkStatus.js";
import { logger } from "../lib/logger.js";

const CHECK_KEY_PREFIX = "gitwire:check:";
const CHECK_TTL = 86400; // 24 hours
const RETRY_KEY_PREFIX = "gitwire:check:retry:";

// Atomic compare-and-delete: only deletes the key if its value matches the
// expected checkRunId. Returns 1 if deleted, 0 if not (race lost or key gone).
const COMPARE_AND_DELETE_SCRIPT = `
  local current = redis.call('GET', KEYS[1])
  if current == ARGV[1] then
    return redis.call('DEL', KEYS[1])
  end
  return 0
`;

/**
 * Build the Redis key for a check run ID.
 */
export function checkRunKey(repoId, prNumber, headSha) {
  return CHECK_KEY_PREFIX + repoId + ":" + prNumber + ":" + headSha;
}

/**
 * Build the Redis key for storing the intended terminal outcome when
 * a GitHub PATCH fails. Keyed by checkRunId so concurrent checks for
 * the same PR+SHA do not collide.
 */
function retryKey(repoId, prNumber, headSha, checkRunId) {
  return RETRY_KEY_PREFIX + repoId + ":" + prNumber + ":" + headSha + ":" + checkRunId;
}

/**
 * Read and return a stored retry outcome for a specific check run, or null.
 * Used by the worker on BullMQ retry to replay the intended terminal outcome
 * without rerunning the AI review.
 */
export async function getRetryOutcome(repoId, prNumber, headSha, checkRunId) {
  const rKey = retryKey(repoId, prNumber, headSha, checkRunId);
  const raw = await redis.get(rKey);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

/**
 * Clear a stored retry outcome after successful replay.
 */
export async function clearRetryOutcome(repoId, prNumber, headSha, checkRunId) {
  const rKey = retryKey(repoId, prNumber, headSha, checkRunId);
  try { await redis.del(rKey); } catch (_e) { /* non-fatal */ }
}

/**
 * Finalize the top-level "GitWire" check run.
 *
 * @returns {Promise<boolean>} true if PATCH succeeded (or no-op), false if PATCH failed
 */
export async function finalizeGitwireCheck({ octokit, owner, repo, repoId, prNumber, headSha, reviewResult, checkRunId, errorContext }) {
  let resolvedCheckRunId = checkRunId;

  if (!resolvedCheckRunId) {
    const key = checkRunKey(repoId, prNumber, headSha);
    const checkRunIdStr = await redis.get(key);
    if (!checkRunIdStr) return true;
    resolvedCheckRunId = parseInt(checkRunIdStr, 10);
    if (!resolvedCheckRunId) return true;
  }

  let conclusion, title, summary;
  if (errorContext) {
    conclusion = "failure";
    title = "GitWire \u2014 review error";
    summary = "AI review encountered an error: " + errorContext;
  } else if (reviewResult && reviewResult.skipped && reviewResult.reason === "not_activated") {
    // Structured skip: .gitwire.yml has ai_review enabled but the DB-level
    // ai_review_config row is missing or disabled. Give the maintainer an
    // actionable activation path instead of the generic "not configured" text.
    conclusion = "neutral";
    title = "GitWire \u2014 AI review not activated";
    summary = "AI Review is enabled by repository policy but has not been activated in GitWire. "
            + "Activate it in the [GitWire Intelligence dashboard](" + (reviewResult.activationUrl || "")
            + ") to start receiving AI code reviews.";
  } else if (!reviewResult) {
    conclusion = "neutral";
    title = "GitWire \u2014 no review needed";
    summary = "AI review is not configured for this repository, or the PR was skipped.";
  } else if (reviewResult && reviewResult.superseded) {
    conclusion = "neutral";
    title = "GitWire \u2014 review superseded";
    summary = "The PR head changed while the AI review was running (reviewed " +
      (reviewResult.reviewedHeadSha || "?").slice(0, 12) + " \u2192 current " +
      (reviewResult.currentHeadSha || "?").slice(0, 12) +
      "). No review was published for the old head.";
  } else if (reviewResult.blocked) {
    conclusion = "failure";
    title = "GitWire \u2014 review blocked merge";
    summary = "AI review found " + reviewResult.findings.length + " finding(s). Verdict: " + reviewResult.verdict + ".";
  } else {
    conclusion = "success";
    title = "GitWire \u2014 review passed";
    summary = "AI review completed. Verdict: " + reviewResult.verdict + ", " + reviewResult.findings.length + " finding(s).";
  }

  return _applyCheckConclusion({ octokit, owner, repo, repoId, prNumber, headSha, checkRunId: resolvedCheckRunId, conclusion, title, summary });
}

/**
 * Replay a stored terminal outcome verbatim. Used by the worker on BullMQ retry
 * when a prior attempt's PATCH failed but the review already completed.
 *
 * @returns {Promise<boolean>} true if PATCH succeeded, false if it failed again
 */
export async function replayCheckConclusion({ octokit, owner, repo, repoId, prNumber, headSha, checkRunId, conclusion, title, summary }) {
  return _applyCheckConclusion({ octokit, owner, repo, repoId, prNumber, headSha, checkRunId, conclusion, title, summary });
}

/**
 * Shared low-level check finalization: PATCH GitHub, store retry state on failure,
 * atomic compare-and-delete pointer on success.
 *
 * @returns {Promise<boolean>} true if PATCH succeeded, false if it failed
 */
async function _applyCheckConclusion({ octokit, owner, repo, repoId, prNumber, headSha, checkRunId, conclusion, title, summary }) {
  const patched = await updateGitwireCheck({ octokit, owner, repo, checkRunId, conclusion, title, summary });

  if (!patched) {
    // GitHub PATCH failed. Store the exact intended terminal outcome keyed
    // by checkRunId so a BullMQ retry can replay it verbatim.
    const rKey = retryKey(repoId, prNumber, headSha, checkRunId);
    await redis.setex(rKey, CHECK_TTL, JSON.stringify({ checkRunId, conclusion, title, summary }));
    logger.warn({ checkRunId, pr: prNumber, retryKey: rKey }, "GitWire check PATCH failed — terminal outcome stored for retry");
    return false;
  }

  // PATCH succeeded. Atomically delete the Redis pointer ONLY if it still
  // matches this checkRunId. If the Lua eval itself fails, log and preserve
  // the pointer — do NOT fall back to non-atomic GET→DEL.
  const key = checkRunKey(repoId, prNumber, headSha);
  try {
    await redis.eval(COMPARE_AND_DELETE_SCRIPT, 1, key, String(checkRunId));
  } catch (err) {
    logger.warn({ err: err.message, key }, "Redis Lua eval failed for atomic compare-and-delete — pointer preserved");
  }

  // Clean up any retry key for this specific checkRunId
  const rKey = retryKey(repoId, prNumber, headSha, checkRunId);
  try { await redis.del(rKey); } catch (_e) { /* non-fatal */ }

  logger.info({ checkRunId, conclusion, repo: owner + "/" + repo, pr: prNumber }, "GitWire check finalized");
  return true;
}
