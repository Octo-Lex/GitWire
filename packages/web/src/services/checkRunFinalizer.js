// src/services/checkRunFinalizer.js
// Finalizes the top-level "GitWire" check run created in the webhook route.
//
// The webhook route creates a "GitWire" check run (queued) for every PR.
// This module retrieves the check run ID from Redis and finalizes it
// with the appropriate conclusion based on the pipeline result.
//
// Called by phase4Worker on every exit path (skip, pass, fail).

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
 * Reads the check run ID from Redis, updates to completed with appropriate conclusion.
 *
 * @param {object} params
 * @param {object} params.octokit
 * @param {string} params.owner
 * @param {string} params.repo
 * @param {number} params.repoId
 * @param {number} params.prNumber
 * @param {string} params.headSha
 * @param {object|null} params.reviewResult - result from reviewPR(), or null if skipped
 */
export async function finalizeGitwireCheck({ octokit, owner, repo, repoId, prNumber, headSha, reviewResult }) {
  const key = checkRunKey(repoId, prNumber, headSha);
  logger.info({ key, repo: owner + "/" + repo, pr: prNumber }, "finalizeGitwireCheck: starting");
  const checkRunIdStr = await redis.get(key);
  logger.info({ key, checkRunIdStr }, "finalizeGitwireCheck: redis get result");
  if (!checkRunIdStr) return; // No check run was created (may lack checks:write permission)
  const checkRunId = parseInt(checkRunIdStr, 10);
  if (!checkRunId) return;

  let conclusion, title, summary;
  if (!reviewResult) {
    // Review was skipped (no config, bot author, no files, dry-run, waiver, trigger filter)
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

  logger.info({ checkRunId, conclusion, title, repo: owner + "/" + repo, pr: prNumber }, "finalizeGitwireCheck: calling updateGitwireCheck");
  await updateGitwireCheck({ octokit, owner, repo, checkRunId, conclusion, title, summary });
  logger.info({ checkRunId, conclusion, repo: owner + "/" + repo, pr: prNumber }, "finalizeGitwireCheck: updateGitwireCheck returned");
  await redis.del(key);
  logger.info({ key, checkRunId }, "finalizeGitwireCheck: Redis key deleted");
  logger.debug({ checkRunId, conclusion, repo: owner + "/" + repo, pr: prNumber }, "GitWire check finalized");
}
