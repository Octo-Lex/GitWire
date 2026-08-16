// Phase 9 scoring (RI-9 amendment) — pure functions over synthetic records.

import {
  scoreBrokenEffectiveness,
  scoreFixedPrecision,
  scoreConvergence,
  applyDecisionRule,
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
    expect(scoreConvergence({ execution: EXEC({ status: "incomplete", terminationReason: "budget_exceeded", submission: undefined }) }).converged).toBe(false);
  });
});

describe("scoreBrokenEffectiveness", () => {
  const expected = { evidencePaths: ["packages/web/src/lib/commentMarkers.js"] };

  it("on-target = expected path + RI-4 valid + evidence complete", () => {
    const record = {
      execution: EXEC({
        submission: {
          payload: {
            findings: [
              { severity: "P2", claim: "unpaginated", evidenceRefs: ["repo-read:packages/web/src/lib/commentMarkers.js@HEAD:L49-L68"] },
            ],
          },
        },
      }),
      ri4FindingValidation: [{ valid: true }],
      submissionVerification: { findings: [{ evidenceComplete: true }] },
    };
    const score = scoreBrokenEffectiveness(record, expected);
    expect(score.detected).toBe(true);
  });

  it("a syntactically plausible but unverified finding does NOT count", () => {
    const record = {
      execution: EXEC({
        submission: {
          payload: {
            findings: [
              { severity: "P2", claim: "unpaginated", evidenceRefs: ["repo-read:packages/web/src/lib/commentMarkers.js@HEAD:L49-L68"] },
            ],
          },
        },
      }),
      ri4FindingValidation: [{ valid: false }],
      submissionVerification: { findings: [{ evidenceComplete: false }] },
    };
    expect(scoreBrokenEffectiveness(record, expected).detected).toBe(false);
  });

  it("a finding citing an unrelated path does not count", () => {
    const record = {
      execution: EXEC({
        submission: { payload: { findings: [{ severity: "P1", claim: "x", evidenceRefs: ["repo-read:README.md@HEAD:L1-L1"] }] } },
      }),
      ri4FindingValidation: [{ valid: true }],
      submissionVerification: { findings: [{ evidenceComplete: true }] },
    };
    expect(scoreBrokenEffectiveness(record, expected).detected).toBe(false);
  });
});

describe("scoreFixedPrecision", () => {
  it("clean submission is precise; a failing material finding is not", () => {
    expect(scoreFixedPrecision({ execution: EXEC() }).precise).toBe(true);
    const withFalse = {
      execution: EXEC({ submission: { payload: { findings: [{ severity: "P2", claim: "x", evidenceRefs: [] }] } } }),
      ri4FindingValidation: [{ valid: false }],
      submissionVerification: { findings: [{ evidenceComplete: false }] },
    };
    const score = scoreFixedPrecision(withFalse);
    expect(score.precise).toBe(false);
    expect(score.falseMaterialCount).toBe(1);
  });
});

describe("applyDecisionRule", () => {
  const card = (over) => ({
    "current-gitwire": { runs: 6, converged: 0, brokenDetected: 0, brokenRuns: 3, fixedPrecise: 0, fixedRuns: 3, evidenceIntact: 0, ...over.current },
    pi: { runs: 6, converged: 0, brokenDetected: 0, brokenRuns: 3, fixedPrecise: 0, fixedRuns: 3, evidenceIntact: 0, ...over.pi },
  });

  it("keep-current when current converges and detects while Pi fails to converge", () => {
    const outcome = applyDecisionRule(card({
      current: { converged: 5, brokenDetected: 2, fixedPrecise: 3, evidenceIntact: 5 },
      pi: { converged: 1 },
    }));
    expect(outcome.outcome).toBe("keep-current");
  });

  it("choose-pi when Pi is materially better and not worse elsewhere", () => {
    const outcome = applyDecisionRule(card({
      current: { converged: 2, brokenDetected: 0, fixedPrecise: 3, evidenceIntact: 2 },
      pi: { converged: 5, brokenDetected: 2, fixedPrecise: 3, evidenceIntact: 5 },
    }));
    expect(outcome.outcome).toBe("choose-pi");
  });

  it("no-winner when both fail similarly", () => {
    const outcome = applyDecisionRule(card({
      current: { converged: 1, brokenDetected: 0 },
      pi: { converged: 1, brokenDetected: 0 },
    }));
    expect(outcome.outcome).toBe("no-winner");
  });
});
