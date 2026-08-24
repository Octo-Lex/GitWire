// Body-detail retention + real-manager rejection regressions (review
// correction for PR #143, COMMENT 4947206601).
//
// Blocker 1: a finding NOT emitted inline — unanchorable, no location, or
// beyond the inline cap — must carry its description, suggestion, and
// location in the review body. The finding is never dropped.
//
// Blocker 2: a GitHub rejection from the REAL RI-7 mutation manager (v2
// live path) remains ONE POST and reaches the same fail-closed delivery
// contract as the legacy POST: E_REVIEW_DELIVERY, error receipt, FAILURE
// check, rethrow. No LLM beyond the harness's scripted Anthropic mock.

import { jest } from "@jest/globals";

const mockQuery = jest.fn();

function mockOctokit(responses = {}) {
  const calls = [];
  return {
    request: async (route, params) => {
      calls.push({ route, params });
      const h = responses[route];
      if (h) return typeof h === "function" ? h(params, calls) : h;
      return { data: {} };
    },
    _calls: calls,
  };
}

const reviewPosts = (oct) => oct._calls.filter((c) => c.route === "POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews");
const checkPatches = (oct) => oct._calls.filter((c) => c.route === "PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}");

await jest.unstable_mockModule("../../src/lib/db.js", () => ({ db: { query: mockQuery } }));
await jest.unstable_mockModule("../../src/lib/logger.js", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), child: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }) },
}));
await jest.unstable_mockModule("../../src/services/auditTrailService.js", () => ({
  Trail: { appendEntry: jest.fn(), aiDecision: jest.fn(), reviewGateBlock: jest.fn() },
}));
await jest.unstable_mockModule("../../src/services/pipelineEvents.js", () => ({
  Events: { record: jest.fn(), ciRunCompleted: jest.fn() },
}));
const mockCreate = jest.fn();
await jest.unstable_mockModule("@anthropic-ai/sdk", () => ({
  default: class { constructor() { this.messages = { create: mockCreate }; } },
}));
await jest.unstable_mockModule("../../config/index.js", () => ({
  config: {
    server: { env: "test", baseUrl: "https://gitwire.test" },
    anthropic: { apiKey: "test", baseURL: "http://test" },
    redis: { url: "redis://test" },
    github: { appId: "123", privateKey: "test" },
    ai: { model: "test-model" },
  },
}));
await jest.unstable_mockModule("../../src/services/reviewBundleService.js", () => ({
  buildReviewBundle: jest.fn().mockResolvedValue({ bundle: "## PR Metadata\nTest PR", changedFiles: ["src/app.js"], totalChars: 50 }),
}));
await jest.unstable_mockModule("../../src/services/reviewValidator.js", () => ({
  validateReview: jest.fn().mockImplementation((report) => {
    const findings = (report.findings || []).map((f) => ({
      severity: f.priority === "P0" ? "critical" : "high",
      title: f.title, description: f.body || "", suggestion: f.suggestion || "",
      file: f.code_location?.file_path || null, line: f.code_location?.line || null,
      confidence: f.confidence,
    }));
    return {
      valid: true,
      legacy: {
        findings,
        verdict: "request_changes", confidence: "high", summary: "s",
        overallCorrectness: report.overall_correctness, overallConfidence: 0.9,
      },
      keptFindings: findings, ignoredFindings: [], schemaErrors: [], scopeDroppedCount: 0,
    };
  }),
}));
await jest.unstable_mockModule("../../src/services/reviewHeartbeat.js", () => ({
  withHeartbeat: jest.fn().mockImplementation(async (fn) => fn()),
}));
await jest.unstable_mockModule("../../src/services/adversarialReview.js", () => ({
  runAdversarialChallenge: jest.fn(), refineFindings: jest.fn(),
}));

const { reviewPR } = await import("../../src/services/aiReviewService.js");

const REPO = { id: 1, full_name: "octo/repo", owner: { login: "octo" }, name: "repo" };
const LEGACY_CONFIG = {
  id: 1, enabled: true, check_security: true, check_architecture: true,
  block_on_verdict: ["request_changes"], min_confidence_to_block: "medium",
  max_files_to_review: 30, max_lines_to_review: 2000, ignore_patterns: [],
};
const V2_LIVE_CONFIG = {
  ...LEGACY_CONFIG, review_integrity_v2: "live",
  check_logic: true, check_cost_leaks: true, check_tests: true, check_docs: false,
  engine: "claude", model: "claude-sonnet-4-20250514",
  max_duration_seconds: 300, bundle_max_chars: 180000, require_file_scope: true,
};

const SMALL_PATCH = ["@@ -1,3 +1,3 @@", " context one", "-old two", "+new two", " context three"].join("\n");
const FILES_RESPONSE = { data: [{ filename: "src/app.js", status: "modified", additions: 2, deletions: 1, patch: SMALL_PATCH }] };

const finding = (line, title, body, suggestion) => ({
  title, body, priority: "P0", confidence: 0.95, category: "security",
  code_location: { file_path: "src/app.js", line },
  ...(suggestion ? { suggestion } : {}),
});

