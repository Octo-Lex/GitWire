// tests/evaluation/review-integrity/live-after.test.js
// GitWire-after live matrix — runs reviewPR() with review_integrity_v2='live'.
//
// Same fixture surface as live-baseline.test.js, but the v2 cutover path is
// active: the deterministic decision policy controls the GitHub review event,
// the approval verifier runs independently, and the top-level check state
// comes from RI-6 (not legacy block_on_verdict).
//
// Guarded by REVIEW_INTEGRITY_LIVE=1. Requires ANTHROPIC_API_KEY and
// ANTHROPIC_BASE_URL (real Z.AI endpoint, not mocked).
//
// Results are written to live-after-results.json for side-by-side comparison
// with live-baseline-results.json (the frozen GitWire-before baseline).
//
// Frozen acceptance criteria (per fixture, enforced):
//   Broken: expected material defect detected in ≥2/3 runs
//   Fixed:  zero false P0/P1/P2 findings AND APPROVE in ≥2/3 runs

import { jest } from "@jest/globals";
import { writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertEvidenceWritable,
  writeInvocationRecord,
} from "./liveEvidenceStore.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REVIEW_INTEGRITY_LIVE = process.env.REVIEW_INTEGRITY_LIVE === "1";
const describeOrSkip = REVIEW_INTEGRITY_LIVE ? describe : describe.skip;

// ── Mocks (same as live-baseline, EXCEPT @anthropic-ai/sdk stays real) ───────

const mockDbQuery = jest.fn();

// Captured from persistIntegrityReceipt's UPDATE call — gives us the
// complete v2 finding/verifier receipt set, not just the legacy findings.
let v2Capture = null;

await jest.unstable_mockModule("../../../config/index.js", () => ({
  config: {
    anthropic: {
      apiKey: process.env.ANTHROPIC_API_KEY || "missing",
      baseURL: process.env.ANTHROPIC_BASE_URL || undefined,
    },
    redis: { url: "redis://test" },
    github: { appId: "123", privateKey: "test" },
    server: { baseUrl: "https://gitwire.test" },
  },
}));

await jest.unstable_mockModule("../../../src/lib/logger.js", () => ({
  logger: {
    info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
    child: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
  },
}));

await jest.unstable_mockModule("../../../src/lib/db.js", () => ({ db: { query: mockDbQuery } }));

await jest.unstable_mockModule("../../../src/services/auth/authorize.js", () => ({
  authorize: jest.fn().mockResolvedValue({
    allowed: true, code: "permission_granted", principalId: "test-principal",
    permission: "pull_request:review", resource: { type: "repository" },
  }),
}));

await jest.unstable_mockModule("../../../src/services/auth/decisionLog.js", () => ({
  logDecision: jest.fn().mockResolvedValue(undefined),
  countRecentDisagreements: jest.fn().mockResolvedValue(0),
}));

await jest.unstable_mockModule("../../../src/services/auth/principalResolver.js", () => ({
  getInstallationPrincipal: jest.fn().mockResolvedValue({
    id: "test-principal", principal_type: "installation",
    display_name: "test", status: "active", auth_epoch: 0,
  }),
  getSystemPrincipal: jest.fn().mockResolvedValue(null),
  getPrincipalById: jest.fn().mockResolvedValue(null),
  principalValidityCode: jest.fn(() => "valid"),
}));

await jest.unstable_mockModule("../../../src/lib/queue.js", () => ({
  redis: { setex: jest.fn(), get: jest.fn(), del: jest.fn(), eval: jest.fn().mockResolvedValue(1) },
}));

await jest.unstable_mockModule("../../../src/lib/github.js", () => ({
  getInstallationClient: jest.fn(),
}));

await jest.unstable_mockModule("../../../src/lib/githubWrapper.js", () => ({
  wrapOctokit: (client) => client,
}));

// @anthropic-ai/sdk is NOT mocked — real Z.AI endpoint is used.

await jest.unstable_mockModule("../../../src/services/auditTrailService.js", () => ({
  Trail: {
    aiDecision: jest.fn().mockResolvedValue(undefined),
    reviewGateBlock: jest.fn().mockResolvedValue(undefined),
  },
}));

await jest.unstable_mockModule("../../../src/services/pipelineEvents.js", () => ({
  Events: { ciRunCompleted: jest.fn().mockResolvedValue(undefined) },
}));

await jest.unstable_mockModule("../../../src/services/configService.js", () => ({
  getConfigForRepo: jest.fn().mockResolvedValue({
    pillars: { ai_review: { enabled: true, comment_findings: true } },
    quality_gates: [],
  }),
}));

const { reviewPR } = await import("../../../src/services/aiReviewService.js");
const { getAllFixtures } = await import("./fixtures/registry.js");
const { buildFixtureOctokit } = await import("./fixtureOctokit.js");

