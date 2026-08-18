// tests/unit/execution-profile-instrumentation.test.js
// RI-9 Phase 10 (slice C): primary and verifier invocations are
// instrumented independently with deterministic execution profiles.
//
// Scripted (fake) provider responses prove the frozen cases:
//   requested + provider-observed model
//   requested model only
//   completely opaque identity
//   primary and verifier recorded separately
//   config change → different analytics fingerprint; same config → same
//   optional usage absent → receipt remains valid
//   error/timeout → terminal profile still persisted

import { jest } from "@jest/globals";
import { IDENTITY_SOURCE } from "../../src/services/executionProfileService.js";
import { completeClearedLedger } from "./verifierLedgerFixture.js";

const { runPrimaryReview } = await import("../../src/services/primaryReviewService.js");
const { runApprovalVerification } = await import("../../src/services/approvalVerificationService.js");

// ── Shared fixtures ──────────────────────────────────────────────────────────

const EVIDENCE = {
  version: 1,
  review: { repoId: 1, prNumber: 9, baseSha: "b".repeat(40), headSha: "h".repeat(40), invocationId: "rinv:test" },
  changedFiles: [
    {
      path: "src/one.js", status: "modified", coverage: "full",
      additions: 2, deletions: 1, representedLines: 3,
      patch: "@@ -1,1 +1,2 @@\n ctx\n+new",
      head: { sha: "h".repeat(40), blobSha: "bh", contentDigest: "d1" },
      base: { sha: "b".repeat(40), blobSha: "bb", contentDigest: "d0" },
    },
  ],
  contextItems: [],
  retrievalTrace: [],
  coverage: { totalChangedFiles: 1, fullyCoveredFiles: 1, approvalEvidenceComplete: true },
};

// A provider whose round-0 response stops naturally; the forced submission
// turn emits the submit tool with a clean result.
function makeFakeAnthropic({ roundModel = "observed-model-1", submitModel = roundModel, usage = { input_tokens: 100, output_tokens: 20 } } = {}) {
  let call = 0;
  return {
    baseURL: "https://api.fake-provider.test/v1",
    messages: {
      create: async () => {
        call += 1;
        if (call === 1) {
          return {
            model: roundModel,
            stop_reason: "end_turn",
            usage,
            content: [{ type: "text", text: "I will inspect and submit." }],
          };
        }
        return {
          model: submitModel,
          stop_reason: "tool_use",
          usage,
          content: [{
            type: "tool_use", id: "tu1", name: "submit_review_result",
            input: {
              findings: [],
              unresolvedContextNeeds: [],
              overallCorrectness: "correct",
              overallConfidence: "high",
              summary: "clean",
            },
          }],
        };
      },
    },
  };
}

function makeFakeVerifierAnthropic({ observedModel = "observed-model-1", usage } = {}) {
  let call = 0;
  return {
    baseURL: "https://api.fake-provider.test/v1",
    messages: {
      create: async () => {
        call += 1;
        if (call === 1) {
          return {
            model: observedModel, stop_reason: "end_turn", usage: usage || { input_tokens: 50, output_tokens: 10 },
            content: [{ type: "text", text: "checking" }],
          };
        }
        return {
          model: observedModel, stop_reason: "tool_use", usage: usage || { input_tokens: 50, output_tokens: 10 },
          content: [{
            type: "tool_use", id: "tu1", name: "submit_verification_result",
            input: { status: "verified", findings: [], riskLedger: completeClearedLedger("changed:src/one.js@HEAD:L1-L2"), coverageSatisfied: true },
          }],
        };
      },
    },
  };
}

const fakeOctokit = { request: async () => { throw new Error("octokit must not be called in these tests"); } };

// ── Primary instrumentation ──────────────────────────────────────────────────

