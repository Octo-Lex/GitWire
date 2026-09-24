// src/services/reviewResultPresentation.js
//
// Maintainer-facing review presentation must not infer a benign skip from the
// legacy `reviewPR()` null sentinel. Some terminal review failures predate the
// structured-result contract and persist an error receipt before returning
// null. Resolve that ambiguity from durable state at the worker boundary so
// the top-level GitWire check reports what actually happened.

import { db } from "../lib/db.js";
import { logger } from "../lib/logger.js";

function timestampMillis(value) {
  if (!value) return null;
  const millis = value instanceof Date ? value.getTime() : Date.parse(String(value));
  return Number.isFinite(millis) ? millis : null;
}

/**
 * ai_reviews is unique per (repo, PR, head), so repeated attempts reuse the
 * same row. The upsert refreshes started_at but intentionally preserves prior
 * terminal/publication state for recovery. A terminal field therefore belongs
 * to the current attempt only when completed_at is at or after that refreshed
 * started_at. Both timestamps are written by PostgreSQL, avoiding app/DB clock
 * comparisons.
 */
function terminalReceiptBelongsToCurrentAttempt(row) {
  const startedAt = timestampMillis(row?.started_at);
  const completedAt = timestampMillis(row?.completed_at);
  return startedAt !== null && completedAt !== null && completedAt >= startedAt;
}

/**
 * Normalize a review service result for maintainer-facing presentation.
 *
 * Non-null results are already explicit and pass through untouched. For a
 * legacy null result, inspect the exact (repo, PR, head) review receipt:
 *   - a current-attempt verdict=error or publication_state=failed -> unavailable
 *   - stale terminal fields from an older same-head attempt -> ignore
 *   - no row / non-error row -> preserve the legitimate null skip contract
 *   - receipt lookup failure -> unavailable, because the worker attempted the
 *     review and can no longer prove that null meant a benign skip
 *
 * @returns {Promise<object|null>}
 */
export async function normalizeReviewResultForPresentation({ reviewResult, repoId, prNumber, headSha }) {
  if (reviewResult !== null && reviewResult !== undefined) return reviewResult;

  try {
    const { rows } = await db.query(
      "SELECT verdict, summary, terminal_reason, publication_state, started_at, completed_at " +
      "FROM ai_reviews " +
      "WHERE repo_id = $1 AND pr_number = $2 AND commit_sha = $3 " +
      "ORDER BY id DESC LIMIT 1",
      [repoId, prNumber, headSha]
    );
    const row = rows[0];
    if (!row) return null;

    const unavailable = terminalReceiptBelongsToCurrentAttempt(row) &&
      (row.verdict === "error" || row.publication_state === "failed");
    if (!unavailable) return null;

    const reason = row.terminal_reason || (row.publication_state === "failed" ? "publication_failed" : "review_error");
    return {
      unavailable: true,
      verdict: "error",
      blocked: false,
      findings: [],
      reason,
      error: row.summary || reason || "AI review could not be completed.",
    };
  } catch (err) {
    logger.warn(
      { err: err.message, repoId, prNumber, headSha },
      "AI review presentation receipt lookup failed — reporting unavailable"
    );
    return {
      unavailable: true,
      verdict: "error",
      blocked: false,
      findings: [],
      reason: "outcome_lookup_failed",
      error: "AI review outcome could not be verified from durable review state.",
    };
  }
}
