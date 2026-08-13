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

import { jest } from "@jest/globals";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REVIEW_INTEGRITY_LIVE = process.env.REVIEW_INTEGRITY_LIVE === "1";
const describeOrSkip = REVIEW_INTEGRITY_LIVE ? describe : describe.skip;

// ── Mocks (same as live-baseline, EXCEPT @anthropic-ai/sdk stays real) ───────

const mockDbQuery = jest.fn();

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
  engine: "claude", model: "claude-sonnet-4-20250514",
  max_duration_seconds: 300, bundle_max_chars: 180000, require_file_scope: true,
  adversarial_review: false,
  review_integrity_v2: "live",  // ← v2 cutover active
};

function makeRepo() {
  return { id: 999, owner: { login: "org" }, name: "repo", full_name: "org/repo" };
}

// V2-compatible PR builder — includes base.sha and changed_files
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

// ── Results collector ────────────────────────────────────────────────────────

const allResults = [];

// ── Tests ────────────────────────────────────────────────────────────────────

describeOrSkip("RI live-after — v2 live cutover matrix", () => {
  const NUM_RUNS = 3;
  const fixtures = getAllFixtures();

  beforeEach(() => {
    jest.clearAllMocks();
    let reviewId = 1;
    mockDbQuery.mockImplementation((sql, params) => {
      if (sql.includes("ai_review_config")) return { rows: [BASE_CONFIG] };
      if (sql.includes("INSERT INTO ai_reviews")) {
        return { rows: [{ id: reviewId }] };
      }
      if (sql.includes("UPDATE ai_reviews")) {
        return { rows: [] };
      }
      if (sql.includes("issues")) return { rows: [] };
      if (sql.includes("ci_runs")) return { rows: [] };
      return { rows: [] };
    });
  });

  for (const fixture of fixtures) {
    for (let run = 1; run <= NUM_RUNS; run++) {
      it(`${fixture.caseId} ${fixture.variant} run ${run}/${NUM_RUNS}`, async () => {
        const startTime = Date.now();
        const octokit = buildFixtureOctokit(fixture);

        const result = await reviewPR({
          pr: makeV2PR(fixture),
          repository: makeRepo(),
          octokit,
          commentFindings: false,
        });

        const elapsedMs = Date.now() - startTime;

        // Extract tokens from the mock DB UPDATE call
        let tokensUsed = 0;
        const updateCalls = mockDbQuery.mock.calls.filter(
          ([sql]) => typeof sql === "string" && sql.includes("UPDATE ai_reviews")
        );
        if (updateCalls.length > 0) {
          const lastCall = updateCalls[updateCalls.length - 1];
          const sql = lastCall[0];
          const params = lastCall[1];
          if (Array.isArray(params)) {
            if (sql.includes("tokens_used = $8")) {
              tokensUsed = params[7] || 0;
            } else if (sql.includes("tokens_used = $2")) {
              tokensUsed = params[1] || 0;
            }
          }
        }

        // Expected defect detection (same criteria as live-baseline)
        let expectedDefectDetected = null;
        if (fixture.expectedFinding) {
          const findings = result?.findings || [];
          const allFindingText = findings
            .map(f => ((f.title || "") + " " + (f.description || f.body || "")).toLowerCase())
            .join(" ");

          switch (fixture.caseId) {
            case "RI-01":
              expectedDefectDetected =
                (allFindingText.includes("synchron") || allFindingText.includes("stale") ||
                 allFindingText.includes("contradict") || allFindingText.includes("inconsisten")) &&
                (allFindingText.includes("status") || allFindingText.includes("phase") ||
                 allFindingText.includes("declaration") || allFindingText.includes("readme") ||
                 allFindingText.includes("constitution"));
              break;
            case "RI-02":
              expectedDefectDetected =
                (allFindingText.includes("gate") || allFindingText.includes("exit")) &&
                (allFindingText.includes("agent") || allFindingText.includes("replace") ||
                 allFindingText.includes("restart"));
              break;
            case "RI-03":
              expectedDefectDetected =
                allFindingText.includes("basepath") || allFindingText.includes("base path") ||
                allFindingText.includes("/dashboard") || allFindingText.includes("url") &&
                (allFindingText.includes("path") || allFindingText.includes("config"));
              break;
            case "RI-04":
              expectedDefectDetected =
                allFindingText.includes("paginat") || allFindingText.includes("pagination") ||
                allFindingText.includes("duplicate comment") ||
                (allFindingText.includes("page") && allFindingText.includes("comment"));
              break;
            default:
              expectedDefectDetected = false;
          }
        }

        const record = {
          fixture: fixture.caseId,
          variant: fixture.variant,
          run,
          model: BASE_CONFIG.model,
          v2Mode: "live",
          timestamp: new Date().toISOString(),
          verdict: result?.verdict || "null",
          blocked: result?.blocked || false,
          checkState: result?.checkState || null,
          findingCount: result?.findings?.length || 0,
          findingSeverities: (result?.findings || []).map(f => f.severity || "unknown"),
          findingTitles: (result?.findings || []).map(f => (f.title || "").slice(0, 100)),
          expectedDefectDetected,
          tokensUsed,
          latencyMs: elapsedMs,
          falseApprove: fixture.variant === "broken" ? result?.verdict === "approved" : null,
          falsePositive: fixture.variant === "fixed"
            ? (result?.findings || []).some(f => ["critical", "high", "medium"].includes(f.severity))
            : null,
        };

        allResults.push(record);

        const status = record.falseApprove === true ? "FALSE APPROVE" :
                       record.falseApprove === false ? "correctly avoided" :
                       record.falsePositive === true ? "FALSE POSITIVE" :
                       record.falsePositive === false ? "clean" :
                       record.verdict;
        console.log(
          `  ${fixture.caseId} ${fixture.variant} run ${run}: verdict=${record.verdict} ` +
          `checkState=${record.checkState || "n/a"} (${record.tokensUsed} tokens, ${record.latencyMs}ms) — ${status}`
        );
      }, 180000); // 3 min timeout — v2 adds verifier LLM call
    }
  }

  afterAll(() => {
    if (allResults.length === 0) return;

    const outputPath = join(__dirname, "live-after-results.json");
    writeFileSync(outputPath, JSON.stringify(allResults, null, 2), "utf8");

    const broken = allResults.filter(r => r.variant === "broken");
    const fixed = allResults.filter(r => r.variant === "fixed");
    const falseApproves = broken.filter(r => r.falseApprove === true);
    const falsePositives = fixed.filter(r => r.falsePositive === true);

    console.log("\n=== GitWire-after (v2 live) Summary ===");
    console.log(`Broken: ${falseApproves.length}/${broken.length} false APPROVEs`);
    console.log(`Broken: ${broken.filter(r => r.expectedDefectDetected === true).length}/${broken.length} expected defect detected`);
    console.log(`Fixed: ${falsePositives.length}/${fixed.length} false positives`);
    console.log(`Avg tokens: ${Math.round(allResults.reduce((s, r) => s + r.tokensUsed, 0) / allResults.length)}`);
    console.log(`Avg latency: ${Math.round(allResults.reduce((s, r) => s + r.latencyMs, 0) / allResults.length)}ms`);

    // v2-specific breakdown
    const byCheckState = {};
    for (const r of allResults) {
      const key = r.checkState || "legacy";
      byCheckState[key] = (byCheckState[key] || 0) + 1;
    }
    console.log("Check states:", JSON.stringify(byCheckState));

    console.log(`\nComparison with GitWire-before baseline:`);
    console.log(`  Before: 11/12 broken false APPROVEs (91.7%), 0/12 defect detection`);
    console.log(`  After:  ${falseApproves.length}/${broken.length} broken false APPROVEs (${Math.round(falseApproves.length / broken.length * 100)}%), ${broken.filter(r => r.expectedDefectDetected === true).length}/${broken.length} defect detection`);
    console.log(`Results: ${outputPath}`);
  });
});