describe("Phase 10 C: primary invocation execution profile", () => {

  it("records requested + provider-observed model as provider_reported", async () => {
    const receipt = await runPrimaryReview({
      evidence: EVIDENCE, octokit: fakeOctokit, owner: "o", repo: "r",
      anthropic: makeFakeAnthropic({ roundModel: "glm-observed" }),
      model: "glm-requested",
    });

    expect(receipt.error).toBeUndefined();
    expect(receipt.executionProfile.requestedModel).toBe("glm-requested");
    expect(receipt.executionProfile.observedModel).toBe("glm-observed");
    expect(receipt.executionProfile.identitySource).toBe(IDENTITY_SOURCE.PROVIDER_REPORTED);
    expect(receipt.executionProfile.terminalState).toBe("completed");
  });

  it("records requested-model-only when the provider reports no identity", async () => {
    const anthropic = makeFakeAnthropic({ roundModel: null, submitModel: null });
    const receipt = await runPrimaryReview({
      evidence: EVIDENCE, octokit: fakeOctokit, owner: "o", repo: "r",
      anthropic, model: "opaque-route-model",
    });

    expect(receipt.executionProfile.observedModel).toBeNull();
    expect(receipt.executionProfile.identitySource).toBe(IDENTITY_SOURCE.REQUESTED_ONLY);
    expect(receipt.executionProfile.provider).toBe("api.fake-provider.test");
  });

  it("persists a terminal provider_error profile when the provider call fails", async () => {
    const anthropic = {
      baseURL: "https://api.fake-provider.test/v1",
      messages: { create: async () => { throw new Error("HTTP 529 overloaded"); } },
    };
    const receipt = await runPrimaryReview({
      evidence: EVIDENCE, octokit: fakeOctokit, owner: "o", repo: "r",
      anthropic, model: "m",
    });

    expect(receipt.error).toMatch(/LLM invocation failed/);
    expect(receipt.executionProfile.terminalState).toBe("provider_error");
    expect(receipt.executionProfile.terminalReason).toMatch(/529/);
    expect(receipt.executionProfile.requestedModel).toBe("m");
  });

  it("records per-category usage when exposed; total matches tokensUsed", async () => {
    const receipt = await runPrimaryReview({
      evidence: EVIDENCE, octokit: fakeOctokit, owner: "o", repo: "r",
      anthropic: makeFakeAnthropic({ usage: { input_tokens: 40, output_tokens: 6 } }),
      model: "m",
    });

    expect(receipt.executionProfile.usage.inputTokens).toBe(80); // two calls × 40
    expect(receipt.executionProfile.usage.outputTokens).toBe(12);
    expect(receipt.executionProfile.usage.cacheReadTokens).toBeNull();
    expect(receipt.executionProfile.usage.totalTokens).toBe(receipt.tokensUsed);
  });

  it("missing usage entirely still yields a valid receipt with null usage", async () => {
    const receipt = await runPrimaryReview({
      evidence: EVIDENCE, octokit: fakeOctokit, owner: "o", repo: "r",
      anthropic: makeFakeAnthropic({ usage: {} }),
      model: "m",
    });

    expect(receipt.executionProfile.usage).toBeNull();
    expect(receipt.executionProfile.terminalState).toBe("completed");
    expect(receipt.error).toBeUndefined();
  });

  it("text-cascade fallback submission (provider refused the tool) classifies completed", async () => {
    // The forced submission turn returns valid JSON as TEXT — no tool_use.
    // The parse cascade accepts it; the invocation completed even though
    // usedSubmitTool is false. Terminal state must say completed.
    let call = 0;
    const anthropic = {
      baseURL: "https://api.fake-provider.test/v1",
      messages: {
        create: async () => {
          call += 1;
          if (call === 1) {
            return {
              model: "observed-model-1", stop_reason: "end_turn",
              usage: { input_tokens: 30, output_tokens: 5 },
              content: [{ type: "text", text: "Inspecting." }],
            };
          }
          return {
            model: "observed-model-1", stop_reason: "end_turn",
            usage: { input_tokens: 30, output_tokens: 5 },
            content: [{ type: "text", text: '{\"findings\": [], \"unresolvedContextNeeds\": []}' }],
          };
        },
      },
    };
    const receipt = await runPrimaryReview({
      evidence: EVIDENCE, octokit: fakeOctokit, owner: "o", repo: "r",
      anthropic, model: "m",
    });

    expect(receipt.error).toBeUndefined();
    expect(receipt.submissionDiagnostics.usedSubmitTool).toBe(false);
    expect(receipt.executionProfile.terminalState).toBe("completed");
    expect(receipt.findings).toEqual([]);
  });

  it("same controlled config → same fingerprint; model change → different", async () => {
    const a = await runPrimaryReview({
      evidence: EVIDENCE, octokit: fakeOctokit, owner: "o", repo: "r",
      anthropic: makeFakeAnthropic(), model: "model-a",
    });
    const b = await runPrimaryReview({
      evidence: EVIDENCE, octokit: fakeOctokit, owner: "o", repo: "r",
      anthropic: makeFakeAnthropic(), model: "model-a",
    });
    const c = await runPrimaryReview({
      evidence: EVIDENCE, octokit: fakeOctokit, owner: "o", repo: "r",
      anthropic: makeFakeAnthropic(), model: "model-b",
    });

    expect(a.executionProfile.configurationFingerprint)
      .toBe(b.executionProfile.configurationFingerprint);
    expect(c.executionProfile.configurationFingerprint)
      .not.toBe(a.executionProfile.configurationFingerprint);
  });
});