function modelResponse(findings) {
  return {
    content: [{ type: "text", text: JSON.stringify({
      findings,
      overall_correctness: "patch is incorrect",
      overall_explanation: "has findings",
      overall_confidence: 0.9,
    }) }],
    usage: { input_tokens: 10, output_tokens: 5 },
  };
}

describe("body-detail retention (blocker 1)", () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockCreate.mockReset();
    mockQuery.mockImplementation((sql) => (String(sql).includes("publication_claimed_at = NOW()") ? { rows: [{ id: 100 }] } : Promise.resolve({ rows: [] })));
  });

  test("THE LINE-800 CASE: unanchorable finding keeps description + suggestion + location in the body", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [LEGACY_CONFIG] }).mockResolvedValueOnce({ rows: [{ id: 1 }] }).mockImplementation((sql) => (String(sql).includes("publication_claimed_at = NOW()") ? { rows: [{ id: 100 }] } : Promise.resolve({ rows: [] })));
    mockCreate.mockResolvedValueOnce(modelResponse([
      finding(800, "big-line finding", "THIS DESCRIPTION MUST SURVIVE", "and this suggestion too"),
    ]));

    const oct = mockOctokit({
      "POST /repos/{owner}/{repo}/check-runs": { data: { id: 1 } },
      "GET /repos/{owner}/{repo}/pulls/{pull_number}": { data: { head: { sha: "s" } } },
      "GET /repos/{owner}/{repo}/pulls/{pull_number}/files": FILES_RESPONSE,
      "PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}": { data: {} },
      "POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews": { data: { id: 9 } },
    });

    await reviewPR({ pr: { number: 1, head: { sha: "s" }, title: "t", user: { login: "d" }, body: "" }, repository: REPO, octokit: oct });

    const post = reviewPosts(oct)[0];
    expect(post.params.comments).toEqual([]);
    expect(post.params.body).toContain("big-line finding");
    expect(post.params.body).toContain("THIS DESCRIPTION MUST SURVIVE");
    expect(post.params.body).toContain("and this suggestion too");
    expect(post.params.body).toContain("src/app.js:800");
  });

  test("an unanchorable finding BEYOND the five-item summary cap does not disappear", async () => {
    // Six P0 findings: the first five fill the "Key issues" summary cap;
    // the sixth is unanchorable (line 900, beyond the patch). Under the
    // old behavior it vanished entirely — no inline comment, no summary
    // slot. It must now appear in the body-detail section.
    const six = Array.from({ length: 6 }, (_, i) =>
      finding(i < 5 ? 2 : 900, `finding number ${i}`, `description of finding ${i} UNIQUE-${i}`)
    );
    mockQuery.mockResolvedValueOnce({ rows: [LEGACY_CONFIG] }).mockResolvedValueOnce({ rows: [{ id: 2 }] }).mockImplementation((sql) => (String(sql).includes("publication_claimed_at = NOW()") ? { rows: [{ id: 100 }] } : Promise.resolve({ rows: [] })));
    mockCreate.mockResolvedValueOnce(modelResponse(six));

    const oct = mockOctokit({
      "POST /repos/{owner}/{repo}/check-runs": { data: { id: 2 } },
      "GET /repos/{owner}/{repo}/pulls/{pull_number}": { data: { head: { sha: "s" } } },
      "GET /repos/{owner}/{repo}/pulls/{pull_number}/files": FILES_RESPONSE,
      "PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}": { data: {} },
      "POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews": { data: { id: 10 } },
    });

    await reviewPR({ pr: { number: 2, head: { sha: "s" }, title: "t", user: { login: "d" }, body: "" }, repository: REPO, octokit: oct });

    const post = reviewPosts(oct)[0];
    // Five anchorable comments (line 2), the sixth degraded.
    expect(post.params.comments).toHaveLength(5);
    expect(post.params.body).toContain("finding number 5");
    expect(post.params.body).toContain("description of finding 5 UNIQUE-5");
    expect(post.params.body).toContain("src/app.js:900");
  });

  test("a finding with NO location at all still carries its detail in the body", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [LEGACY_CONFIG] }).mockResolvedValueOnce({ rows: [{ id: 3 }] }).mockImplementation((sql) => (String(sql).includes("publication_claimed_at = NOW()") ? { rows: [{ id: 100 }] } : Promise.resolve({ rows: [] })));
    mockCreate.mockResolvedValueOnce(modelResponse([
      { title: "locationless finding", body: "no file, no line, still a finding", priority: "P1", confidence: 0.9 },
    ]));

    const oct = mockOctokit({
      "POST /repos/{owner}/{repo}/check-runs": { data: { id: 3 } },
      "GET /repos/{owner}/{repo}/pulls/{pull_number}": { data: { head: { sha: "s" } } },
      "GET /repos/{owner}/{repo}/pulls/{pull_number}/files": FILES_RESPONSE,
      "PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}": { data: {} },
      "POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews": { data: { id: 11 } },
    });

    await reviewPR({ pr: { number: 3, head: { sha: "s" }, title: "t", user: { login: "d" }, body: "" }, repository: REPO, octokit: oct });

    const post = reviewPosts(oct)[0];
    expect(post.params.body).toContain("locationless finding");
    expect(post.params.body).toContain("no file, no line, still a finding");
  });
});