// ── Config: production defaults + v2 LIVE + adversarial disabled ─────────────

const BASE_CONFIG = {
  enabled: true,
  check_logic: true, check_security: true, check_architecture: true,
  check_cost_leaks: true, check_tests: true, check_docs: false,
  block_on_verdict: ["request_changes"],
  min_confidence_to_block: "medium",
  max_files_to_review: 30, max_lines_to_review: 2000,
  architecture_context: null,
  ignore_patterns: ["*.lock", "package-lock.json"],
  engine: "claude", model: process.env.ABLATION_MODEL || "glm-5.2",
  max_duration_seconds: 300, bundle_max_chars: 180000, require_file_scope: true,
    // adversarial_review intentionally omitted — frozen target enables it
  review_integrity_v2: "live",
};

function makeRepo() {
  return { id: 999, owner: { login: "org" }, name: "repo", full_name: "org/repo" };
}

function makeV2PR(fixture) {
  return {
    number: 42,
    head: { sha: fixture.prMetadata?.head || "headsha123", ref: "feature" },
    base: { ref: fixture.prMetadata?.base || "main", sha: fixture.prMetadata?.base || "basesha123" },
    user: { login: fixture.prMetadata?.author || "contributor" },
    title: fixture.prMetadata?.title || fixture.title,
    body: fixture.prMetadata?.body || "",
    changed_files: fixture.changedFiles?.length || 1,
  };
}

// ── Expected-defect detection: strict scoring (shared module) ────────────────

import { detectExpectedDefect } from "./expected-defect.js";

// ── Results collector ────────────────────────────────────────────────────────

const allResults = [];

// ── Tests: one per fixture, each runs NUM_RUNS iterations ───────────────────

