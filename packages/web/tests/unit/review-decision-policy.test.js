// tests/unit/review-decision-policy.test.js
// Tests for RI-6: deterministic review decision policy.
//
// Proves the frozen state table and the P2→never APPROVE invariant.
// Only deterministic code selects the review event — no model authority.

import {
  REVIEW_EVENT,
  CHECK_STATE,
  computeReviewDecision,
  buildCheckConclusion,
} from "../../src/services/reviewDecisionPolicy.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeFinding(severity, overrides = {}) {
  return { severity, category: "bug", claim: "test", evidenceRefs: ["changed:src/app.js@HEAD:L1-L2"], ...overrides };
}

function makeEvidence(complete = true) {
  return { coverage: { approvalEvidenceComplete: complete } };
}

function makeVerifiedReceipt(findings = []) {
  return { status: "verified", findings, approvalSafe: true };
}

function makeIncompleteReceipt() {
  return { status: "incomplete", findings: [], approvalSafe: false, unresolvedContextRequests: ["needed X"] };
}

// ── State table tests ───────────────────────────────────────────────────────

describe("RI-6: computeReviewDecision — frozen state table", () => {

  // P0/P1 → REQUEST_CHANGES
  it("P0 primary finding → REQUEST_CHANGES", () => {
    const decision = computeReviewDecision({
      primaryFindings: [makeFinding("P0")],
      evidence: makeEvidence(true),
      verifierReceipt: makeVerifiedReceipt(),
    });
    expect(decision.event).toBe(REVIEW_EVENT.REQUEST_CHANGES);
    expect(decision.approvalEligible).toBe(false);
  });

  it("P1 primary finding → REQUEST_CHANGES", () => {
    const decision = computeReviewDecision({
      primaryFindings: [makeFinding("P1")],
      evidence: makeEvidence(true),
      verifierReceipt: makeVerifiedReceipt(),
    });
    expect(decision.event).toBe(REVIEW_EVENT.REQUEST_CHANGES);
  });

  it("P0 verifier finding → REQUEST_CHANGES", () => {
    const decision = computeReviewDecision({
      primaryFindings: [],
      evidence: makeEvidence(true),
      verifierReceipt: makeVerifiedReceipt([makeFinding("P0")]),
    });
    expect(decision.event).toBe(REVIEW_EVENT.REQUEST_CHANGES);
  });

  it("P1 verifier finding → REQUEST_CHANGES", () => {
    const decision = computeReviewDecision({
      primaryFindings: [],
      evidence: makeEvidence(true),
      verifierReceipt: makeVerifiedReceipt([makeFinding("P1")]),
    });
    expect(decision.event).toBe(REVIEW_EVENT.REQUEST_CHANGES);
  });

  // P2 → COMMENT (never APPROVE)
  it("P2 primary finding → COMMENT (never approve)", () => {
    const decision = computeReviewDecision({
      primaryFindings: [makeFinding("P2")],
      evidence: makeEvidence(true),
      verifierReceipt: makeVerifiedReceipt(),
    });
    expect(decision.event).toBe(REVIEW_EVENT.COMMENT);
    expect(decision.checkState).toBe(CHECK_STATE.REVIEW_BLOCKED);
    expect(decision.approvalEligible).toBe(false);
  });

  it("P2 verifier finding → COMMENT", () => {
    const decision = computeReviewDecision({
      primaryFindings: [],
      evidence: makeEvidence(true),
      verifierReceipt: makeVerifiedReceipt([makeFinding("P2")]),
    });
    expect(decision.event).toBe(REVIEW_EVENT.COMMENT);
  });

  // P3-only + evidence incomplete → COMMENT
  it("P3-only + evidence incomplete → COMMENT + review_incomplete", () => {
    const decision = computeReviewDecision({
      primaryFindings: [makeFinding("P3")],
      evidence: makeEvidence(false),
      verifierReceipt: makeVerifiedReceipt(),
    });
    expect(decision.event).toBe(REVIEW_EVENT.COMMENT);
    expect(decision.checkState).toBe(CHECK_STATE.REVIEW_INCOMPLETE);
  });

  // Zero findings + evidence incomplete → COMMENT
  it("Zero findings + evidence incomplete → COMMENT + review_incomplete", () => {
    const decision = computeReviewDecision({
      primaryFindings: [],
      evidence: makeEvidence(false),
      verifierReceipt: makeVerifiedReceipt(),
    });
    expect(decision.event).toBe(REVIEW_EVENT.COMMENT);
    expect(decision.checkState).toBe(CHECK_STATE.REVIEW_INCOMPLETE);
  });

  // Verifier incomplete → COMMENT
  it("Verifier incomplete → COMMENT + review_incomplete", () => {
    const decision = computeReviewDecision({
      primaryFindings: [],
      evidence: makeEvidence(true),
      verifierReceipt: makeIncompleteReceipt(),
    });
    expect(decision.event).toBe(REVIEW_EVENT.COMMENT);
    expect(decision.checkState).toBe(CHECK_STATE.REVIEW_INCOMPLETE);
  });

  it("Verifier error → COMMENT + review_incomplete", () => {
    const decision = computeReviewDecision({
      primaryFindings: [],
      evidence: makeEvidence(true),
      verifierReceipt: { status: "error", findings: [], approvalSafe: false },
    });
    expect(decision.event).toBe(REVIEW_EVENT.COMMENT);
    expect(decision.checkState).toBe(CHECK_STATE.REVIEW_INCOMPLETE);
  });

  // Only P3 or zero material + complete evidence + clean verifier → APPROVE
  it("Zero findings + complete evidence + clean verifier → APPROVE", () => {
    const decision = computeReviewDecision({
      primaryFindings: [],
      evidence: makeEvidence(true),
      verifierReceipt: makeVerifiedReceipt(),
    });
    expect(decision.event).toBe(REVIEW_EVENT.APPROVE);
    expect(decision.checkState).toBe(CHECK_STATE.REVIEW_PASSED);
    expect(decision.approvalEligible).toBe(true);
  });

  it("P3-only + complete evidence + clean verifier → APPROVE", () => {
    const decision = computeReviewDecision({
      primaryFindings: [makeFinding("P3")],
      evidence: makeEvidence(true),
      verifierReceipt: makeVerifiedReceipt(),
    });
    expect(decision.event).toBe(REVIEW_EVENT.APPROVE);
  });

  // ── Skip path ─────────────────────────────────────────────────────────────

  it("Skip reason → COMMENT + not_activated", () => {
    const decision = computeReviewDecision({
      skipReason: "not_activated",
    });
    expect(decision.event).toBe(REVIEW_EVENT.COMMENT);
    expect(decision.checkState).toBe(CHECK_STATE.NOT_ACTIVATED);
    expect(decision.approvalEligible).toBe(false);
  });

  // ── P2→never APPROVE invariant (comprehensive) ────────────────────────────

  it("P2 finding with complete evidence and clean verifier → still COMMENT", () => {
    const decision = computeReviewDecision({
      primaryFindings: [makeFinding("P2")],
      evidence: makeEvidence(true),
      verifierReceipt: makeVerifiedReceipt(),
    });
    expect(decision.event).not.toBe(REVIEW_EVENT.APPROVE);
  });

  it("P2 finding from verifier with P3 from primary → still COMMENT", () => {
    const decision = computeReviewDecision({
      primaryFindings: [makeFinding("P3")],
      evidence: makeEvidence(true),
      verifierReceipt: makeVerifiedReceipt([makeFinding("P2")]),
    });
    expect(decision.event).toBe(REVIEW_EVENT.COMMENT);
  });

  // ── Combined primary + verifier findings ──────────────────────────────────

  it("P3 primary + P0 verifier → REQUEST_CHANGES (verifier escalates)", () => {
    const decision = computeReviewDecision({
      primaryFindings: [makeFinding("P3")],
      evidence: makeEvidence(true),
      verifierReceipt: makeVerifiedReceipt([makeFinding("P0")]),
    });
    expect(decision.event).toBe(REVIEW_EVENT.REQUEST_CHANGES);
  });

  it("No verifier run + zero findings + complete evidence → COMMENT (no approval without verifier)", () => {
    const decision = computeReviewDecision({
      primaryFindings: [],
      evidence: makeEvidence(true),
      verifierReceipt: null,
    });
    expect(decision.event).toBe(REVIEW_EVENT.COMMENT);
    expect(decision.approvalEligible).toBe(false);
  });

  // ── Verifier must be exactly "verified" for APPROVE ──────────────────────

  it("Verifier with missing status → COMMENT (never APPROVE)", () => {
    const decision = computeReviewDecision({
      primaryFindings: [],
      evidence: makeEvidence(true),
      verifierReceipt: { findings: [], approvalSafe: true }, // no status field
    });
    expect(decision.event).toBe(REVIEW_EVENT.COMMENT);
    expect(decision.approvalEligible).toBe(false);
  });

  it("Verifier with unknown status → COMMENT (never APPROVE)", () => {
    const decision = computeReviewDecision({
      primaryFindings: [],
      evidence: makeEvidence(true),
      verifierReceipt: { status: "bogus", findings: [], approvalSafe: true },
    });
    expect(decision.event).toBe(REVIEW_EVENT.COMMENT);
    expect(decision.approvalEligible).toBe(false);
  });
});

