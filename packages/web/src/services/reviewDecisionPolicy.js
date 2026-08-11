// src/services/reviewDecisionPolicy.js
// Deterministic review decision policy (RI-6).
//
// This is the SINGLE authority that maps review results to a GitHub review
// event (APPROVE, COMMENT, REQUEST_CHANGES). The model discovers findings;
// deterministic code authorizes the review state.
//
// The invariant: P2 findings → never APPROVE.
// By cutover, computeVerdict() must NOT control the GitHub review event.

import { SEVERITY } from "./findingValidator.js";

// ── Review event types ───────────────────────────────────────────────────────

export const REVIEW_EVENT = Object.freeze({
  APPROVE:          "APPROVE",
  COMMENT:          "COMMENT",
  REQUEST_CHANGES:  "REQUEST_CHANGES",
});

// ── Check conclusion states ──────────────────────────────────────────────────

export const CHECK_STATE = Object.freeze({
  REVIEW_PASSED:    "review_passed",
  REVIEW_BLOCKED:   "review_blocked",
  REVIEW_INCOMPLETE:"review_incomplete",
  REVIEW_UNAVAILABLE:"review_unavailable",
  NOT_ACTIVATED:    "not_activated",
});

// ── Decision inputs ──────────────────────────────────────────────────────────

/**
 * @typedef {object} DecisionInputs
 * @property {object[]} primaryFindings - validated findings from the primary reviewer
 * @property {object|null} verifierReceipt - from runApprovalVerification (null if not run)
 * @property {object} evidence - ReviewEvidence with coverage manifest
 * @property {string|null} skipReason - if review was skipped (e.g. not_activated, spam_gate)
 */

// ── Decision policy ──────────────────────────────────────────────────────────

/**
 * Compute the deterministic review decision.
 *
 * State table (frozen, from the plan):
 *
 *   Condition                                          | GitHub review
 *   ---------------------------------------------------+------------------
 *   Skipped (not activated, spam gate, etc.)            | COMMENT + check: not_activated
 *   P0/P1 finding (primary or verifier)                | REQUEST_CHANGES
 *   P2 finding (primary or verifier)                   | COMMENT
 *   P3-only + evidence incomplete                      | COMMENT
 *   Zero findings + evidence incomplete                | COMMENT
 *   Verifier incomplete/error                          | COMMENT
 *   Verifier finds P0/P1                               | REQUEST_CHANGES
 *   Verifier finds P2                                   | COMMENT
 *   Only P3 or zero material + complete evidence +     | APPROVE
 *     clean verifier
 *
 * Invariant: P2 → never APPROVE
 *
 * @param {DecisionInputs} inputs
 * @returns {object} { event, checkState, decisionReason, approvalEligible }
 */