describeOrSkip("RI live-after — v2 live cutover matrix", () => {
  const NUM_RUNS = 3;
  const fixtures = getAllFixtures();

  // Per-invocation evidence identity — computed only when the suite actually
  // runs (live mode), so skipped/CI imports never shell out to git.
  let CANDIDATE_SHA = null;
  let CANDIDATE_TREE = null;
  let EVIDENCE_ATTEMPT_ID = null;
  const EVIDENCE_RUNS_DIR = join(__dirname, "runs");

  beforeAll(() => {
    CANDIDATE_SHA = execSync("git rev-parse HEAD").toString().trim();
    CANDIDATE_TREE = execSync("git rev-parse HEAD^{tree}").toString().trim();
    // One attempt identity per suite execution: a re-run of the matrix gets
    // its own directory, so records stay immutable without colliding.
    EVIDENCE_ATTEMPT_ID = "attempt-" + new Date().toISOString().replace(/[:.]/g, "-");
  });

  beforeEach(() => {
    jest.clearAllMocks();
    v2Capture = null;
    let reviewId = 1;
    mockDbQuery.mockImplementation((sql, params) => {
      if (sql.includes("ai_review_config")) return { rows: [BASE_CONFIG] };
      if (sql.includes("INSERT INTO ai_reviews")) {
        return { rows: [{ id: reviewId }] };
      }
      if (sql.includes("UPDATE ai_reviews")) {
        // Capture v2 evidence from persistIntegrityReceipt's UPDATE.
        // params[0] = evidence_manifest JSON, params[1] = verification_receipt JSON,
        // params[3] = decision_reason.
        if (sql.includes("evidence_manifest") && Array.isArray(params)) {
          try {
            v2Capture = {
              manifest: JSON.parse(params[0]),
              verifierReceipt: params[1] ? JSON.parse(params[1]) : null,
              decisionReason: params[3] || null,
            };
          } catch (_e) { /* parse failure — v2Capture stays null */ }
        }
        return { rows: [] };
      }
      if (sql.includes("issues")) return { rows: [] };
      if (sql.includes("ci_runs")) return { rows: [] };
      return { rows: [] };
    });
  });

  for (const fixture of fixtures) {
    it(`${fixture.caseId} ${fixture.variant} — frozen threshold (${NUM_RUNS} runs)`, async () => {
      const runs = [];

      for (let run = 1; run <= NUM_RUNS; run++) {
        v2Capture = null;
        const startTime = Date.now();
        const octokit = buildFixtureOctokit(fixture);

        // Fail-closed evidence gate: if any earlier invocation's record could
        // not be persisted, refuse to spend on another provider call.
        assertEvidenceWritable();

        const result = await reviewPR({
          pr: makeV2PR(fixture),
          repository: makeRepo(),
          octokit,
          commentFindings: false,
        });

        const elapsedMs = Date.now() - startTime;

        // Extract primary tokens from the mock DB UPDATE call
        let tokensUsed = 0;
        const updateCalls = mockDbQuery.mock.calls.filter(
          ([sql]) => typeof sql === "string" && sql.includes("UPDATE ai_reviews")
        );
        if (updateCalls.length > 0) {
          const lastCall = updateCalls[updateCalls.length - 1];
          const sql = lastCall[0];
          const params = lastCall[1];
          if (Array.isArray(params)) {
            if (sql.includes("tokens_used = $8")) tokensUsed = params[7] || 0;
            else if (sql.includes("tokens_used = $2")) tokensUsed = params[1] || 0;
          }
        }

        // ── Capture the COMPLETE v2 evidence set ───────────────────────────
        const v2PrimaryFindings = v2Capture?.manifest?.primaryFindings || [];
        const v2VerifierReceipt = v2Capture?.verifierReceipt || null;
        const v2VerifierFindings = v2VerifierReceipt?.findings || [];
        const v2VerifierStatus = v2VerifierReceipt?.status || "not_run";

        // Strict expected-defect scoring: canonical P0/P1/P2 findings only.
        // Unresolved needs satisfy the third-run abstain allowance, never detection.
        const expectedDefectDetected = fixture.expectedFinding
          ? detectExpectedDefect(fixture, { result, v2PrimaryFindings, v2VerifierReceipt })
          : null;

        // Material-finding check across BOTH legacy and v2 severity scales
        const legacyMaterial = (result?.findings || []).some(f =>
          ["critical", "high", "medium"].includes(f.severity));
        const v2Material = [...v2PrimaryFindings, ...v2VerifierFindings].some(f =>
          ["P0", "P1", "P2"].includes(f.severity));

        // Model-identity telemetry (descriptive only). Provider-reported
        // identity NEVER gates run validity — it is not a qualification
        // claim (see the RI boundary). A mismatch is recorded, not enforced.
        const requestedModel = BASE_CONFIG.model;
        const actualModel = result?.primaryMeta?.actualModel || v2VerifierReceipt?.actualModel || null;
        const modelMatch = actualModel === requestedModel;

        // Fixture-surface validity
        const gaps = octokit.fixtureGaps || [];
        const invalidReason = gaps.length > 0
          ? "fixture_gap:" + gaps[0].path
          : null;

        const record = {
          fixture: fixture.caseId,
          variant: fixture.variant,
          run,
          requestedModel,
          actualModel,
          modelMatch,
          invalid: invalidReason,
          v2Mode: "live",
          timestamp: new Date().toISOString(),
          verdict: result?.verdict || "null",
          blocked: result?.blocked || false,
          checkState: result?.checkState || null,
          findingCount: result?.findings?.length || 0,
          findingSeverities: (result?.findings || []).map(f => f.severity || "unknown"),
          findingTitles: (result?.findings || []).map(f => (f.title || "").slice(0, 100)),
          // Complete v2 evidence set
          v2PrimaryFindings: v2PrimaryFindings.map(f => ({ severity: f.severity, claim: (f.claim || "").slice(0, 120) })),
          v2VerifierFindings: v2VerifierFindings.map(f => ({ severity: f.severity, claim: (f.claim || "").slice(0, 120) })),
          v2VerifierStatus,
          v2DecisionReason: v2Capture?.decisionReason,
          expectedDefectDetected,
          tokensUsed,
          latencyMs: elapsedMs,
          falseApprove: fixture.variant === "broken" ? result?.verdict === "approved" : null,
          falsePositive: fixture.variant === "fixed" ? (legacyMaterial || v2Material) : null,
        };

        // Persist this invocation's immutable evidence record IMMEDIATELY —
        // before the loop can reach another paid invocation. A failure here
        // fails the test and poisons the store for every later fixture.
        writeInvocationRecord({
          runsDir: EVIDENCE_RUNS_DIR,
          attemptId: EVIDENCE_ATTEMPT_ID,
          candidateSha: CANDIDATE_SHA,
          candidateTree: CANDIDATE_TREE,
          fixture: fixture.caseId,
          variant: fixture.variant,
          run,
          record,
          manifest: v2Capture?.manifest || null,
          verifierReceipt: v2Capture?.verifierReceipt || null,
          decisionReason: v2Capture?.decisionReason || null,
        });

        runs.push(record);
        allResults.push(record);

        console.log(
          `  ${fixture.caseId} ${fixture.variant} run ${run}: verdict=${record.verdict} ` +
          `checkState=${record.checkState || "n/a"} v2Verifier=${v2VerifierStatus} ` +
          `defect=${expectedDefectDetected} model=${actualModel || "n/a"}` +
          (invalidReason ? " INVALID(" + invalidReason + ")" : "") +
          ` (${record.tokensUsed} tokens, ${record.latencyMs}ms)`
        );
      }

      // ── Run validity: fixture gaps invalidate; model identity is
      // ── descriptive telemetry only and never invalidates a run. ─────────
      const invalidRuns = runs.filter(r => r.invalid);
      expect(invalidRuns).toEqual([]);

      // ── Enforce frozen per-fixture thresholds ──────────────────────────
      if (fixture.variant === "broken") {
        // Frozen requirement: zero false APPROVEs on broken code
        const falseApproves = runs.filter(r => r.verdict === "approved").length;
        expect(falseApproves).toBe(0);

        // Frozen requirement: strict expected-defect detection in ≥2/3 runs
        // (canonical P0/P1/P2 findings only — unresolved needs never count)
        const detections = runs.filter(r => r.expectedDefectDetected === true).length;
        expect(detections).toBeGreaterThanOrEqual(2);

        // Frozen third-run allowance: every non-detecting run must detect OR
        // abstain (review_incomplete) — a silent clean miss is not allowed
        const silentMisses = runs.filter(r =>
          r.expectedDefectDetected !== true && r.checkState !== "review_incomplete");
        expect(silentMisses).toEqual([]);
      } else {
        // Each fixed fixture must produce zero false P0/P1/P2 AND APPROVE in ≥2/3
        const falsePositives = runs.filter(r => r.falsePositive === true).length;
        expect(falsePositives).toBe(0);

        const approves = runs.filter(r => r.verdict === "approved").length;
        expect(approves).toBeGreaterThanOrEqual(2);
      }
    }, 600000); // 10 min for 3 runs
  }

  afterAll(() => {
    if (allResults.length === 0) return;

    const outputPath = join(__dirname, "live-after-results.json");
    writeFileSync(outputPath, JSON.stringify(allResults, null, 2), "utf8");

    const broken = allResults.filter(r => r.variant === "broken");
    const fixed = allResults.filter(r => r.variant === "fixed");
    const falseApproves = broken.filter(r => r.falseApprove === true);
    const falsePositives = fixed.filter(r => r.falsePositive === true);
    const detections = broken.filter(r => r.expectedDefectDetected === true);
    const approves = fixed.filter(r => r.verdict === "approved");

    console.log("\n=== GitWire-after (v2 live) Summary ===");
    console.log(`Broken: ${falseApproves.length}/${broken.length} false APPROVEs`);
    console.log(`Broken: ${detections.length}/${broken.length} expected defect detected`);
    console.log(`Fixed: ${falsePositives.length}/${fixed.length} false positives (P0/P1/P2)`);
    console.log(`Fixed: ${approves.length}/${fixed.length} APPROVEs`);
    console.log(`Avg tokens: ${Math.round(allResults.reduce((s, r) => s + r.tokensUsed, 0) / allResults.length)}`);
    console.log(`Avg latency: ${Math.round(allResults.reduce((s, r) => s + r.latencyMs, 0) / allResults.length)}ms`);

    const byCheckState = {};
    for (const r of allResults) {
      const key = r.checkState || "legacy";
      byCheckState[key] = (byCheckState[key] || 0) + 1;
    }
    console.log("Check states:", JSON.stringify(byCheckState));

    // v2 verifier status breakdown
    const byVerifier = {};
    for (const r of allResults) {
      byVerifier[r.v2VerifierStatus] = (byVerifier[r.v2VerifierStatus] || 0) + 1;
    }
    console.log("Verifier statuses:", JSON.stringify(byVerifier));

    console.log(`\nComparison with GitWire-before baseline:`);
    console.log(`  Before: 11/12 broken false APPROVEs (91.7%), 0/12 defect detection`);
    console.log(`  After:  ${falseApproves.length}/${broken.length} broken false APPROVEs (${Math.round(falseApproves.length / broken.length * 100)}%), ${detections.length}/${broken.length} defect detection`);

    console.log(`\nFrozen threshold enforcement:`);
    for (const fixture of fixtures) {
      const fRuns = allResults.filter(r => r.fixture === fixture.caseId && r.variant === fixture.variant);
      if (fRuns.length === 0) continue;
      const det = fRuns.filter(r => r.expectedDefectDetected === true).length;
      const fp = fRuns.filter(r => r.falsePositive === true).length;
      const ap = fRuns.filter(r => r.verdict === "approved").length;
      if (fixture.variant === "broken") {
        console.log(`  ${fixture.caseId} broken: ${det}/3 defect detections (need ≥2)`);
      } else {
        console.log(`  ${fixture.caseId} fixed: ${ap}/3 APPROVEs (need ≥2), ${fp} false positives (need 0)`);
      }
    }

    console.log(`Results: ${outputPath}`);
  });
});
