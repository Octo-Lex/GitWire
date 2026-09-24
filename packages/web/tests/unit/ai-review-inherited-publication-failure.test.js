// tests/unit/ai-review-inherited-publication-failure.test.js
// Defect-sensitive regression for #247 / PR #251: a same-head invocation that
// reaches the publication claim and observes an inherited terminal failed state
// must return an explicit unavailable result, not the legacy bare-null sentinel.

import { beforeEach, describe, expect, it, jest } from "@jest/globals";

const mockQuery = jest.fn();
const mockCreate = jest.fn();

await jest.unstable_mockModule("../../src/lib/db.js", () => ({ db: { query: mockQuery } }));
await jest.unstable_mockModule("../../src/lib/logger.js", () => ({
  logger: {
    info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
    child: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
  },
}));
await jest.unstable_mockModule("../../src/services/auditTrailService.js", () => ({
  Trail: { appendEntry: jest.fn(), aiDecision: jest.fn(), reviewGateBlock: jest.fn() },
}));
await jest.unstable_mockModule("../../src/services/pipelineEvents.js", () => ({
  Events: { record: jest.fn(), ciRunCompleted: jest.fn() },
}));
await jest.unstable_mockModule("../../config/index.js", () => ({
  config: {
    server: { env: "test", baseUrl: "https://gitwire.example" },
    anthropic: { apiKey: "test", baseURL: "http://test" },
    ai: { model: "test-model" },
  },
}));
await jest.unstable_mockModule("@anthropic-ai/sdk", () => ({
  default: class { constructor() { this.messages = { create: mockCreate }; } },
}));
await jest.unstable_mockModule("@gitwire/rules", () => ({
  extractReviewJSON: jest.fn(() => ({ json: { ok: true }, strategy: "json" })),
  buildReviewSystemPrompt: jest.fn(() => "system"),
  reportToLegacy: jest.fn(),
}));
await jest.unstable_mockModule("../../src/services/reviewBundleService.js", () => ({
  buildReviewBundle: jest.fn().mockResolvedValue({
    bundle: "bundle", changedFiles: ["src/a.js"], totalChars: 6,
    coverageAdjustments: [], fileSections: [{ path: "src/a.js", text: "diff" }],
    reassemble: () => ({ bundle: "bundle", coverageAdjustments: [] }),
  }),
}));
await jest.unstable_mockModule("../../src/services/reviewTokenAccounting.js", () => ({
  countInputTokens: jest.fn().mockResolvedValue(1000),
  classifyProviderRejection: jest.fn(() => "other"),
  MAX_PRIMARY_INPUT_TOKENS: 958016,
}));
await jest.unstable_mockModule("../../src/services/reviewValidator.js", () => ({
  validateReview: jest.fn(() => ({
    valid: true,
    legacy: {
      findings: [], verdict: "approved", confidence: "high", summary: "clean",
      overallCorrectness: "patch is correct", overallConfidence: 0.95,
    },
    ignoredFindings: [], schemaErrors: [], scopeDroppedCount: 0,
  })),
}));
await jest.unstable_mockModule("../../src/services/reviewHeartbeat.js", () => ({
  withHeartbeat: jest.fn(async (fn) => fn()),
}));
await jest.unstable_mockModule("../../src/services/adversarialReview.js", () => ({
  runAdversarialChallenge: jest.fn(), refineFindings: jest.fn(),
}));
await jest.unstable_mockModule("../../src/services/adversarialDefense.js", () => ({
  runDefensePass: jest.fn(), refineWithDefense: jest.fn(),
}));
await jest.unstable_mockModule("../../src/services/reviewAnchorResolver.js", () => ({
  buildInlineComments: jest.fn(() => []),
  partitionAnchored: jest.fn(() => ({ anchored: [], bodyOnly: [] })),
  renderBodyOnlyDetails: jest.fn(() => []),
}));
await jest.unstable_mockModule("../../src/services/reviewPublicationPolicy.js", () => ({
  resolveReviewPublication: jest.fn(() => ({
    judgment: "APPROVE", publishedOutcome: "APPROVE", integrityState: "COMPLETE",
    authorityState: "ADVISORY", publicationMode: "advisory", policyBlocked: false,
    githubReviewEvent: "COMMENT",
  })),
}));
await jest.unstable_mockModule("../../src/services/reviewCoverageService.js", () => ({
  buildFileCoverage: jest.fn(() => ({
    files: [{ filename: "src/a.js", patch: "+x" }],
    coverage: { files: [{ path: "src/a.js", coverage: "full" }], totalChangedFiles: 1, limitsExceeded: [] },
    totalAdded: 1, totalRemoved: 0,
  })),
  finalizeCoverage: jest.fn((coverage) => ({ ...coverage, approvalEvidenceComplete: true })),
  coverageSummaryLine: jest.fn(() => "Evidence complete"),
}));
await jest.unstable_mockModule("../../src/services/reviewEvidenceService.js", () => ({
  buildEvidenceReceipts: jest.fn(() => ({ receipts: [], materialEvidenceValid: true })),
}));

