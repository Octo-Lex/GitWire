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
 * a GitHub PATCH fails, so it can be retried without rerunning the review.
 */
function retryKey(repoId, prNumber, headSha) {
  return RETRY_KEY_PREFIX + repoId + ":" + prNumber + ":" + headSha;
}

/**
 * Read and return a stored retry outcome for a check, or null if none exists.
 * Used by the worker on BullMQ retry to replay the intended terminal outcome
 * without rerunning the AI review.
 */
export async function getRetryOutcome(repoId, prNumber, headSha) {
  const rKey = retryKey(repoId, prNumber, headSha);
  const raw = await redis.get(rKey);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

/**
 * Clear a stored retry outcome after successful replay.
 */
export async function clearRetryOutcome(repoId, prNumber, headSha) {
  const rKey = retryKey(repoId, prNumber, headSha);
  try { await redis.del(rKey); } catch (_e) { /* non-fatal */ }
}

/**
 * Finalize the top-level "GitWire" check run.
 *
 * Prefers an explicit checkRunId from the job payload. Falls back to Redis
 * lookup for callers without one (compatibility). After a successful GitHub
 * PATCH, deletes the Redis pointer atomically (compare-and-delete) so a
 * newer job's pointer is never destroyed.
 *
 * When the GitHub PATCH fails, stores the intended terminal outcome in a
 * retry key so it can be replayed without rerunning the AI review.
 *
 * @returns {Promise<boolean>} true if the GitHub PATCH succeeded, false if it failed
 */
export async function finalizeGitwireCheck({ octokit, owner, repo, repoId, prNumber, headSha, reviewResult, checkRunId, errorContext }) {
  // Resolve the check run ID: prefer explicit, fall back to Redis
  let resolvedCheckRunId = checkRunId;

  if (!resolvedCheckRunId) {
    const key = checkRunKey(repoId, prNumber, headSha);
    const checkRunIdStr = await redis.get(key);
    if (!checkRunIdStr) return true; // nothing to finalize — treat as no-op success
    resolvedCheckRunId = parseInt(checkRunIdStr, 10);
    if (!resolvedCheckRunId) return true;
  }

  let conclusion, title, summary;
  if (errorContext) {
    conclusion = "failure";
    title = "GitWire \u2014 review error";
    summary = "AI review encountered an error: " + errorContext;
  } else if (!reviewResult) {
    conclusion = "neutral";
    title = "GitWire \u2014 no review needed";
    summary = "AI review is not configured for this repository, or the PR was skipped.";
  } else if (reviewResult.blocked) {
    conclusion = "failure";
    title = "GitWire \u2014 review blocked merge";
    summary = "AI review found " + reviewResult.findings.length + " finding(s). Verdict: " + reviewResult.verdict + ".";
  } else {
    conclusion = "success";
    title = "GitWire \u2014 review passed";
    summary = "AI review completed. Verdict: " + reviewResult.verdict + ", " + reviewResult.findings.length + " finding(s).";
  }

  const patched = await updateGitwireCheck({ octokit, owner, repo, checkRunId: resolvedCheckRunId, conclusion, title, summary });

  if (!patched) {
    // GitHub PATCH failed. Store the intended terminal outcome so a BullMQ
    // retry can replay it without rerunning the AI review.
    const rKey = retryKey(repoId, prNumber, headSha);
    await redis.setex(rKey, CHECK_TTL, JSON.stringify({
      checkRunId: resolvedCheckRunId,
      conclusion,
      title,
      summary,
    }));
    logger.warn({ checkRunId: resolvedCheckRunId, pr: prNumber, retryKey: rKey }, "GitWire check PATCH failed — terminal outcome stored for retry");
    return false;
  }

  // PATCH succeeded. Atomically delete the Redis pointer ONLY if it still
  // matches this checkRunId. A newer invocation's pointer is preserved.
  // If the Lua eval itself fails, log and preserve the pointer — do NOT
  // fall back to non-atomic GET→DEL, which reintroduces the TOCTOU race.
  const key = checkRunKey(repoId, prNumber, headSha);
  try {
    await redis.eval(COMPARE_AND_DELETE_SCRIPT, 1, key, String(resolvedCheckRunId));
  } catch (err) {
    logger.warn({ err: err.message, key }, "Redis Lua eval failed for atomic compare-and-delete — pointer preserved");
  }

  // Clean up any retry key from a prior failed attempt
  const rKey = retryKey(repoId, prNumber, headSha);
  try { await redis.del(rKey); } catch (_e) { /* non-fatal */ }

  logger.info({ checkRunId: resolvedCheckRunId, conclusion, repo: owner + "/" + repo, pr: prNumber }, "GitWire check finalized");
  return true;
}
