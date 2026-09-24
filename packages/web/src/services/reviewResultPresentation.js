// src/services/reviewResultPresentation.js
//
// Maintainer-facing review presentation must not infer a benign skip from the
// legacy `reviewPR()` null sentinel. Some terminal review failures predate the
// structured-result contract and persist an error receipt before returning
// null. Resolve that ambiguity from durable state at the worker boundary so
// the top-level GitWire check reports what actually happened.

import { db } from "../lib/db.js";
import { logger } from "../lib/logger.js";

/**
 * Normalize a review service result for maintainer-facing presentation.
 *
 * Non-null results are already explicit and pass through untouched. For a
 * legacy null result, inspect the exact (repo, PR, head) review receipt:
 *   - verdict=error or publication_state=failed -> structured unavailable
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
      "SELECT verdict, summary, terminal_reason, publication_state " +
      "FROM ai_reviews " +
      "WHERE repo_id = $1 AND pr_number = $2 AND commit_sha = $3 " +
      "ORDER BY id DESC LIMIT 1",
      [repoId, prNumber, headSha]
    );
    const row = rows[0];
    if (!row) return null;

    const unavailable = row.verdict === "error" || row.publication_state === "failed";
    if (!unavailable) return null;

    return {
      unavailable: true,
      verdict: "error",
      blocked: false,
      findings: [],
      reason: row.terminal_reason || (row.publication_state === "failed" ? "publication_failed" : "review_error"),
      error: row.summary || "AI review could not be completed.",
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
