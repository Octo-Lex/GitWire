// tests/evaluation/review-integrity/ablation.test.js
// A/B/C causal ablation — separates prompt effect from context/tooling effect
// from model/provider capability.
//
// Arm A: Legacy envelope (current prompt + current primary inputs, no v2)
// Arm B: Prompt correction only (same legacy input data, cross-file framing)
// Arm C: Full production candidate (evidence-bound primary + tools)
//
// Guarded by REVIEW_INTEGRITY_LIVE=1. Requires ANTHROPIC_API_KEY and
// ANTHROPIC_BASE_URL (real Z.AI endpoint).
//
// 1 run × 8 fixtures per arm = 24 total API calls.
// Results written to ablation-results.json.

import { jest } from "@jest/globals";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const LIVE = process.env.REVIEW_INTEGRITY_LIVE === "1";
const describeOrSkip = LIVE ? describe : describe.skip;

// Fixture filter for targeted reruns (comma-separated case IDs, e.g. "RI-03,RI-04")
const FIXTURE_FILTER = process.env.ABLATION_FIXTURES
  ? new Set(process.env.ABLATION_FIXTURES.split(",").map(s => s.trim()))
  : null;

// ── Mocks (same surface as live-after, @anthropic-ai/sdk stays real) ────────

const mockDbQuery = jest.fn();
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
  authorize: jest.fn().mockResolvedValue({ allowed: true, code: "ok", principalId: "p" }),
}));
await jest.unstable_mockModule("../../../src/services/auth/decisionLog.js", () => ({
  logDecision: jest.fn().mockResolvedValue(undefined),
  countRecentDisagreements: jest.fn().mockResolvedValue(0),
}));
await jest.unstable_mockModule("../../../src/services/auth/principalResolver.js", () => ({
  getInstallationPrincipal: jest.fn().mockResolvedValue({ id: "p", principal_type: "installation", display_name: "t", status: "active", auth_epoch: 0 }),
  getSystemPrincipal: jest.fn().mockResolvedValue(null),
  getPrincipalById: jest.fn().mockResolvedValue(null),
  principalValidityCode: jest.fn(() => "valid"),
}));
await jest.unstable_mockModule("../../../src/lib/queue.js", () => ({
  redis: { setex: jest.fn(), get: jest.fn(), del: jest.fn(), eval: jest.fn().mockResolvedValue(1) },
}));
await jest.unstable_mockModule("../../../src/lib/github.js", () => ({ getInstallationClient: jest.fn() }));
await jest.unstable_mockModule("../../../src/lib/githubWrapper.js", () => ({ wrapOctokit: (c) => c }));
await jest.unstable_mockModule("../../../src/services/auditTrailService.js", () => ({
  Trail: { aiDecision: jest.fn().mockResolvedValue(undefined), reviewGateBlock: jest.fn().mockResolvedValue(undefined) },
}));
await jest.unstable_mockModule("../../../src/services/pipelineEvents.js", () => ({
  Events: { ciRunCompleted: jest.fn().mockResolvedValue(undefined) },
}));
await jest.unstable_mockModule("../../../src/services/configService.js", () => ({
  getConfigForRepo: jest.fn().mockResolvedValue({ pillars: { ai_review: { enabled: true } }, quality_gates: [] }),
}));

const { reviewPR } = await import("../../../src/services/aiReviewService.js");
const { getAllFixtures } = await import("./fixtures/registry.js");
const { buildFixtureOctokit } = await import("./fixtureOctokit.js");

// ── Config per arm ───────────────────────────────────────────────────────────

function makeConfig(arm) {
  const overrideModel = process.env.ABLATION_MODEL;
  const base = {
    enabled: true,
    check_logic: true, check_security: true, check_architecture: true,
    check_cost_leaks: true, check_tests: true, check_docs: false,
    block_on_verdict: ["request_changes"], min_confidence_to_block: "medium",
    max_files_to_review: 30, max_lines_to_review: 2000,
    ignore_patterns: ["*.lock", "package-lock.json"],
    engine: "claude", model: overrideModel || "claude-sonnet-4-20250514",
    max_duration_seconds: 300, bundle_max_chars: 180000, require_file_scope: true,
    adversarial_review: false,
  };

  if (arm === "A") {
    // Legacy envelope — no v2, standard prompt
    return { ...base };
  }
  if (arm === "B") {
    // Prompt correction only — legacy path with cross-file framing
    return { ...base, _reviewPromptVariant: "cross_file" };
  }
  // Arm C: full production candidate — v2 live + adversarial enabled (frozen target)
  return { ...base, review_integrity_v2: "live", adversarial_review: true };
}

