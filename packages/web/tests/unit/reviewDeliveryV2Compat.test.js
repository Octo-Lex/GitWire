// Forward-port v2 compatibility regression (NodeChain P1 correction).
//
// Proves the anchor-validated body builder feeds valid line/side comments
// into the EXISTING RI-7 mutation manager without modifying the manager:
// submitReview() receives {path, line, side:"RIGHT"} comments — never a
// `position` — for the legacy POST path and the v2 live path alike. No
// LLM, no network; the mutation manager is the real one with a mocked
// Redis + octokit.

import { jest } from "@jest/globals";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(__dirname, "..", "..", "src");

// Read the real buildReviewMarkdown through the module: it is not exported,
// so prove the wiring through reviewPR's legacy path with a full harness,
// and prove manager compatibility by exercising submitReview directly with
// the comment shape the builder produces.

const SMALL_PATCH = ["@@ -1,3 +1,3 @@", " context one", "-old two", "+new two", " context three"].join("\n");

// ── Extract buildReviewMarkdown's comment output via a reviewPR run ────────
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

await jest.unstable_mockModule(path.join(SRC, "lib/db.js"), () => ({ db: { query: mockQuery } }));
await jest.unstable_mockModule(path.join(SRC, "lib/logger.js"), () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), child: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }) },
}));
await jest.unstable_mockModule(path.join(SRC, "services/auditTrailService.js"), () => ({
  Trail: { appendEntry: jest.fn(), aiDecision: jest.fn(), reviewGateBlock: jest.fn() },
}));
await jest.unstable_mockModule(path.join(SRC, "services/pipelineEvents.js"), () => ({
  Events: { record: jest.fn(), ciRunCompleted: jest.fn() },
}));
const mockCreate = jest.fn();
await jest.unstable_mockModule("@anthropic-ai/sdk", () => ({
  default: class { constructor() { this.messages = { create: mockCreate }; } },
}));
await jest.unstable_mockModule(path.join(SRC, "..", "config/index.js"), () => ({
  config: { server: { env: "test" }, anthropic: { apiKey: "test", baseURL: "http://test" }, ai: { model: "test-model" } },
}));
await jest.unstable_mockModule(path.join(SRC, "services/reviewBundleService.js"), () => ({
  buildReviewBundle: jest.fn().mockResolvedValue({ bundle: "b", changedFiles: ["src/app.js"], totalChars: 10 }),
}));
await jest.unstable_mockModule(path.join(SRC, "services/reviewValidator.js"), () => ({
  validateReview: jest.fn().mockImplementation((report) => ({
    valid: true,
    legacy: {
      findings: (report.findings || []).map((f) => ({
        severity: f.priority === "P0" ? "critical" : "high",
        title: f.title, description: f.body || "", suggestion: "",
        file: f.code_location?.file_path || null, line: f.code_location?.line || null,
        confidence: f.confidence,
      })),
      verdict: "request_changes", confidence: "high", summary: "s",
      overallCorrectness: report.overall_correctness, overallConfidence: 0.9,
    },
    keptFindings: [], ignoredFindings: [], schemaErrors: [], scopeDroppedCount: 0,
  })),
}));
await jest.unstable_mockModule(path.join(SRC, "services/reviewHeartbeat.js"), () => ({
  withHeartbeat: jest.fn().mockImplementation(async (fn) => fn()),
}));
await jest.unstable_mockModule(path.join(SRC, "services/adversarialReview.js"), () => ({
  runAdversarialChallenge: jest.fn(), refineFindings: jest.fn(),
}));

const { reviewPR } = await import(path.join(SRC, "services/aiReviewService.js"));
const { createReviewMutationManager } = await import(path.join(SRC, "services/reviewMutationService.js"));
const { buildInlineComments } = await import(path.join(SRC, "services/reviewAnchorResolver.js"));

const REPO = { id: 1, full_name: "octo/repo", owner: { login: "octo" }, name: "repo" };
const CONFIG_ROW = {
  id: 1, enabled: true, check_security: true, check_architecture: true,
  block_on_verdict: ["request_changes"], min_confidence_to_block: "medium",
  max_files_to_review: 30, max_lines_to_review: 2000, ignore_patterns: [],
};