// ── Verifier instrumentation ─────────────────────────────────────────────────

describe("Phase 10 C: verifier invocation execution profile", () => {

  it("records its own separate profile with verifier prompt identity", async () => {
    const receipt = await runApprovalVerification({
      evidence: EVIDENCE, octokit: fakeOctokit, owner: "o", repo: "r",
      anthropic: makeFakeVerifierAnthropic({ observedModel: "ver-observed" }),
      model: "ver-requested",
    });

    expect(receipt.status).toBe("verified");
    expect(receipt.executionProfile.requestedModel).toBe("ver-requested");
    expect(receipt.executionProfile.observedModel).toBe("ver-observed");
    expect(receipt.executionProfile.adapter).toBe("anthropic-sdk-verifier");
    expect(receipt.executionProfile.promptId).toBe("v2-verifier-r2");
    expect(receipt.executionProfile.terminalState).toBe("completed");
  });

  it("primary and verifier profiles are recorded separately and differ", async () => {
    const primary = await runPrimaryReview({
      evidence: EVIDENCE, octokit: fakeOctokit, owner: "o", repo: "r",
      anthropic: makeFakeAnthropic(), model: "shared-model",
    });
    const verifier = await runApprovalVerification({
      evidence: EVIDENCE, octokit: fakeOctokit, owner: "o", repo: "r",
      anthropic: makeFakeVerifierAnthropic(), model: "shared-model",
    });

    expect(primary.executionProfile.adapter).toBe("anthropic-sdk-primary");
    expect(verifier.executionProfile.adapter).toBe("anthropic-sdk-verifier");
    expect(primary.executionProfile.promptId).not.toBe(verifier.executionProfile.promptId);
    expect(primary.executionProfile.configurationFingerprint)
      .not.toBe(verifier.executionProfile.configurationFingerprint);
  });

  it("timeout error maps to terminal timeout on the profile", async () => {
    const anthropic = {
      baseURL: "https://api.fake-provider.test/v1",
      messages: { create: async () => new Promise((_res, rej) => setTimeout(() => rej(new Error("Verifier timed out: LLM call (round 0)")), 5)) },
    };
    const receipt = await runApprovalVerification({
      evidence: EVIDENCE, octokit: fakeOctokit, owner: "o", repo: "r",
      anthropic, model: "m", maxDurationMs: 500,
    });

    expect(receipt.status).toBe("incomplete");
    expect(receipt.executionProfile.terminalState).toBe("timeout");
    expect(receipt.executionProfile.observedModel).toBeNull();
    expect(receipt.executionProfile.identitySource).toBe(IDENTITY_SOURCE.REQUESTED_ONLY);
  });
});

// ── Submission-path billing telemetry (client correction, 2026-08-17) ───────
// The bounded retry (8192 → 16384) and the tool_choice fallback both create
// billable provider responses. Usage must be accounted on EVERY successful
// response BEFORE any response variable is overwritten, and fallback
// attempts must be visible in the diagnostics.