const { reviewPR } = await import("../../src/services/aiReviewService.js");

const cfg = {
  id: 1, enabled: true, check_security: true, check_architecture: true,
  block_on_verdict: ["request_changes"], min_confidence_to_block: "medium",
  max_files_to_review: 30, max_lines_to_review: 2000, ignore_patterns: [],
  adversarial_review: false, publication_mode: "advisory",
};

beforeEach(() => {
  jest.clearAllMocks();
  mockCreate.mockResolvedValue({
    content: [{ type: "text", text: "{}" }], usage: { input_tokens: 10, output_tokens: 5 },
  });
  mockQuery.mockImplementation(async (sql) => {
    const text = String(sql);
    if (text.includes("SELECT * FROM ai_review_config")) return { rows: [cfg] };
    if (text.includes("INSERT INTO ai_reviews")) {
      return { rows: [{
        id: 100, publication_state: null, github_review_id: null, verdict: null,
        published_outcome: null, judgment: null, integrity_state: null, policy_blocked: false,
      }] };
    }
    if (text.includes("publication_claimed_at = NOW()")) return { rows: [] };
    if (text.includes("SELECT publication_state, github_review_id")) {
      return { rows: [{
        publication_state: "failed", github_review_id: null, verdict: "error",
        published_outcome: null, judgment: null, integrity_state: null, policy_blocked: false,
        terminal_reason: "delivery_failure",
        summary: "GitHub review delivery failed: prior exact-head publication was rejected",
      }] };
    }
    throw new Error("Unexpected DB query in inherited-publication regression: " + text);
  });
});

describe("reviewPR inherited failed publication", () => {
  it("returns explicit unavailable and preserves the durable failure reason", async () => {
    const calls = [];
    const octokit = {
      request: jest.fn(async (route, params) => {
        calls.push({ route, params });
        if (route === "POST /repos/{owner}/{repo}/check-runs") return { data: { id: 77 } };
        if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}/files") {
          return { data: [{ filename: "src/a.js", status: "modified", additions: 1, deletions: 0, patch: "+x" }] };
        }
        if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}") {
          return { data: { head: { sha: "abc123" } } };
        }
        if (route === "PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}") return { data: {} };
        throw new Error("Unexpected Octokit route: " + route);
      }),
    };

    const result = await reviewPR({
      pr: {
        number: 42, head: { sha: "abc123", ref: "feature" }, base: { ref: "main" },
        title: "test", body: "", user: { login: "dev" },
      },
      repository: { id: 123, full_name: "acme/app", owner: { login: "acme" }, name: "app" },
      octokit,
    });

    expect(result).toEqual({
      unavailable: true, verdict: "error", blocked: false, findings: [],
      reason: "delivery_failure",
      error: "GitHub review delivery failed: prior exact-head publication was rejected",
    });
    expect(calls.some((call) => call.route === "POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews")).toBe(false);

    const finalized = calls.find((call) => call.route === "PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}");
    expect(finalized.params.conclusion).toBe("neutral");
    expect(finalized.params.output.title).toBe("⚠️ AI review publication previously failed");
    expect(finalized.params.output.summary).toContain("prior exact-head publication was rejected");
  });
});
