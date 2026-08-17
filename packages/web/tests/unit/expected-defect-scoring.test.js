// tests/unit/expected-defect-scoring.test.js
// Deterministic tests for strict expected-defect scoring (RI-9 evaluation
// integrity correction).
//
// Proves the detector awards credit ONLY for the fixture's expected defect:
// the exact false positive from the 2026-08-14 diagnostic (a comment-posting
// error-control finding that merely mentioned "duplicate comment") is
// rejected, and only a canonical P0/P1/P2 pagination finding counts.

import { detectExpectedDefect, canonicalMaterialFindings } from "../evaluation/review-integrity/expected-defect.js";

const RI04 = { caseId: "RI-04", variant: "broken", expectedFinding: {} };

describe("RI-9 strict expected-defect scoring", () => {

  it("REJECTS the false-positive finding from the 2026-08-14 diagnostic", () => {
    // Actual artifact text: a real finding, but about error-control flow —
    // not pagination. The old detector scored this as defectDetected: true.
    const run = {
      result: {
        findings: [{
          severity: "medium",
          title: "Comment-posting errors now fail the entire triage job",
          description: "The broadened comment path can create a duplicate comment when posting fails and the job retries the same issue.",
        }],
      },
      v2PrimaryFindings: [],
      v2VerifierReceipt: null,
    };
    expect(detectExpectedDefect(RI04, run)).toBe(false);
  });

  it("ACCEPTS a canonical P2 finding that describes the actual pagination defect", () => {
    const run = {
      result: { findings: [] },
      v2PrimaryFindings: [{
        severity: "P2",
        claim: "findCommentByMarker fetches only the first page of 100 comments (no pagination); a marker beyond page 1 is missed and postMarkedComment creates a duplicate comment",
      }],
      v2VerifierReceipt: null,
    };
    expect(detectExpectedDefect(RI04, run)).toBe(true);
  });

  it("NEVER counts P3 findings, regardless of vocabulary", () => {
    const run = {
      result: { findings: [] },
      v2PrimaryFindings: [{
        severity: "P3",
        claim: "findCommentByMarker has no pagination beyond page 1 of 100 comments, risking a duplicate comment",
      }],
      v2VerifierReceipt: null,
    };
    expect(canonicalMaterialFindings(run)).toEqual([]);
    expect(detectExpectedDefect(RI04, run)).toBe(false);
  });

  it("NEVER counts unresolved context needs as detection", () => {
    const run = {
      result: { findings: [] },
      v2PrimaryFindings: [],
      v2VerifierReceipt: null,
      // unresolved declarations are not part of the run context by design —
      // the detector only reads canonical findings
    };
    expect(detectExpectedDefect(RI04, run)).toBe(false);
  });

  it("counts a verifier material finding that matches the expected defect", () => {
    const run = {
      result: { findings: [] },
      v2PrimaryFindings: [],
      v2VerifierReceipt: {
        findings: [{
          severity: "P2",
          claim: "marker lookup reads one page of 100 comments only — duplicate comment on high-volume issues",
        }],
      },
    };
    expect(detectExpectedDefect(RI04, run)).toBe(true);
  });

  it("RI-01 requires stale-status semantics, not just any doc mention", () => {
    const ri01 = { caseId: "RI-01", variant: "broken", expectedFinding: {} };
    const offTopic = {
      result: { findings: [{ severity: "high", title: "Typo in README", description: "spelling" }] },
      v2PrimaryFindings: [],
      v2VerifierReceipt: null,
    };
    const onTopic = {
      result: { findings: [] },
      v2PrimaryFindings: [{
        severity: "P2",
        claim: "constitution.md still declares Phase 0.0 reopened — status declarations are stale and contradict the PR closing it",
      }],
      v2VerifierReceipt: null,
    };
    expect(detectExpectedDefect(ri01, offTopic)).toBe(false);
    expect(detectExpectedDefect(ri01, onTopic)).toBe(true);
  });
});