describe("submission-path usage accounting and fallback recording", () => {
  const SUBMIT_INPUT_PRIMARY = {
    findings: [], unresolvedContextNeeds: [],
    overallCorrectness: "correct", overallConfidence: "high", summary: "clean",
  };
  const SUBMIT_INPUT_VERIFIER = {
    status: "verified", findings: [], riskLedger: completeClearedLedger("changed:src/one.js@HEAD:L1-L2"), coverageSatisfied: true,
  };

  it("primary: a retried submission accounts for BOTH responses' usage", async () => {
    let call = 0;
    const anthropic = {
      baseURL: "https://api.fake-provider.test/v1",
      messages: {
        create: async () => {
          call += 1;
          if (call === 1) {
            return { model: "m", stop_reason: "end_turn", usage: { input_tokens: 100, output_tokens: 20 },
              content: [{ type: "text", text: "ready" }] };
          }
          if (call === 2) {
            // Narration dies at the cap: no tool_use, max_tokens stop.
            return { model: "m", stop_reason: "max_tokens", usage: { input_tokens: 300, output_tokens: 8192 },
              content: [{ type: "text", text: "narrative tail" }] };
          }
          return { model: "m", stop_reason: "tool_use", usage: { input_tokens: 320, output_tokens: 200 },
            content: [{ type: "tool_use", id: "tu1", name: "submit_review_result", input: SUBMIT_INPUT_PRIMARY }] };
        },
      },
    };
    const receipt = await runPrimaryReview({
      evidence: EVIDENCE, octokit: fakeOctokit, owner: "o", repo: "r",
      anthropic, model: "m",
    });

    expect(receipt.error).toBeUndefined();
    expect(receipt.submissionDiagnostics.submissionRetried).toBe(true);
    // 120 (round) + 8492 (overwritten attempt 1) + 520 (attempt 2) — the
    // first attempt's usage must survive its own overwrite.
    expect(receipt.tokensUsed).toBe(120 + 8492 + 520);
    expect(receipt.executionProfile.usage.inputTokens).toBe(100 + 300 + 320);
    expect(receipt.executionProfile.usage.outputTokens).toBe(20 + 8192 + 200);
    expect(receipt.executionProfile.usage.totalTokens).toBe(receipt.tokensUsed);
  });

  it("primary: a provider tool_choice rejection records the fallback attempt", async () => {
    let call = 0;
    let forcedCalls = 0;
    const anthropic = {
      baseURL: "https://api.fake-provider.test/v1",
      messages: {
        create: async (params) => {
          call += 1;
          if (call === 1) {
            return { model: "m", stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 2 },
              content: [{ type: "text", text: "ready" }] };
          }
          if (params.tool_choice) {
            forcedCalls += 1;
            throw new Error("412 precondition failed: tool_choice not supported");
          }
          return { model: "m", stop_reason: "tool_use", usage: { input_tokens: 50, output_tokens: 10 },
            content: [{ type: "tool_use", id: "tu1", name: "submit_review_result", input: SUBMIT_INPUT_PRIMARY }] };
        },
      },
    };
    const receipt = await runPrimaryReview({
      evidence: EVIDENCE, octokit: fakeOctokit, owner: "o", repo: "r",
      anthropic, model: "m",
    });

    expect(receipt.error).toBeUndefined();
    expect(forcedCalls).toBe(1);
    expect(receipt.submissionDiagnostics.forcedToolFallbackAttempts).toBe(1);
    expect(receipt.submissionDiagnostics.submissionRetried).toBe(false);
  });

  it("verifier: a retried submission accounts for BOTH responses' usage", async () => {
    let call = 0;
    const anthropic = {
      baseURL: "https://api.fake-provider.test/v1",
      messages: {
        create: async () => {
          call += 1;
          if (call === 1) {
            return { model: "m", stop_reason: "end_turn", usage: { input_tokens: 60, output_tokens: 8 },
              content: [{ type: "text", text: "checking" }] };
          }
          if (call === 2) {
            return { model: "m", stop_reason: "max_tokens", usage: { input_tokens: 400, output_tokens: 8192 },
              content: [{ type: "text", text: "narrative" }] };
          }
          return { model: "m", stop_reason: "tool_use", usage: { input_tokens: 410, output_tokens: 90 },
            content: [{ type: "tool_use", id: "tu1", name: "submit_verification_result", input: SUBMIT_INPUT_VERIFIER }] };
        },
      },
    };
    const receipt = await runApprovalVerification({
      evidence: EVIDENCE, octokit: fakeOctokit, owner: "o", repo: "r",
      anthropic, model: "m", maxDurationMs: 5000,
    });

    expect(receipt.status).toBe("verified");
    expect(receipt.submissionDiagnostics.submissionRetried).toBe(true);
    expect(receipt.tokensUsed).toBe(68 + 8592 + 500);
    expect(receipt.executionProfile.usage.totalTokens).toBe(receipt.tokensUsed);
  });

  it("verifier: a provider tool_choice rejection records the fallback attempt", async () => {
    let call = 0;
    let forcedCalls = 0;
    const anthropic = {
      baseURL: "https://api.fake-provider.test/v1",
      messages: {
        create: async (params) => {
          call += 1;
          if (call === 1) {
            return { model: "m", stop_reason: "end_turn", usage: { input_tokens: 20, output_tokens: 4 },
              content: [{ type: "text", text: "checking" }] };
          }
          if (params.tool_choice) {
            forcedCalls += 1;
            throw new Error("400 tool_choice rejected");
          }
          return { model: "m", stop_reason: "tool_use", usage: { input_tokens: 30, output_tokens: 6 },
            content: [{ type: "tool_use", id: "tu1", name: "submit_verification_result", input: SUBMIT_INPUT_VERIFIER }] };
        },
      },
    };
    const receipt = await runApprovalVerification({
      evidence: EVIDENCE, octokit: fakeOctokit, owner: "o", repo: "r",
      anthropic, model: "m", maxDurationMs: 5000,
    });

    expect(receipt.status).toBe("verified");
    expect(forcedCalls).toBe(1);
    expect(receipt.submissionDiagnostics.forcedToolFallbackAttempts).toBe(1);
  });
});
