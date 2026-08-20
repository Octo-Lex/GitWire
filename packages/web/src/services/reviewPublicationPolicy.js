// src/services/reviewPublicationPolicy.js
// Pure publication policy for the Advisory AI Review contract (v1.2).
//
// Separates three planes the legacy review path conflated:
//   1. Review judgment   — GitWire-normalized derivation from the model report
//                          (APPROVE | NEEDS_DISCUSSION | REQUEST_CHANGES)
//   2. Integrity state   — deterministic evidence/coverage state owned by
//                          GitWire (COMPLETE | INCOMPLETE | SUPERSEDED | FAILED)
//   3. Authority state   — what repository consequence the judgment may have
//                          (ADVISORY | POLICY_BLOCKED | ACTION_AUTHORIZED)
//
// In advisory mode (the pilot default) every published review uses the GitHub
// COMMENT event: the model never acquires GitHub APPROVE / REQUEST_CHANGES
// authority. A blocking consequence (POLICY_BLOCKED) requires explicit
// repository policy applied to a judgment whose material findings carry valid
// evidence. ACTION_AUTHORIZED is reserved for a future autonomous mode and is
// never produced here.
//
// This module is pure: no I/O, no imports, deterministic for its inputs.

export const JUDGMENTS = ["APPROVE", "NEEDS_DISCUSSION", "REQUEST_CHANGES"];
export const INTEGRITY_STATES = ["COMPLETE", "INCOMPLETE", "SUPERSEDED", "FAILED"];
export const PUBLISHED_OUTCOMES = ["APPROVE", "NEEDS_DISCUSSION", "REQUEST_CHANGES", "INCOMPLETE"];
export const AUTHORITY_STATES = ["ADVISORY", "POLICY_BLOCKED", "ACTION_AUTHORIZED"];
export const PUBLICATION_MODES = ["advisory", "legacy_stateful"];

// Legacy verdict vocabulary used by aiReviewService / @gitwire/rules.
const LEGACY_TO_JUDGMENT = {
  approved: "APPROVE",
  needs_discussion: "NEEDS_DISCUSSION",
  request_changes: "REQUEST_CHANGES",
};

const JUDGMENT_TO_LEGACY = {
  APPROVE: "approved",
  NEEDS_DISCUSSION: "needs_discussion",
  REQUEST_CHANGES: "request_changes",
};

function confidenceRank(c) {
  return c === "high" ? 3 : c === "medium" ? 2 : 1;
}

/**
 * Map a legacy verdict (approved | needs_discussion | request_changes) or an
 * already-normalized judgment to the normalized judgment vocabulary.
 *
 * @param {string} verdict
 * @returns {"APPROVE"|"NEEDS_DISCUSSION"|"REQUEST_CHANGES"|null} null when unknown
 */
export function normalizeJudgment(verdict) {
  if (typeof verdict !== "string") return null;
  if (LEGACY_TO_JUDGMENT[verdict]) return LEGACY_TO_JUDGMENT[verdict];
  if (JUDGMENT_TO_LEGACY[verdict]) return verdict;
  return null;
}

/**
 * Map a normalized judgment back to the legacy verdict vocabulary.
 *
 * @param {string} judgment
 * @returns {string|null}
 */
export function judgmentToLegacy(judgment) {
  return JUDGMENT_TO_LEGACY[judgment] ?? null;
}

/**
 * Resolve how a computed review may be published and what authority it carries.
 *
 * @param {object} input
 * @param {string} input.judgment              - legacy verdict or normalized judgment
 * @param {string} [input.integrityState]      - COMPLETE | INCOMPLETE | SUPERSEDED | FAILED.
 *                                               Unknown or missing values are treated as
 *                                               INCOMPLETE: GitWire never claims complete
 *                                               approval evidence it did not establish.
 * @param {boolean} [input.materialEvidenceValid] - whether every material finding
 *                                               carries valid evidence. Required for any
 *                                               blocking consequence.
 * @param {object} [input.repositoryPolicy]
 * @param {string[]} [input.repositoryPolicy.blockOnVerdict]     - legacy verdict names
 * @param {string}  [input.repositoryPolicy.minConfidenceToBlock]
 * @param {string}  [input.repositoryPolicy.confidence]          - this review's confidence
 * @param {string} [input.publicationMode]    - "advisory" (default) | "legacy_stateful"
 * @returns {{
 *   judgment: string, integrityState: string, publishedOutcome: string|null,
 *   githubReviewEvent: string|null, authorityState: string, policyBlocked: boolean,
 *   publicationAllowed: boolean, evidenceValid: boolean, integrityIncomplete: boolean,
 *   publicationMode: string, reason: string
 * }}
 */
