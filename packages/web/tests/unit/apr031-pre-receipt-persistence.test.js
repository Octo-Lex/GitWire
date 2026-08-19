// tests/unit/apr031-pre-receipt-persistence.test.js
// APR-031 (Durable Operation Brackets) — Attempt-3 correction A.
// Proves deterministically, with zero provider calls completing, that a
// primary pre-receipt failure now leaves a durable typed record: the
// integrity receipt IS persisted (with the primary's terminal provider_error
// execution profile and a sanitized classification) BEFORE the fail-closed
// throw fires. Before this correction, such invocations vanished with no
// receipt (Attempt 3 classes E and the RI-02-fixed-run-2 anomaly).

import { jest } from "@jest/globals";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(__dirname, "..", "..", "src");

const SMALL_PATCH = ["@@ -1,3 +1,3 @@", " context one", "-old two", "+new two", " context three"].join("\n");

const mockQuery = jest.fn();
function mockOctokit() {
  const calls = [];
  return {
    request: async (route, params) => {
      calls.push({ route, params });
      if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}/files") {
        return { data: [{ filename: "src/app.js", status: "modified", additions: 2, deletions: 1, patch: SMALL_PATCH, sha: "blobsha1" }] };
      }
      if (route.startsWith("GET /repos/{owner}/{repo}/git/blobs/")) {
        return { data: { type: "file", encoding: "base64", content: Buffer.from("line one\nline two\n").toString("base64"), sha: "blobsha1" } };
      }
      if (route === "POST /repos/{owner}/{repo}/check-runs") return { data: { id: 1 } };
      if (route.startsWith("PATCH /repos/{owner}/{repo}/check-runs")) return { data: {} };
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
await jest.unstable_mockModule(path.join(SRC, "services/reviewHeartbeat.js"), () => ({
  withHeartbeat: jest.fn().mockImplementation(async (fn) => fn()),
}));

const { reviewPR } = await import(path.join(SRC, "services/aiReviewService.js"));

const REPO = { id: 1, full_name: "octo/repo", owner: { login: "octo" }, name: "repo" };
const PR = { number: 7, head: { sha: "headsha".padEnd(40, "0"), ref: "b" }, base: { sha: "basesha".padEnd(40, "0"), ref: "main" }, title: "t", user: { login: "d" }, body: "", changed_files: 1 };
const CONFIG_ROW = {
  id: 1, enabled: true, check_security: true, check_architecture: true,
  block_on_verdict: ["request_changes"], min_confidence_to_block: "medium",
  max_files_to_review: 30, max_lines_to_review: 2000, ignore_patterns: [],
  review_integrity_v2: "live",
};

describe("APR-031 correction A: pre-receipt primary failure leaves a durable typed record", () => {
  it("persists a terminal receipt with provider_error profile and sanitized reason, then still throws fail-closed", async () => {
    mockQuery.mockReset();
    mockQuery.mockResolvedValueOnce({ rows: [CONFIG_ROW] })   // config SELECT
      .mockResolvedValueOnce({ rows: [{ id: 42 }] })          // INSERT ai_reviews
      .mockResolvedValue({ rows: [] });                        // UPDATEs and everything else
    mockCreate.mockReset();
    // Provider capacity-style failure on the primary's FIRST call.
    mockCreate.mockRejectedValue(new Error("429 quota exceeded for this window"));

    const oct = mockOctokit();

    // reviewPR converts a primary failure into a fail-closed result (this is
    // the shape Attempt 3's zero-token records carry); the correction's claim
    // is that a durable receipt now exists underneath it.
    const result = await reviewPR({ pr: PR, repository: REPO, octokit: oct, commentFindings: false });
    expect(result.verdict).toBe("needs_discussion");
    expect(result.checkState).toBe("review_incomplete");
    expect(result.primaryMeta.error).toMatch(/429 quota exceeded/);

    // The durable record: an UPDATE carrying the evidence manifest…
    const updateCall = mockQuery.mock.calls.find(
      ([sql]) => typeof sql === "string" && sql.includes("UPDATE ai_reviews") && sql.includes("evidence_manifest")
    );
    expect(updateCall).toBeDefined();

    const manifest = JSON.parse(updateCall[1][0]);
    // …with the primary's terminal provider_error profile persisted.
    expect(manifest.executionProfiles.primary.terminalState).toBe("provider_error");
    expect(manifest.executionProfiles.verifier).toBeNull();

    // …and the sanitized classification in the decision reason.
    const reason = updateCall[1][3];
    expect(reason).toMatch(/^primary pre-receipt failure: LLM invocation failed: 429 quota exceeded/);
  });

  it("sanitizes credential-shaped material out of the persisted classification", async () => {
    mockQuery.mockReset();
    mockQuery.mockResolvedValueOnce({ rows: [CONFIG_ROW] })
      .mockResolvedValueOnce({ rows: [{ id: 43 }] })
      .mockResolvedValue({ rows: [] });
    mockCreate.mockReset();
    mockCreate.mockRejectedValue(new Error("401 unauthorized: key sk-abcdef1234567890 rejected"));

    const oct = mockOctokit();
    const result = await reviewPR({ pr: PR, repository: REPO, octokit: oct, commentFindings: false });
    expect(result.checkState).toBe("review_incomplete");

    const updateCall = mockQuery.mock.calls.find(
      ([sql]) => typeof sql === "string" && sql.includes("UPDATE ai_reviews") && sql.includes("evidence_manifest")
    );
    expect(updateCall).toBeDefined();
    const reason = updateCall[1][3];
    expect(reason).toContain("sk-<redacted>");
    expect(reason).not.toContain("sk-abcdef1234567890");
  });
});