function makeRepo() {
  return { id: 999, owner: { login: "org" }, name: "repo", full_name: "org/repo" };
}

function makePR(fixture, arm) {
  const pr = {
    number: 42,
    head: { sha: fixture.prMetadata?.head || "headsha123", ref: "feature" },
    base: { ref: fixture.prMetadata?.base || "main" },
    user: { login: fixture.prMetadata?.author || "contributor" },
    title: fixture.prMetadata?.title || fixture.title,
    body: fixture.prMetadata?.body || "",
  };
  // V2 path needs base.sha and changed_files
  if (arm === "C") {
    pr.base.sha = fixture.prMetadata?.base || "basesha123";
    pr.changed_files = fixture.changedFiles?.length || 1;
  }
  return pr;
}

// ── Defect detection (same criteria as live-after) ──────────────────────────

function checkDefect(caseId, text) {
  const t = text.toLowerCase();
  switch (caseId) {
    case "RI-01":
      return (t.includes("synchron") || t.includes("stale") || t.includes("contradict") || t.includes("inconsisten")) &&
        (t.includes("status") || t.includes("phase") || t.includes("declaration") || t.includes("readme") || t.includes("constitution"));
    case "RI-02":
      return (t.includes("gate") || t.includes("exit")) &&
        (t.includes("agent") || t.includes("replace") || t.includes("restart"));
    case "RI-03":
      return t.includes("basepath") || t.includes("base path") || t.includes("/dashboard") ||
        (t.includes("url") && (t.includes("path") || t.includes("config")));
    case "RI-04":
      return t.includes("paginat") || t.includes("duplicate comment") ||
        (t.includes("page") && t.includes("comment"));
    default: return false;
  }
}

// ── Results ──────────────────────────────────────────────────────────────────

const allResults = [];

// ── Tests ────────────────────────────────────────────────────────────────────