export function computeReviewDecision(inputs) {
  const {
    primaryFindings = [],
    verifierReceipt = null,
    evidence = null,
    skipReason = null,
  } = inputs;

  // ── Skip path (not activated, spam gate) ────────────────────────────────

  if (skipReason) {
    return {
      event: REVIEW_EVENT.COMMENT,
      checkState: CHECK_STATE.NOT_ACTIVATED,
      decisionReason: "Review skipped: " + skipReason,
      approvalEligible: false,
    };
  }

  // ── Combine findings from primary and verifier ───────────────────────────

  const verifierFindings = verifierReceipt?.findings || [];
  const allFindings = [...primaryFindings, ...verifierFindings];

  const hasP0 = allFindings.some(f => f.severity === SEVERITY.P0);
  const hasP1 = allFindings.some(f => f.severity === SEVERITY.P1);
  const hasP2 = allFindings.some(f => f.severity === SEVERITY.P2);
  const hasMaterial = hasP0 || hasP1 || hasP2;

  // ── P0/P1 → REQUEST_CHANGES ──────────────────────────────────────────────

  if (hasP0 || hasP1) {
    return {
      event: REVIEW_EVENT.REQUEST_CHANGES,
      checkState: CHECK_STATE.REVIEW_BLOCKED,
      decisionReason: (hasP0 ? "P0" : "P1") + " finding requires changes",
      approvalEligible: false,
    };
  }

  // ── P2 → COMMENT (never APPROVE) ─────────────────────────────────────────

  if (hasP2) {
    return {
      event: REVIEW_EVENT.COMMENT,
      checkState: CHECK_STATE.REVIEW_BLOCKED,
      decisionReason: "P2 finding present — needs discussion, never approve",
      approvalEligible: false,
    };
  }

  // ── Evidence incomplete → COMMENT ─────────────────────────────────────────

  const approvalEvidenceComplete = evidence?.coverage?.approvalEvidenceComplete === true;
  if (!approvalEvidenceComplete) {
    return {
      event: REVIEW_EVENT.COMMENT,
      checkState: CHECK_STATE.REVIEW_INCOMPLETE,
      decisionReason: "Approval evidence incomplete — cannot verify full coverage",
      approvalEligible: false,
    };
  }

  // ── Verifier incomplete/error → COMMENT ───────────────────────────────────

  if (verifierReceipt) {
    const vStatus = verifierReceipt.status;
    if (vStatus === "incomplete" || vStatus === "error") {
      return {
        event: REVIEW_EVENT.COMMENT,
        checkState: CHECK_STATE.REVIEW_INCOMPLETE,
        decisionReason: "Verifier " + vStatus + " — cannot confirm approval safety",
        approvalEligible: false,
      };
    }
    if (vStatus === "material_findings") {
      // Should have been caught by the P0/P1/P2 checks above, but fail-closed
      return {
        event: REVIEW_EVENT.COMMENT,
        checkState: CHECK_STATE.REVIEW_BLOCKED,
        decisionReason: "Verifier found material findings",
        approvalEligible: false,
      };
    }
    // vStatus === "verified" — continue to approval check
  }

  // ── No verifier run → COMMENT (verifier must run for APPROVE) ─────────────

  if (!verifierReceipt) {
    return {
      event: REVIEW_EVENT.COMMENT,
      checkState: CHECK_STATE.REVIEW_INCOMPLETE,
      decisionReason: "Independent approval verifier did not run — cannot confirm approval safety",
      approvalEligible: false,
    };
  }

  // ── Only P3 or zero material findings + complete evidence + clean verifier ─
  // → APPROVE

  return {
    event: REVIEW_EVENT.APPROVE,
    checkState: CHECK_STATE.REVIEW_PASSED,
    decisionReason: "No material findings, evidence complete, verifier clean",
    approvalEligible: true,
  };
}

// ── Check conclusion builder ─────────────────────────────────────────────────

/**
 * Build the top-level GitWire check conclusion from a review decision.
 *
 * The check must distinguish:
 *   review_passed      — APPROVE was issued
 *   review_blocked     — P0/P1/P2 found, REQUEST_CHANGES or COMMENT
 *   review_incomplete  — evidence incomplete or verifier incomplete
 *   review_unavailable — review could not run (error, not activated)
 *   not_activated      — AI review not activated for this repository
 *
 * @param {object} decision - from computeReviewDecision
 * @returns {object} { conclusion, title, summary }
 */
export function buildCheckConclusion(decision) {
  switch (decision.checkState) {
    case CHECK_STATE.REVIEW_PASSED:
      return {
        conclusion: "success",
        title: "GitWire \u2014 review passed",
        summary: decision.decisionReason,
      };

    case CHECK_STATE.REVIEW_BLOCKED:
      return {
        conclusion: "failure",
        title: "GitWire \u2014 review blocked merge",
        summary: decision.decisionReason,
      };

    case CHECK_STATE.REVIEW_INCOMPLETE:
      return {
        conclusion: "neutral",
        title: "GitWire \u2014 review incomplete",
        summary: decision.decisionReason,
      };

    case CHECK_STATE.REVIEW_UNAVAILABLE:
      return {
        conclusion: "neutral",
        title: "GitWire \u2014 review unavailable",
        summary: decision.decisionReason,
      };

    case CHECK_STATE.NOT_ACTIVATED:
      return {
        conclusion: "neutral",
        title: "GitWire \u2014 AI review not activated",
        summary: decision.decisionReason,
      };

    default:
      return {
        conclusion: "neutral",
        title: "GitWire \u2014 review state unknown",
        summary: decision.decisionReason || "Unknown review state",
      };
  }
}
