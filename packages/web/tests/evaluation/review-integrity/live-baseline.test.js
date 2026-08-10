// tests/evaluation/review-integrity/live-baseline.test.js
// Authoritative live current-model baseline — runs through the ACTUAL
// reviewPR() production pipeline with the real Anthropic model.
//
// Guarded by REVIEW_INTEGRITY_LIVE=1. When disabled, all tests are skipped.
// Requires ANTHROPIC_API_KEY and ANTHROPIC_BASE_URL (or default Anthropic).
//
// This is NOT a Jest regression gate. It is a measurement tool that
// happens to use Jest's module-mocking infrastructure to set up the
// exact same mock surface as the characterization suite, while leaving
// @anthropic-ai/sdk REAL so the actual model is called.
//
// Results are written to live-baseline-results.json.

import { jest } from "@jest/globals";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REVIEW_INTEGRITY_LIVE = process.env.REVIEW_INTEGRITY_LIVE === "1";
const describeOrSkip = REVIEW_INTEGRITY_LIVE ? describe : describe.skip;

// ── Mocks (same as characterization suite, EXCEPT @anthropic-ai/sdk stays real) ─

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
  redis: { setex: jest.fn(), get: jest.fn(), del: jest.fn() },
}));

await jest.unstable_mockModule("../../../src/lib/github.js", () => ({
  getInstallationClient: jest.fn(),
}));

await jest.unstable_mockModule("../../../src/lib/githubWrapper.js", () => ({
  wrapOctokit: (client) => client,
}));

// NOTE: @anthropic-ai/sdk is NOT mocked — the real SDK is used with the
// real API key and base URL. This is the entire point of the live baseline.

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

// ── Config: production defaults with adversarial disabled ──────────────────

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
  adversarial_review: false, // primary-only baseline
};

function makeRepo() {
  return { id: 999, owner: { login: "org" }, name: "repo", full_name: "org/repo" };
}

function makePR(fixture) {
  return {
    number: 42,
    head: { sha: fixture.prMetadata?.head || "headsha123", ref: "feature" },
    base: { ref: fixture.prMetadata?.base || "main" },
    user: { login: fixture.prMetadata?.author || "contributor" },
    title: fixture.prMetadata?.title || fixture.title,
    body: fixture.prMetadata?.body || "",
  };
}

// ── Results collector ────────────────────────────────────────────────────────

const allResults = [];

// ── Tests ────────────────────────────────────────────────────────────────────

describeOrSkip("RI live baseline — production reviewPR() pipeline", () => {
  const NUM_RUNS = 3;
  const fixtures = getAllFixtures();

  beforeEach(() => {
    jest.clearAllMocks();
    // DB mock: return config for ai_review_config, review row for ai_reviews
    let reviewId = 1;
    mockDbQuery.mockImplementation((sql, params) => {
      if (sql.includes("ai_review_config")) return { rows: [BASE_CONFIG] };
      if (sql.includes("INSERT INTO ai_reviews")) {
        return { rows: [{ id: reviewId }] };
      }
      if (sql.includes("UPDATE ai_reviews")) {
        // Tokens are captured from the test's mock.calls inspection below
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

        // Run through the REAL production pipeline
        const result = await reviewPR({
          pr: makePR(fixture),
          repository: makeRepo(),
          octokit,
          commentFindings: false, // no GitHub review mutation
        });

        const elapsedMs = Date.now() - startTime;

        // Extract tokens from the mock DB UPDATE call.
        // Success path: tokens_used = $8 → params[7] (totalTokens)
        // Error path: tokens_used = $2 → params[1]
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
              // Success path: totalTokens is at index 7
              tokensUsed = params[7] || 0;
            } else if (sql.includes("tokens_used = $2")) {
              // Error path: tokensUsed is at index 1
              tokensUsed = params[1] || 0;
            }
          }
        }

        // Expected defect detection: check if any finding matches the
        // expected historical finding by keyword overlap
        let expectedDefectDetected = null;
        if (fixture.expectedFinding) {
          const ef = fixture.expectedFinding;
          // Use significant keywords from the expected finding title
          const expectedKeywords = ef.title.toLowerCase()
            .split(/\s+/)
            .filter(w => w.length > 4)
            .map(w => w.replace(/[^a-z]/g, ""))
            .filter(Boolean);
          expectedDefectDetected = (result?.findings || []).some(f => {
            const findingText = ((f.title || "") + " " + (f.description || f.body || "")).toLowerCase();
            return expectedKeywords.some(kw => findingText.includes(kw));
          });
        }

        const record = {
          fixture: fixture.caseId,
          variant: fixture.variant,
          run,
          model: BASE_CONFIG.model,
          timestamp: new Date().toISOString(),
          verdict: result?.verdict || "null",
          blocked: result?.blocked || false,
          findingCount: result?.findings?.length || 0,
          findingSeverities: (result?.findings || []).map(f => f.severity || "unknown"),
          findingTitles: (result?.findings || []).map(f => (f.title || "").slice(0, 100)),
          expectedDefectDetected,
          tokensUsed,
          latencyMs: elapsedMs,
          // For broken fixtures: was this a false approval?
          falseApprove: fixture.variant === "broken" ? result?.verdict === "approved" : null,
          // For fixed fixtures: was there a false P0/P1/P2?
          falsePositive: fixture.variant === "fixed"
            ? (result?.findings || []).some(f => ["critical", "high", "medium"].includes(f.severity))
            : null,
        };

        allResults.push(record);

        // Log to console for live monitoring
        const status = record.falseApprove === true ? "FALSE APPROVE" :
                       record.falseApprove === false ? "correctly avoided" :
                       record.falsePositive === true ? "FALSE POSITIVE" :
                       record.falsePositive === false ? "clean" :
                       record.verdict;
        console.log(
          `  ${fixture.caseId} ${fixture.variant} run ${run}: ${record.verdict} ` +
          `(${record.tokensUsed} tokens, ${record.latencyMs}ms) — ${status}`
        );
      }, 120000); // 2 min timeout per evaluation
    }
  }

  // After all evaluations: write results and summary
  afterAll(() => {
    if (allResults.length === 0) return;

    const outputPath = join(__dirname, "live-baseline-results.json");
    writeFileSync(outputPath, JSON.stringify(allResults, null, 2), "utf8");

    const broken = allResults.filter(r => r.variant === "broken");
    const fixed = allResults.filter(r => r.variant === "fixed");
    const falseApproves = broken.filter(r => r.falseApprove === true);
    const falsePositives = fixed.filter(r => r.falsePositive === true);

    console.log("\n=== GitWire-before Live Baseline Summary ===");
    console.log(`Broken: ${falseApproves.length}/${broken.length} false APPROVEs`);
    console.log(`Broken: ${broken.filter(r => r.expectedDefectDetected === true).length}/${broken.length} expected defect detected`);
    console.log(`Fixed: ${falsePositives.length}/${fixed.length} false positives`);
    console.log(`Avg tokens: ${Math.round(allResults.reduce((s, r) => s + r.tokensUsed, 0) / allResults.length)}`);
    console.log(`Avg latency: ${Math.round(allResults.reduce((s, r) => s + r.latencyMs, 0) / allResults.length)}ms`);
    console.log(`Results: ${outputPath}`);
  });
});