// ── Check conclusion builder ─────────────────────────────────────────────────

describe("RI-6: buildCheckConclusion", () => {

  it("REVIEW_PASSED → success conclusion", () => {
    const conclusion = buildCheckConclusion({
      checkState: CHECK_STATE.REVIEW_PASSED,
      decisionReason: "All clean",
    });
    expect(conclusion.conclusion).toBe("success");
    expect(conclusion.title).toContain("passed");
  });

  it("REVIEW_BLOCKED → failure conclusion", () => {
    const conclusion = buildCheckConclusion({
      checkState: CHECK_STATE.REVIEW_BLOCKED,
      decisionReason: "P0 found",
    });
    expect(conclusion.conclusion).toBe("failure");
    expect(conclusion.title).toContain("blocked");
  });

  it("REVIEW_INCOMPLETE → neutral conclusion", () => {
    const conclusion = buildCheckConclusion({
      checkState: CHECK_STATE.REVIEW_INCOMPLETE,
      decisionReason: "Evidence incomplete",
    });
    expect(conclusion.conclusion).toBe("neutral");
    expect(conclusion.title).toContain("incomplete");
  });

  it("NOT_ACTIVATED → neutral conclusion with activation message", () => {
    const conclusion = buildCheckConclusion({
      checkState: CHECK_STATE.NOT_ACTIVATED,
      decisionReason: "not_activated",
    });
    expect(conclusion.conclusion).toBe("neutral");
    expect(conclusion.title).toContain("not activated");
  });

  it("REVIEW_UNAVAILABLE → neutral conclusion", () => {
    const conclusion = buildCheckConclusion({
      checkState: CHECK_STATE.REVIEW_UNAVAILABLE,
      decisionReason: "Review errored",
    });
    expect(conclusion.conclusion).toBe("neutral");
    expect(conclusion.title).toContain("unavailable");
  });
});