describe("v2 compat: anchor-validated comments into the existing mutation manager", () => {
  it("reviewPR (legacy path) posts {path, line, side} comments — never position", async () => {
    mockQuery.mockReset();
    mockQuery.mockResolvedValueOnce({ rows: [CONFIG_ROW] }).mockResolvedValueOnce({ rows: [{ id: 1 }] }).mockResolvedValue({ rows: [] });
    mockCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: JSON.stringify({
        findings: [{ title: "t", body: "b", priority: "P0", confidence: 0.9, code_location: { file_path: "src/app.js", line: 2 } }],
        overall_correctness: "patch is incorrect", overall_explanation: "e", overall_confidence: 0.9,
      }) }],
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    const oct = mockOctokit({
      "POST /repos/{owner}/{repo}/check-runs": { data: { id: 1 } },
      "GET /repos/{owner}/{repo}/pulls/{pull_number}/files": { data: [{ filename: "src/app.js", status: "modified", additions: 2, deletions: 1, patch: SMALL_PATCH }] },
      "PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}": { data: {} },
      "POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews": { data: { id: 9 } },
    });
    const r = await reviewPR({ pr: { number: 1, head: { sha: "s" }, title: "t", user: { login: "d" }, body: "" }, repository: REPO, octokit: oct });
    expect(r.verdict).toBe("request_changes");
    const post = oct._calls.find((c) => c.route === "POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews");
    expect(post.params.comments).toEqual([expect.objectContaining({ path: "src/app.js", line: 2, side: "RIGHT" })]);
    expect(post.params.comments[0]).not.toHaveProperty("position");
  });

  it("the REAL mutation manager accepts the builder's comment shape unchanged", async () => {
    // buildInlineComments produces the exact objects buildReviewMarkdown now
    // returns; prove the real manager POSTs them verbatim (line/side intact,
    // no position) with mocked Redis + octokit.
    const files = [{ filename: "src/app.js", patch: SMALL_PATCH }];
    const comments = buildInlineComments(
      [{ file: "src/app.js", line: 2, severity: "high", title: "t", description: "d", suggestion: "s" }],
      files
    );
    expect(comments).toHaveLength(1);

    const store = new Map(); // minimal Redis mock: get/set/eval-sha via lua-free CAS emulation
    const redis = {
      get: async (k) => store.get(k) ?? null,
      set: async (k, v) => { store.set(k, v); return "OK"; },
      setex: async (k, ttl, v) => { store.set(k, v); return "OK"; },
      del: async (k) => { store.delete(k); return 1; },
      eval: async () => 1, // CAS succeeds (fresh acquisition)
      keys: async () => [],
      scan: async () => [null, []],
    };
    const posts = [];
    const octokit = {
      request: async (route, params) => {
        posts.push({ route, params });
        if (route === "POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews") return { data: { id: 777 } };
        return { data: [] };
      },
    };
    const manager = createReviewMutationManager({
      redis, octokit, owner: "o", repo: "r", prNumber: 1, headSha: "s", invocationId: "inv-compat-1",
    });
    const result = await manager.submitReview({
      event: "REQUEST_CHANGES", body: "body", commit_id: "s", comments,
    });
    expect(result.reviewId).toBe(777);
    // The manager's marker-recovery probe is a GET (not a mutation); exactly
    // ONE POST carries the comments, verbatim.
    const postCalls = posts.filter((p) => p.route === "POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews");
    expect(postCalls).toHaveLength(1);
    const posted = postCalls[0].params.comments;
    expect(posted).toEqual([expect.objectContaining({ path: "src/app.js", line: 2, side: "RIGHT" })]);
    expect(posted[0]).not.toHaveProperty("position");
    // The manager's file on disk is unchanged by this forward-port.
    const managerSource = fs.readFileSync(path.join(SRC, "services/reviewMutationService.js"), "utf8");
    expect(managerSource).not.toContain("buildInlineComments");
  });

  it("unanchorable findings degrade to body-only in the v2 shape too (manager receives no comments)", async () => {
    const files = [{ filename: "src/app.js", patch: SMALL_PATCH }];
    const comments = buildInlineComments(
      [{ file: "src/app.js", line: 800, severity: "high", title: "t", description: "d" }],
      files
    );
    expect(comments).toEqual([]);
  });
});
