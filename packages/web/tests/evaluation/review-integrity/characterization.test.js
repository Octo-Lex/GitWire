// tests/evaluation/review-integrity/characterization.test.js
// Deterministic current-engine characterization suite.
//
// This suite asserts the EXACT current unsafe behavior of the review
// pipeline. It is a characterization test, not a regression gate — it
// documents what the engine does NOW so baseline drift is visible.
//
// When the v2 implementation lands, these tests will fail because the
// behavior changes. At that point they become the "before" record and
// the v2 contract suite (contract.test.js) becomes the gate.
//
// The mock LLM returns zero findings for every fixture. This simulates
// the worst case: the primary reviewer misses the defect entirely.

import { jest } from "@jest/globals";
import { getAllFixtures, getBrokenFixtures, getFixedFixtures } from "./fixtures/registry.js";
import { buildFixtureOctokit } from "./fixtureOctokit.js";

// ── Mocks ────────────────────────────────────────────────────────────────────

const mockAnthropicCreate = jest.fn();

await jest.unstable_mockModule("../../../config/index.js", () => ({
  config: {
    anthropic: { apiKey: "test-key", baseURL: "http://test" },
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

const mockDbQuery = jest.fn();
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

await jest.unstable_mockModule("@anthropic-ai/sdk", () => ({
  default: class { messages = { create: mockAnthropicCreate }; },
}));

await jest.unstable_mockModule("../../../src/services/telegramNotifyService.js", () => ({
  notifyTriage: jest.fn().mockResolvedValue(undefined),
}));

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

// ── Helpers ──────────────────────────────────────────────────────────────────

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

/** Mock LLM returning zero findings (clean review). */
function mockCleanReview() {
  mockAnthropicCreate.mockResolvedValue({
    content: [{
      type: "text",
      text: JSON.stringify({
        findings: [],
        overall_correctness: "patch is correct",
        overall_explanation: "The changes look clean and correct.",
        overall_confidence: 0.9,
      }),
    }],
    usage: { input_tokens: 5000, output_tokens: 200 },
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockDbQuery.mockImplementation((sql) => {
    if (sql.includes("ai_review_config")) return { rows: [BASE_CONFIG] };
    if (sql.includes("ai_reviews")) return { rows: [{ id: 1 }] };
    return { rows: [] };
  });
  mockCleanReview();
});

// ── Characterization: broken fixtures produce false APPROVE ─────────────────

describe("RI characterization — current engine (pre-v2)", () => {
  const brokenFixtures = getBrokenFixtures();

  describe("broken fixtures with clean LLM (misses defect)", () => {
    for (const f of brokenFixtures) {
      it(`${f.caseId}: current engine APPROVES — this is the unsafe baseline`, async () => {
        const octokit = buildFixtureOctokit(f);
        const result = await reviewPR({
          pr: makePR(f),
          repository: makeRepo(),
          octokit,
          commentFindings: false,
        });

        // Characterization: current engine falsely approves ALL broken fixtures
        expect(result).not.toBeNull();
        expect(result.verdict).toBe("approved");
        expect(result.findings).toHaveLength(0);
        expect(result.blocked).toBe(false);
      });
    }
  });

  describe("fixed fixtures with clean LLM", () => {
    const fixedFixtures = getFixedFixtures();
    for (const f of fixedFixtures) {
      it(`${f.caseId}: current engine APPROVES — correct for clean code`, async () => {
        const octokit = buildFixtureOctokit(f);
        const result = await reviewPR({
          pr: makePR(f),
          repository: makeRepo(),
          octokit,
          commentFindings: false,
        });

        expect(result).not.toBeNull();
        expect(result.verdict).toBe("approved");
      });
    }
  });
});
