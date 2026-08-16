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
await jest.unstable_mockModule("../../src/services/auth/authorize.js", () => ({
  authorize: jest.fn().mockResolvedValue({ allowed: true, code: "ok", principalId: "p" }),
}));
await jest.unstable_mockModule("../../src/services/auth/decisionLog.js", () => ({
  logDecision: jest.fn().mockResolvedValue(undefined),
  countRecentDisagreements: jest.fn().mockResolvedValue(0),
}));
await jest.unstable_mockModule("../../src/services/auth/principalResolver.js", () => ({
  getInstallationPrincipal: jest.fn().mockResolvedValue({ id: "p", principal_type: "installation" }),
  getSystemPrincipal: jest.fn().mockResolvedValue(null),
  getPrincipalById: jest.fn().mockResolvedValue(null),
  principalValidityCode: jest.fn(() => "valid"),
}));
await jest.unstable_mockModule("../../src/lib/github.js", () => ({ getInstallationClient: jest.fn() }));
await jest.unstable_mockModule("../../src/lib/githubWrapper.js", () => ({ wrapOctokit: (c) => c }));
// Minimal Redis for the REAL mutation manager (v2 live path): get/set/
// setex/del/eval(CAS=1)/keys. The manager itself is NOT mocked.
const redisStore = new Map();
await jest.unstable_mockModule("../../src/lib/queue.js", () => ({
  redis: {
    get: async (k) => redisStore.get(k) ?? null,
    set: async (k, v) => { redisStore.set(k, v); return "OK"; },
    setex: async (k, t, v) => { redisStore.set(k, v); return "OK"; },
    del: async (k) => { redisStore.delete(k); return 1; },
    eval: async () => 1,
    keys: async () => [],
  },
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
    redisStore.clear();
    mockQuery.mockResolvedValue({ rows: [] });
  });

  test("THE LINE-800 CASE: unanchorable finding keeps description + suggestion + location in the body", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [LEGACY_CONFIG] }).mockResolvedValueOnce({ rows: [{ id: 1 }] }).mockResolvedValue({ rows: [] });
    mockCreate.mockResolvedValueOnce(modelResponse([
      finding(800, "big-line finding", "THIS DESCRIPTION MUST SURVIVE", "and this suggestion too"),
    ]));

    const oct = mockOctokit({
      "POST /repos/{owner}/{repo}/check-runs": { data: { id: 1 } },
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
    mockQuery.mockResolvedValueOnce({ rows: [LEGACY_CONFIG] }).mockResolvedValueOnce({ rows: [{ id: 2 }] }).mockResolvedValue({ rows: [] });
    mockCreate.mockResolvedValueOnce(modelResponse(six));

    const oct = mockOctokit({
      "POST /repos/{owner}/{repo}/check-runs": { data: { id: 2 } },
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
    mockQuery.mockResolvedValueOnce({ rows: [LEGACY_CONFIG] }).mockResolvedValueOnce({ rows: [{ id: 3 }] }).mockResolvedValue({ rows: [] });
    mockCreate.mockResolvedValueOnce(modelResponse([
      { title: "locationless finding", body: "no file, no line, still a finding", priority: "P1", confidence: 0.9 },
    ]));

    const oct = mockOctokit({
      "POST /repos/{owner}/{repo}/check-runs": { data: { id: 3 } },
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

describe("REAL manager rejection on the v2 live path (blocker 2)", () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockCreate.mockReset();
    redisStore.clear();
    mockQuery.mockImplementation((sql) => {
      if (sql.includes("ai_review_config")) return { rows: [V2_LIVE_CONFIG] };
      if (sql.includes("INSERT INTO ai_reviews")) return { rows: [{ id: 100 }] };
      return { rows: [] };
    });
  });

  test("manager-side 422 → exactly ONE POST, E_REVIEW_DELIVERY, error receipt, FAILURE check, rethrow", async () => {
    mockQuery.mockImplementation(async (sql) => {
      if (sql.includes("ai_review_config")) return { rows: [V2_LIVE_CONFIG] };
      if (sql.includes("INSERT INTO ai_reviews")) return { rows: [{ id: 100 }] };
      return { rows: [] };
    });
    // Primary (no tools) + verifier (with tools) both succeed; the v2
    // decision flows to delivery; the REAL manager's POST is rejected 422.
    mockCreate.mockImplementation((params) => {
      if (params && params.tools && params.tools.length > 0) {
        return Promise.resolve({
          content: [{ type: "text", text: JSON.stringify({ status: "verified", findings: [], unresolvedContextNeeds: [], coverageSatisfied: true }) }],
          usage: { input_tokens: 100, output_tokens: 10 }, stop_reason: "end_turn",
        });
      }
      return Promise.resolve(modelResponse([finding(2, "v2 finding", "v2 description")]));
    });

    const oct = mockOctokit({
      "POST /repos/{owner}/{repo}/check-runs": { data: { id: 20 } },
      "GET /repos/{owner}/{repo}/pulls/{pull_number}/files": FILES_RESPONSE,
      "PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}": { data: {} },
      "GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews": { data: [] },
      "POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews": () => {
        const err = new Error("422 Position could not be resolved");
        err.status = 422;
        throw err;
      },
    });

    const result = await reviewPR({ pr: { number: 5, head: { sha: "s" }, base: { sha: "b", ref: "main" }, title: "t", user: { login: "d" }, body: "" }, repository: REPO, octokit: oct }).catch((e) => ({ __thrown: e }));
    expect(result.__thrown).toMatchObject({ gitwireErrorCode: "E_REVIEW_DELIVERY" });

    // Exactly ONE review POST — the manager's exactly-once semantics hold
    // (no automatic second mutation attempt).
    expect(reviewPosts(oct)).toHaveLength(1);

    // FAILURE check with the truthful delivery title.
    const patches = checkPatches(oct);
    expect(patches.at(-1).params.conclusion).toBe("failure");
    expect(patches.at(-1).params.output.title).toContain("delivery failed");

    // Error receipt persisted.
    const errorUpdate = mockQuery.mock.calls.find((c) => String(c[0]).includes("verdict = 'error'"));
    expect(errorUpdate).toBeTruthy();
    expect(errorUpdate[1][0]).toContain("GitHub review delivery failed");
  });
});
