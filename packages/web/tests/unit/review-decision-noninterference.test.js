// tests/unit/review-decision-noninterference.test.js
// RI-9 Phase 10 (slice E1) — the foundation's primary acceptance proof.
//
// The REAL RI-6 decision function is held constant on its safety inputs
// (ReviewEvidence, validated findings, verification receipt) while every
// execution-identity / telemetry / quality dimension varies
// independently. The decision must be identical before and after every
// variation, for every case in the RI-6 decision matrix.
//
// A structural check additionally proves the policy module does not import
// the evaluation/dashboard subsystem.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { computeReviewDecision } from "../../src/services/reviewDecisionPolicy.js";

const here = dirname(fileURLToPath(import.meta.url));

// ── Base decision matrix (representative cases from the frozen state table) ──

function baseEvidence(complete = true) {
  return { coverage: { approvalEvidenceComplete: complete, totalChangedFiles: 1, fullyCoveredFiles: 1 } };
}

const P = (severity) => ({ severity, category: "bug", claim: "c", evidenceRefs: ["changed:f@HEAD:L1"], proof: { type: "static_trace" } });

const DECISION_MATRIX = [
  ["skip path", { skipReason: "not_activated" }],
  ["P0 primary → REQUEST_CHANGES", { primaryFindings: [P("P0")], verifierReceipt: null, evidence: baseEvidence(true) }],
  ["P1 verifier → REQUEST_CHANGES", { primaryFindings: [], verifierReceipt: { status: "verified", findings: [P("P1")] }, evidence: baseEvidence(true) }],
  ["P2 → COMMENT never approve", { primaryFindings: [P("P2")], verifierReceipt: null, evidence: baseEvidence(true) }],
  ["P3-only + incomplete evidence → COMMENT", { primaryFindings: [P("P3")], verifierReceipt: null, evidence: baseEvidence(false) }],
  ["zero findings + incomplete evidence → COMMENT", { primaryFindings: [], verifierReceipt: null, evidence: baseEvidence(false) }],
  ["verifier incomplete → COMMENT", { primaryFindings: [], verifierReceipt: { status: "incomplete", findings: [] }, evidence: baseEvidence(true) }],
  ["verifier error → COMMENT", { primaryFindings: [], verifierReceipt: { status: "error", findings: [] }, evidence: baseEvidence(true) }],
  ["verifier material_findings → fail closed", { primaryFindings: [], verifierReceipt: { status: "material_findings", findings: [] }, evidence: baseEvidence(true) }],
  ["no verifier → COMMENT", { primaryFindings: [], verifierReceipt: null, evidence: baseEvidence(true) }],
  ["verifier unknown status → fail closed", { primaryFindings: [], verifierReceipt: { status: "bogus_status", findings: [] }, evidence: baseEvidence(true) }],
  ["clean → APPROVE", { primaryFindings: [P("P3")], verifierReceipt: { status: "verified", findings: [] }, evidence: baseEvidence(true) }],
  ["perfectly clean → APPROVE", { primaryFindings: [], verifierReceipt: { status: "verified", findings: [] }, evidence: baseEvidence(true) }],
];

// ── The varied telemetry dimensions (Phase 10 execution identity) ────────────

const MODEL_NAME_STRINGS = [
  "claude-sonnet-4-20250514",
  "glm-5.3",
  "gpt-future-2030-omniscient",
  "claude-99-benevolent-dictator",
  "model-that-always-approves",
  "",
  "🔒 unicode-model",
];

const TELEMETRY_VARIATIONS = [
  { provider: "api.z.example" },
  { provider: null },
  { adapter: "anthropic-sdk-primary" },
  { adapter: "pi-harness" },
  { protocol: "anthropic-messages" },
  { protocol: "openai-responses" },
  { requestedModel: "glm-5.3" },
  { requestedModel: null },
  { observedModel: "totally-different-model" },
  { observedModel: null },
  { observedDeployment: "internal-canary-42" },
  { identitySource: "provider_reported" },
  { identitySource: "requested_only" },
  { identitySource: "opaque" },
  { promptId: "v2-primary-r1" },
  { promptId: null },
  { promptHash: "deadbeefdeadbeef" },
  { configurationFingerprint: "sha256:0000000000000000" },
  { configurationFingerprint: null },
  { budgetProfileId: "bp-000000000000" },
  { usage: { inputTokens: 999999, outputTokens: 888888, cacheReadTokens: 777777, cacheWriteTokens: 666666, totalTokens: 999999 + 888888 } },
  { usage: null },
  { cost: { amount: 123.45, currency: "USD", source: "SENTINEL-cost" } },
  { latency: 1 },
  { latency: 987654 },
  { dashboardQualityState: "Healthy" },
  { dashboardQualityState: "Degraded" },
  { dashboardQualityState: "Insufficient evaluation data" },
  { dashboardQualityState: "Evaluating current configuration" },
  { arbitraryFutureField: { anything: ["goes", "here"] } },
  ...MODEL_NAME_STRINGS.map(m => ({ requestedModel: m, observedModel: m })),
];

