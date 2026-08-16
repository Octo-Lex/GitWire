// Phase 9 scoring (RI-9 amendment) — pure functions over synthetic records.
// Includes the review-correction regressions: strict semantic oracle,
// adjudication-gated fixed precision, and material-superiority decision
// semantics (a one-run convergence margin is NOT material).

import {
  scoreBrokenEffectiveness,
  scoreFixedPrecision,
  scoreConvergence,
  applyDecisionRule,
  strictExpectedDefect,
} from "../../../src/lib/reviewHarness/abScoring.js";

const EXEC = (over = {}) => ({
  status: "completed",
  terminationReason: "submitted",
  durationMs: 1000,
  toolTrace: [{ operation: "read" }],
  usage: { totalTokens: 100, costUsd: 0.01 },
  submission: { payload: { findings: [] } },
  ...over,
});

describe("scoreConvergence", () => {
  it("converged only on completed+submitted with a submission", () => {
    expect(scoreConvergence({ execution: EXEC() }).converged).toBe(true);
    expect(
      scoreConvergence({ execution: EXEC({ status: "incomplete", terminationReason: "budget_exceeded", submission: undefined }) }).converged
    ).toBe(false);
  });
});

describe("strictExpectedDefect (RI-04 semantic oracle)", () => {
  const ON_TARGET =
    "findCommentByMarker fetches only the first page of 100 comments so a marker beyond page 1 is missed and a duplicate comment is created";
  const RELATED_WRONG_DEFECT = "docs/workers/triage-worker.md omits the triage comment step";

  it("matches only the expected marker-lookup + pagination + duplicate semantics", () => {
    expect(strictExpectedDefect("RI-04", { claim: ON_TARGET })).toBe(true);
    expect(strictExpectedDefect("RI-04", { claim: RELATED_WRONG_DEFECT })).toBe(false);
    expect(strictExpectedDefect("RI-04", { claim: "duplicate comments somewhere" })).toBe(false);
    expect(strictExpectedDefect("RI-04", { claim: "findCommentByMarker is slow" })).toBe(false);
    expect(strictExpectedDefect("RI-99", { claim: ON_TARGET })).toBe(false);
  });
});

describe("scoreBrokenEffectiveness", () => {
  const expected = { caseId: "RI-04" };
  const ON_TARGET_CLAIM =
    "findCommentByMarker fetches only the first page of 100 comments so a marker beyond page 1 is missed and a duplicate comment is created";

  it("on-target = strict oracle + RI-4 valid + evidence complete", () => {
    const record = {
      execution: EXEC({
        submission: { payload: { findings: [{ severity: "P2", claim: ON_TARGET_CLAIM, evidenceRefs: ["repo-read:p@HEAD:L1-L1"] }] } },
      }),
      ri4FindingValidation: [{ valid: true }],
      submissionVerification: { findings: [{ evidenceComplete: true }] },
    };
    expect(scoreBrokenEffectiveness(record, expected).detected).toBe(true);
  });

  it("a related-but-wrong finding citing the expected FILES scores NOTHING", () => {
    const record = {
      execution: EXEC({
        submission: {
          payload: {
            findings: [
              {
                severity: "P2",
                claim: "triage docs omit the comment step",
                evidenceRefs: ["repo-read:packages/web/src/lib/commentMarkers.js@HEAD:L49-L68"],
              },
            ],
          },
        },
      }),
      ri4FindingValidation: [{ valid: true }],
      submissionVerification: { findings: [{ evidenceComplete: true }] },
    };
    expect(scoreBrokenEffectiveness(record, expected).detected).toBe(false);
  });

  it("a strict-oracle match that fails verification does NOT count", () => {
    const record = {
      execution: EXEC({
        submission: { payload: { findings: [{ severity: "P2", claim: ON_TARGET_CLAIM, evidenceRefs: ["repo-read:p@HEAD:L1-L1"] }] } },
      }),
      ri4FindingValidation: [{ valid: false }],
      submissionVerification: { findings: [{ evidenceComplete: false }] },
    };
    expect(scoreBrokenEffectiveness(record, expected).detected).toBe(false);
  });
});