export function resolveReviewPublication({
  judgment,
  integrityState,
  materialEvidenceValid = true,
  repositoryPolicy = {},
  publicationMode,
}) {
  const mode = PUBLICATION_MODES.includes(publicationMode) ? publicationMode : "advisory";

  const normalized = normalizeJudgment(judgment);
  if (!normalized) {
    throw new Error("resolveReviewPublication: unknown judgment '" + judgment + "'");
  }

  const integrity = INTEGRITY_STATES.includes(integrityState) ? integrityState : "INCOMPLETE";

  // Terminal integrity states never publish a review mutation. The invocation
  // is terminalized by the caller with its own receipt.
  if (integrity === "SUPERSEDED" || integrity === "FAILED") {
    return {
      judgment: normalized,
      integrityState: integrity,
      publishedOutcome: null,
      githubReviewEvent: null,
      authorityState: "ADVISORY",
      policyBlocked: false,
      publicationAllowed: false,
      evidenceValid: materialEvidenceValid === true,
      integrityIncomplete: true,
      publicationMode: mode,
      reason: integrity === "SUPERSEDED" ? "head_superseded" : "review_failed",
    };
  }

  // ── Published outcome ──────────────────────────────────────────────────────
  // A clean APPROVE (or NEEDS_DISCUSSION) requires complete evidence; incomplete
  // coverage downgrades the published outcome to INCOMPLETE. An established
  // REQUEST_CHANGES survives incomplete coverage elsewhere: defects already
  // found are not suppressed by unrelated incompleteness (frozen v1.2).
  let publishedOutcome;
  let reason;
  if (normalized === "REQUEST_CHANGES") {
    publishedOutcome = "REQUEST_CHANGES";
    reason = "advisory_ai_review";
  } else if (integrity === "COMPLETE") {
    publishedOutcome = normalized;
    reason = "advisory_ai_review";
  } else {
    publishedOutcome = "INCOMPLETE";
    reason = "evidence_incomplete_downgrade";
  }

  // ── Authority ──────────────────────────────────────────────────────────────
  // Only explicit repository policy — applied to a judgment whose material
  // findings carry valid evidence, at or above the configured confidence
  // threshold — produces a blocking consequence. Model output alone never
  // blocks (frozen v1.2 criteria 4, 5 and 12).
  const blockOnVerdict = Array.isArray(repositoryPolicy.blockOnVerdict)
    ? repositoryPolicy.blockOnVerdict
    : [];
  const blocksThisJudgment = blockOnVerdict.some(
    (v) => normalizeJudgment(v) === normalized
  );
  const confidenceMeetsThreshold =
    confidenceRank(repositoryPolicy.confidence) >=
    confidenceRank(repositoryPolicy.minConfidenceToBlock || "medium");
  const policyBlocked =
    blocksThisJudgment === true &&
    confidenceMeetsThreshold &&
    materialEvidenceValid === true;

  // ── GitHub review event ────────────────────────────────────────────────────
  // Advisory mode always publishes COMMENT. legacy_stateful preserves the
  // pre-advisory event mapping for rollback; an INCOMPLETE published outcome
  // is never dressed up as a GitHub APPROVE in any mode.
  let githubReviewEvent;
  if (mode === "legacy_stateful" && publishedOutcome !== "INCOMPLETE") {
    if (publishedOutcome === "APPROVE") {
      githubReviewEvent = "APPROVE";
    } else if (publishedOutcome === "REQUEST_CHANGES") {
      githubReviewEvent = "REQUEST_CHANGES";
    } else {
      githubReviewEvent = "COMMENT";
    }
  } else {
    githubReviewEvent = "COMMENT";
  }

  return {
    judgment: normalized,
    integrityState: integrity,
    publishedOutcome,
    githubReviewEvent,
    authorityState: policyBlocked ? "POLICY_BLOCKED" : "ADVISORY",
    policyBlocked,
    publicationAllowed: true,
    evidenceValid: materialEvidenceValid === true,
    integrityIncomplete: integrity === "INCOMPLETE",
    publicationMode: mode,
    reason,
  };
}