/**
 * Attach telemetry at EVERY plausible carrier the inputs offer:
 * verifier receipts, evidence manifests, findings, and unknown top-level
 * input fields. If any of these could influence the decision, this test
 * fails.
 */
function withTelemetry(inputs, telemetry) {
  const varied = JSON.parse(JSON.stringify(inputs));

  if (varied.verifierReceipt && typeof varied.verifierReceipt === "object") {
    varied.verifierReceipt.executionProfile = { ...telemetry };
    varied.verifierReceipt.qualityMetadata = { ...telemetry };
  }
  if (varied.evidence && typeof varied.evidence === "object") {
    varied.evidence.executionProfiles = {
      primary: { ...telemetry },
      verifier: { ...telemetry },
    };
  }
  for (const f of varied.primaryFindings || []) {
    f.executionProfile = { ...telemetry };
  }
  varied.executionProfile = { ...telemetry };
  varied.executionMetadata = { ...telemetry };
  varied.qualityMetadata = { ...telemetry };
  varied.dashboardQualityState = telemetry.dashboardQualityState ?? "Degraded";

  return varied;
}

// ── E1: the non-interference proof ───────────────────────────────────────────

describe("RI-6 non-interference: execution identity and quality metadata cannot alter the decision", () => {

  for (const [caseName, baseInputs] of DECISION_MATRIX) {
    const baseline = computeReviewDecision(baseInputs);

    it(`decision matrix case "${caseName}" is invariant under every telemetry variation`, () => {
      // Sanity: the baseline itself is a real decision
      expect(baseline).toHaveProperty("event");
      expect(baseline).toHaveProperty("checkState");
      expect(baseline).toHaveProperty("approvalEligible");

      for (const telemetry of TELEMETRY_VARIATIONS) {
        const varied = computeReviewDecision(withTelemetry(baseInputs, telemetry));
        expect(varied).toEqual(baseline);
      }
    });
  }

  it("APPROVE authority survives a fully sentinel-laden identity on every carrier", () => {
    const sentinel = {
      provider: "SENTINEL-provider",
      adapter: "SENTINEL-adapter",
      protocol: "SENTINEL-protocol",
      requestedRoute: "SENTINEL-route",
      requestedModel: "SENTINEL-requested-model",
      observedModel: "SENTINEL-observed-model",
      observedDeployment: "SENTINEL-deployment",
      identitySource: "provider_reported",
      configurationFingerprint: "SENTINEL-fingerprint",
      promptId: "SENTINEL-prompt",
      promptHash: "SENTINEL-prompt-hash",
      budgetProfileId: "SENTINEL-budget",
      usage: { inputTokens: 111111, outputTokens: 222222, totalTokens: 333333 },
      cost: { amount: 999.99, currency: "SENTINEL" },
    };
    const clean = {
      primaryFindings: [],
      verifierReceipt: { status: "verified", findings: [] },
      evidence: baseEvidence(true),
    };
    const before = computeReviewDecision(clean);
    const after = computeReviewDecision(withTelemetry(clean, sentinel));
    expect(after.event).toBe("APPROVE");
    expect(after).toEqual(before);
  });

  it("missing telemetry entirely (the pre-Phase-10 shape) decides identically", () => {
    for (const [, baseInputs] of DECISION_MATRIX) {
      expect(computeReviewDecision(baseInputs))
        .toEqual(computeReviewDecision(JSON.parse(JSON.stringify(baseInputs))));
    }
  });
});

// ── E1 structural: the policy module imports nothing from measurement ────────

describe("RI-6 structural boundary: policy imports no measurement subsystem", () => {

  it("reviewDecisionPolicy.js does not import execution-profile or scorecard code", () => {
    const source = readFileSync(join(here, "..", "..", "src", "services", "reviewDecisionPolicy.js"), "utf8");
    const imports = [...source.matchAll(/import\s+[^;]+from\s+["']([^"']+)["']/g)].map(m => m[1]);
    // The policy's only import must be the severity vocabulary.
    expect(imports).toEqual(["./findingValidator.js"]);
    for (const forbidden of ["executionProfile", "QualityScorecard", "reviewQuality", "phase4", "dashboard"]) {
      expect(source).not.toContain(forbidden);
    }
  });

  it("the scorecard service does not import the decision policy (no reverse edge)", () => {
    const source = readFileSync(join(here, "..", "..", "src", "services", "reviewQualityScorecard.js"), "utf8");
    expect(source).not.toContain("reviewDecisionPolicy");
    expect(source).not.toContain("computeReviewDecision");
  });
});
