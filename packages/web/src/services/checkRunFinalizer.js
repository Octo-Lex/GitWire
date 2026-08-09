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
// The Redis pointer is only deleted after a successful GitHub PATCH, and
// only if the stored value still matches the checkRunId being finalized.

import { redis } from "../lib/queue.js";
import { updateGitwireCheck } from "../lib/checkStatus.js";
import { logger } from "../lib/logger.js";

const CHECK_KEY_PREFIX = "gitwire:check:";
const CHECK_TTL = 86400; // 24 hours

/**
 * Build the Redis key for a check run ID.
 */
export function checkRunKey(repoId, prNumber, headSha) {
  return CHECK_KEY_PREFIX + repoId + ":" + prNumber + ":" + headSha;
}

/**
 * Finalize the top-level "GitWire" check run.
 *
 * Prefers an explicit checkRunId from the job payload. Falls back to Redis
 * lookup for callers without one (compatibility). After a successful GitHub
 * PATCH, deletes the Redis pointer only if it still refers to this same ID.
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
 */
export async function finalizeGitwireCheck({ octokit, owner, repo, repoId, prNumber, headSha, reviewResult, checkRunId }) {
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
  if (!reviewResult) {
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
    // GitHub PATCH failed — do NOT delete the Redis pointer. The check
    // remains observable and the pointer remains for retry/recovery.
    logger.warn({ checkRunId: resolvedCheckRunId, pr: prNumber }, "GitWire check finalization failed — Redis pointer preserved for retry");
    return;
  }

  // Only clean the Redis pointer if it still refers to THIS checkRunId.
  // A newer invocation may have overwritten it with a different ID.
  const key = checkRunKey(repoId, prNumber, headSha);
  const currentVal = await redis.get(key);
  if (currentVal && parseInt(currentVal, 10) === resolvedCheckRunId) {
    await redis.del(key);
  }

  logger.info({ checkRunId: resolvedCheckRunId, conclusion, repo: owner + "/" + repo, pr: prNumber }, "GitWire check finalized");
}