describe("scoreFixedPrecision", () => {
  it("clean submission is precise", () => {
    expect(scoreFixedPrecision({ execution: EXEC() }).precise).toBe(true);
  });

  it("a SUPPORTED material claim on the clean fixture counts against precision without adjudication", () => {
    const record = {
      execution: EXEC({ submission: { payload: { findings: [{ severity: "P2", claim: "x", evidenceRefs: ["repo-read:p@HEAD:L1-L1"] }] } } }),
      ri4FindingValidation: [{ valid: true }],
      submissionVerification: { findings: [{ evidenceComplete: true }] },
    };
    expect(scoreFixedPrecision(record).precise).toBe(false);
    expect(scoreFixedPrecision(record).falseMaterialCount).toBe(1);
  });

  it("an adjudicated-true material claim does not count against precision", () => {
    const record = {
      execution: EXEC({ submission: { payload: { findings: [{ severity: "P2", claim: "x", evidenceRefs: ["repo-read:p@HEAD:L1-L1"] }] } } }),
      ri4FindingValidation: [{ valid: true }],
      submissionVerification: { findings: [{ evidenceComplete: true }] },
      adjudication: { trueMaterialByIndex: { 0: true } },
    };
    expect(scoreFixedPrecision(record).precise).toBe(true);
  });

  it("an unsupported material finding counts against precision", () => {
    const record = {
      execution: EXEC({ submission: { payload: { findings: [{ severity: "P2", claim: "x", evidenceRefs: [] }] } } }),
      ri4FindingValidation: [{ valid: false }],
      submissionVerification: { findings: [{ evidenceComplete: false }] },
    };
    expect(scoreFixedPrecision(record).precise).toBe(false);
  });
});

describe("applyDecisionRule", () => {
  const card = (over) => ({
    "current-gitwire": { runs: 6, converged: 0, brokenDetected: 0, brokenRuns: 3, fixedPrecise: 0, fixedRuns: 3, evidenceIntact: 0, ...over.current },
    pi: { runs: 6, converged: 0, brokenDetected: 0, brokenRuns: 3, fixedPrecise: 0, fixedRuns: 3, evidenceIntact: 0, ...over.pi },
  });

  it("THE RECORDED MATRIX (4/6 vs 3/6 convergence, 0/3 detection both) is NO-WINNER", () => {
    const outcome = applyDecisionRule(card({
      current: { converged: 3, brokenDetected: 0, fixedPrecise: 1, evidenceIntact: 3 },
      pi: { converged: 4, brokenDetected: 0, fixedPrecise: 1, evidenceIntact: 4 },
    }));
    expect(outcome.outcome).toBe("no-winner");
    expect(outcome.rationale).toContain("not material");
  });

  it("keep-current when current converges and detects while Pi fails to converge", () => {
    const outcome = applyDecisionRule(card({
      current: { converged: 5, brokenDetected: 2, fixedPrecise: 3, evidenceIntact: 5 },
      pi: { converged: 1 },
    }));
    expect(outcome.outcome).toBe("keep-current");
  });

  it("choose-pi on detection superiority", () => {
    const outcome = applyDecisionRule(card({
      current: { converged: 4, brokenDetected: 0, fixedPrecise: 3, evidenceIntact: 4 },
      pi: { converged: 4, brokenDetected: 2, fixedPrecise: 3, evidenceIntact: 4 },
    }));
    expect(outcome.outcome).toBe("choose-pi");
  });

  it("choose-pi on a convergence margin GREATER than one run", () => {
    const outcome = applyDecisionRule(card({
      current: { converged: 2, brokenDetected: 0, fixedPrecise: 3, evidenceIntact: 2 },
      pi: { converged: 5, brokenDetected: 0, fixedPrecise: 3, evidenceIntact: 5 },
    }));
    expect(outcome.outcome).toBe("choose-pi");
  });

  it("a one-run convergence margin with tied detection is NO-WINNER even if everything else favors Pi", () => {
    const outcome = applyDecisionRule(card({
      current: { converged: 3, fixedPrecise: 1, evidenceIntact: 3 },
      pi: { converged: 4, fixedPrecise: 3, evidenceIntact: 4 },
    }));
    expect(outcome.outcome).toBe("no-winner");
  });

  it("choose-pi is blocked when fixed precision is worse", () => {
    const outcome = applyDecisionRule(card({
      current: { converged: 2, brokenDetected: 1, fixedPrecise: 3, evidenceIntact: 2 },
      pi: { converged: 5, brokenDetected: 2, fixedPrecise: 1, evidenceIntact: 5 },
    }));
    expect(outcome.outcome).not.toBe("choose-pi");
  });
});
