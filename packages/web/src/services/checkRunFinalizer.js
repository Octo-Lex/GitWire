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
 * @param {object} params
 * @param {object} params.octokit
 * @param {string} params.owner
 * @param {string} params.repo
 * @param {number} params.repoId
 * @param {number} params.prNumber
 * @param {string} params.headSha
 * @param {object|null} params.reviewResult - result from reviewPR(), or null if skipped
 * @param {number|null} [params.checkRunId] - explicit check run ID from the job payload
 * @param {string} [params.errorContext] - error message if finalizing on failure path
 */
export async function finalizeGitwireCheck({ octokit, owner, repo, repoId, prNumber, headSha, reviewResult, checkRunId, errorContext }) {
  // Resolve the check run ID: prefer explicit, fall back to Redis
  let resolvedCheckRunId = checkRunId;

  if (!resolvedCheckRunId) {
    const key = checkRunKey(repoId, prNumber, headSha);
    const checkRunIdStr = await redis.get(key);
    if (!checkRunIdStr) return;
    resolvedCheckRunId = parseInt(checkRunIdStr, 10);
    if (!resolvedCheckRunId) return;
  }

  let conclusion, title, summary;
  if (errorContext) {
    // Error-path finalization: show as failure with the error context
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
    // GitHub PATCH failed. Store the intended terminal outcome in a retry
    // key so it can be replayed without rerunning the AI review. Preserve
    // the original Redis pointer (it may be needed for recovery).
    const rKey = retryKey(repoId, prNumber, headSha);
    await redis.setex(rKey, CHECK_TTL, JSON.stringify({
      checkRunId: resolvedCheckRunId,
      conclusion,
      title,
      summary,
    }));
    logger.warn({ checkRunId: resolvedCheckRunId, pr: prNumber, retryKey: rKey }, "GitWire check PATCH failed — terminal outcome stored for retry");
    return;
  }

  // PATCH succeeded. Atomically delete the Redis pointer ONLY if it still
  // matches this checkRunId. A newer invocation's pointer is preserved.
  const key = checkRunKey(repoId, prNumber, headSha);
  try {
    await redis.eval(COMPARE_AND_DELETE_SCRIPT, 1, key, String(resolvedCheckRunId));
  } catch (err) {
    // Lua eval may not be available in all Redis-mock environments.
    // Fall back to non-atomic check-then-delete with a warning.
    logger.warn({ err: err.message, key }, "Redis Lua eval failed for atomic compare-and-delete — using fallback");
    const currentVal = await redis.get(key);
    if (currentVal && parseInt(currentVal, 10) === resolvedCheckRunId) {
      await redis.del(key);
    }
  }

  // Clean up any retry key from a prior failed attempt
  const rKey = retryKey(repoId, prNumber, headSha);
  try { await redis.del(rKey); } catch (_e) { /* non-fatal */ }

  logger.info({ checkRunId: resolvedCheckRunId, conclusion, repo: owner + "/" + repo, pr: prNumber }, "GitWire check finalized");
}