describeOrSkip("RI A/B/C ablation — causal attribution", () => {
  const fixtures = getAllFixtures();
  const arms = process.env.ABLATION_ARMS
    ? process.env.ABLATION_ARMS.split(",")
    : ["A", "B", "C"];

  beforeEach(() => {
    jest.clearAllMocks();
    v2Capture = null;
    let reviewId = 1;
    mockDbQuery.mockImplementation((sql, params) => {
      if (sql.includes("ai_review_config")) return { rows: [currentConfig] };
      if (sql.includes("INSERT INTO ai_reviews")) return { rows: [{ id: reviewId }] };
      if (sql.includes("UPDATE ai_reviews")) {
        if (sql.includes("evidence_manifest") && Array.isArray(params)) {
          try {
            v2Capture = {
              manifest: JSON.parse(params[0]),
              verifierReceipt: params[1] ? JSON.parse(params[1]) : null,
              decisionReason: params[3] || null,
            };
          } catch (_e) {}
        }
        return { rows: [] };
      }
      return { rows: [] };
    });
  });

  let currentConfig;

  for (const fixture of fixtures) {
    if (FIXTURE_FILTER && !FIXTURE_FILTER.has(fixture.caseId)) continue;
    for (const arm of arms) {
      it(`${fixture.caseId} ${fixture.variant} arm ${arm}`, async () => {
        currentConfig = makeConfig(arm);
        v2Capture = null;
        const startTime = Date.now();
        const octokit = buildFixtureOctokit(fixture);

        const result = await reviewPR({
          pr: makePR(fixture, arm),
          repository: makeRepo(),
          octokit,
          commentFindings: false,
        });

        const elapsedMs = Date.now() - startTime;

        // Extract tokens
        let tokensUsed = 0;
        const updateCalls = mockDbQuery.mock.calls.filter(
          ([sql]) => typeof sql === "string" && sql.includes("UPDATE ai_reviews")
        );
        if (updateCalls.length > 0) {
          const lastCall = updateCalls[updateCalls.length - 1];
          const sql = lastCall[0], params = lastCall[1];
          if (Array.isArray(params)) {
            if (sql.includes("tokens_used = $8")) tokensUsed = params[7] || 0;
            else if (sql.includes("tokens_used = $2")) tokensUsed = params[1] || 0;
          }
        }

        // V2 evidence (arm C only)
        const v2PrimaryFindings = v2Capture?.manifest?.primaryFindings || [];
        const v2VerifierFindings = v2Capture?.verifierReceipt?.findings || [];
        const v2VerifierStatus = v2Capture?.verifierReceipt?.status || "not_run";

        // Combined finding text for defect detection
        const combinedText = [
          ...(result?.findings || []).map(f => ((f.title || "") + " " + (f.description || "")).toLowerCase()),
          ...v2PrimaryFindings.map(f => (f.claim || "").toLowerCase()),
          ...v2VerifierFindings.map(f => (f.claim || "").toLowerCase()),
        ].join(" ");

        const defectDetected = fixture.expectedFinding
          ? checkDefect(fixture.caseId, combinedText)
          : null;

        const legacyMaterial = (result?.findings || []).some(f => ["critical", "high", "medium"].includes(f.severity));
        const v2Material = [...v2PrimaryFindings, ...v2VerifierFindings].some(f => ["P0", "P1", "P2"].includes(f.severity));

        const record = {
          fixture: fixture.caseId,
          variant: fixture.variant,
          arm,
          timestamp: new Date().toISOString(),
          verdict: result?.verdict || "null",
          checkState: result?.checkState || null,
          findingCount: result?.findings?.length || 0,
          v2PrimaryFindings: v2PrimaryFindings.map(f => ({ severity: f.severity, claim: (f.claim || "").slice(0, 80) })),
          v2VerifierStatus,
          defectDetected,
          tokensUsed,
          latencyMs: elapsedMs,
          // Full diagnostics from primaryReceipt (arm C only)
          primaryMeta: result?.primaryMeta || null,
          falseApprove: fixture.variant === "broken" ? result?.verdict === "approved" : null,
          falsePositive: fixture.variant === "fixed" ? (legacyMaterial || v2Material) : null,
        };
        allResults.push(record);

        console.log(
          `  ${fixture.caseId} ${fixture.variant} arm ${arm}: verdict=${record.verdict} ` +
          `defect=${defectDetected} (${tokensUsed} tokens, ${elapsedMs}ms)`
        );
      }, 300000);
    }
  }

  afterAll(() => {
    if (allResults.length === 0) return;
    const outputPath = join(__dirname, "ablation-results.json");
    writeFileSync(outputPath, JSON.stringify(allResults, null, 2), "utf8");

    console.log("\n=== A/B/C Ablation Summary ===\n");

    for (const arm of arms) {
      const armResults = allResults.filter(r => r.arm === arm);
      const broken = armResults.filter(r => r.variant === "broken");
      const fixed = armResults.filter(r => r.variant === "fixed");
      const falseApproves = broken.filter(r => r.falseApprove === true);
      const detections = broken.filter(r => r.defectDetected === true);
      const falsePositives = fixed.filter(r => r.falsePositive === true);

      const armLabel = arm === "A" ? "Legacy envelope" : arm === "B" ? "Prompt-only" : "Full production";

      console.log(`Arm ${arm} (${armLabel}):`);
      console.log(`  Broken: ${falseApproves.length}/${broken.length} false APPROVEs, ${detections.length}/${broken.length} defect detections`);
      console.log(`  Fixed: ${falsePositives.length}/${fixed.length} false positives`);
      console.log(`  Avg tokens: ${Math.round(armResults.reduce((s, r) => s + r.tokensUsed, 0) / armResults.length)}`);
      console.log("");
    }

    // Causal attribution
    const aDetect = allResults.filter(r => r.arm === "A" && r.variant === "broken" && r.defectDetected).length;
    const bDetect = allResults.filter(r => r.arm === "B" && r.variant === "broken" && r.defectDetected).length;
    const cDetect = allResults.filter(r => r.arm === "C" && r.variant === "broken" && r.defectDetected).length;

    console.log("Causal attribution (broken-fixture defect detection):");
    console.log(`  A (legacy):     ${aDetect}/4`);
    console.log(`  B (prompt-only): ${bDetect}/4`);
    console.log(`  C (production):  ${cDetect}/4`);
    if (bDetect > aDetect) console.log("  → Prompt framing was suppressing detection");
    if (cDetect > bDetect) console.log("  → Repository retrieval was material");
    if (cDetect === 0 && bDetect === 0) console.log("  → Evidence against model/provider strengthens");

    console.log(`\nResults: ${outputPath}`);
  });
});
