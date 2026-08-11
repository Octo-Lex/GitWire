// tests/unit/review-context-broker.test.js
// Tests for RI-3: Bounded exact-SHA Context Broker.
//
// All tests are deterministic — no network. The octokit mock serves
// content from a map, simulating the GitHub contents API.

import { createContextBroker, normalizePath, DEFAULT_BUDGETS } from "../../src/services/reviewContextBroker.js";
import { createHash } from "node:crypto";

// ── Helpers ──────────────────────────────────────────────────────────────────

const BASE_SHA = "base123";
const HEAD_SHA = "head456";

function makeOctokit(contentMap) {
  return {
    request: async (route, params) => {
      // GET /contents/{path}
      if (route.includes("GET") && route.includes("/contents/")) {
        const path = params.path || "";
        const ref = params.ref || HEAD_SHA;
        const key = ref + ":" + path;
        if (contentMap.has(key)) {
          const content = contentMap.get(key);
          return {
            data: {
              type: "file",
              encoding: "base64",
              content: Buffer.from(content, "utf-8").toString("base64"),
              path,
              sha: "blobsha_" + path,
            },
          };
        }
        throw new Error("404 Not Found: " + path);
      }

      // GET /search/code
      if (route.includes("GET") && route.includes("/search/code")) {
        return {
          data: {
            total_count: 1,
            items: [
              {
                path: "src/found.js",
                text_matches: [{ fragment: "function found() { return true; }" }],
              },
            ],
          },
        };
      }

      return { data: {} };
    },
  };
}

function makeBroker(contentMap = new Map(), budgets) {
  const octokit = makeOctokit(contentMap);
  const broker = createContextBroker({
    octokit,
    owner: "org",
    repo: "repo",
    baseSha: BASE_SHA,
    headSha: HEAD_SHA,
    budgets,
  });
  return { broker, octokit };
}

// ── Path safety ──────────────────────────────────────────────────────────────

describe("RI-3: normalizePath", () => {
  it("accepts normal relative paths", () => {
    expect(normalizePath("src/app.js")).toBe("src/app.js");
    expect(normalizePath("docs/guide.md")).toBe("docs/guide.md");
  });

  it("rejects path traversal with ..", () => {
    expect(normalizePath("../../../etc/passwd")).toBeNull();
    expect(normalizePath("src/../../../etc/passwd")).toBeNull();
    expect(normalizePath("foo/../../bar")).toBeNull();
  });

  it("rejects absolute paths", () => {
    expect(normalizePath("/etc/passwd")).toBeNull();
    expect(normalizePath("C:/Windows/System32")).toBeNull();
  });

  it("rejects null bytes", () => {
    expect(normalizePath("file.js\0malicious")).toBeNull();
  });

  it("normalizes backslashes and strips ./ prefixes", () => {
    expect(normalizePath("src\\app.js")).toBe("src/app.js");
    expect(normalizePath("./src/app.js")).toBe("src/app.js");
  });
});

// ── readRepoFile ─────────────────────────────────────────────────────────────

describe("RI-3: readRepoFile", () => {
  it("reads a file at the head SHA and returns immutable identity", async () => {
    const content = "export function app() { return 'hello'; }";
    const map = new Map([[HEAD_SHA + ":src/app.js", content]]);
    const { broker } = makeBroker(map);

    const result = await broker.readRepoFile("src/app.js", HEAD_SHA);

    expect(result.error).toBeUndefined();
    expect(result.path).toBe("src/app.js");
    expect(result.ref).toBe(HEAD_SHA);
    expect(result.resolvedSha).toBe(HEAD_SHA);
    expect(result.blobSha).toBe("blobsha_src/app.js");
    expect(result.contentDigest).toBe("sha256:" + createHash("sha256").update(content, "utf-8").digest("hex"));
    expect(result.content).toBe(content);
  });

  it("reads a file at the base SHA", async () => {
    const content = "old version";
    const map = new Map([[BASE_SHA + ":src/app.js", content]]);
    const { broker } = makeBroker(map);

    const result = await broker.readRepoFile("src/app.js", BASE_SHA);

    expect(result.error).toBeUndefined();
    expect(result.ref).toBe(BASE_SHA);
    expect(result.content).toBe("old version");
  });

  it("rejects a ref that is not baseSha or headSha", async () => {
    const { broker } = makeBroker();

    const result = await broker.readRepoFile("src/app.js", "main");

    expect(result.error).toBe("invalid_ref");
    expect(result.permittedRefs).toEqual([BASE_SHA, HEAD_SHA]);
  });

  it("rejects unsafe paths", async () => {
    const { broker } = makeBroker();

    const result = await broker.readRepoFile("../../../etc/passwd", HEAD_SHA);

    expect(result.error).toBe("invalid_path");
  });

  it("returns not_found for non-existent files", async () => {
    const { broker } = makeBroker(new Map());

    const result = await broker.readRepoFile("missing.js", HEAD_SHA);

    expect(result.error).toBe("not_found");
  });

  it("supports line range retrieval", async () => {
    const content = "line1\nline2\nline3\nline4\nline5";
    const map = new Map([[HEAD_SHA + ":data.txt", content]]);
    const { broker } = makeBroker(map);

    const result = await broker.readRepoFile("data.txt", HEAD_SHA, { range: { startLine: 2, endLine: 4 } });

    expect(result.error).toBeUndefined();
    expect(result.content).toBe("line2\nline3\nline4");
    expect(result.range).toEqual({ startLine: 2, endLine: 4 });
  });
});

// ── Budget enforcement ───────────────────────────────────────────────────────

describe("RI-3: budget enforcement", () => {

  it("enforces maxFileReads", async () => {
    const map = new Map();
    map.set(HEAD_SHA + ":file0.js", "x");
    map.set(HEAD_SHA + ":file1.js", "x");
    map.set(HEAD_SHA + ":file2.js", "x");
    const { broker } = makeBroker(map, { maxFileReads: 2, maxRetrievedChars: 10000 });

    const r1 = await broker.readRepoFile("file0.js", HEAD_SHA);
    const r2 = await broker.readRepoFile("file1.js", HEAD_SHA);
    const r3 = await broker.readRepoFile("file2.js", HEAD_SHA);

    expect(r1.error).toBeUndefined();
    expect(r2.error).toBeUndefined();
    expect(r3.error).toBe("budget_exceeded");
    expect(r3.reason).toBe("max_file_reads_exceeded");
  });

  it("enforces maxRetrievedChars (truncates last read to fit)", async () => {
    const content = "a".repeat(100);
    const map = new Map([[HEAD_SHA + ":file.js", content]]);
    const { broker } = makeBroker(map, { maxRetrievedChars: 50, maxFileReads: 10 });

    const r1 = await broker.readRepoFile("file.js", HEAD_SHA);

    // Content should be truncated to 50 chars
    expect(r1.error).toBeUndefined();
    expect(r1.content.length).toBe(50);

    const r2 = await broker.readRepoFile("file.js", HEAD_SHA);
    expect(r2.error).toBe("budget_exceeded");
    expect(r2.reason).toBe("max_retrieved_chars_exceeded");
  });

  it("enforces maxContextRounds", async () => {
    const map = new Map([[HEAD_SHA + ":file.js", "x"]]);
    const { broker } = makeBroker(map, { maxContextRounds: 1, maxFileReads: 10, maxRetrievedChars: 10000 });

    // Round 1
    const r1 = await broker.readRepoFile("file.js", HEAD_SHA);
    expect(r1.error).toBeUndefined();
    broker.endRound();

    // Round 2 — should be blocked
    const r2 = await broker.readRepoFile("file.js", HEAD_SHA);
    expect(r2.error).toBe("budget_exceeded");
    expect(r2.reason).toBe("max_context_rounds_exceeded");
  });

  it("budget state tracks consumption", async () => {
    const map = new Map([[HEAD_SHA + ":file.js", "hello"]]);
    const { broker } = makeBroker(map);

    await broker.readRepoFile("file.js", HEAD_SHA);

    const state = broker.getBudgetState();
    expect(state.fileReads).toBe(1);
    expect(state.retrievedChars).toBe(5);
    expect(state.exhausted).toBe(false);
  });
});

// ── Retrieval trace ──────────────────────────────────────────────────────────

describe("RI-3: retrieval trace", () => {

  it("records every read with immutable identity", async () => {
    const content = "export const x = 1;";
    const map = new Map([[HEAD_SHA + ":src/x.js", content]]);
    const { broker } = makeBroker(map);

    await broker.readRepoFile("src/x.js", HEAD_SHA);

    const trace = broker.getTrace();
    expect(trace).toHaveLength(1);
    expect(trace[0].type).toBe("file_read");
    expect(trace[0].path).toBe("src/x.js");
    expect(trace[0].resolvedSha).toBe(HEAD_SHA);
    expect(trace[0].blobSha).toBe("blobsha_src/x.js");
    expect(trace[0].contentDigest).toMatch(/^sha256:/);
    expect(trace[0].result).toBe("ok");
  });

  it("records failed reads and budget-exceeded events", async () => {
    const { broker } = makeBroker(new Map(), { maxFileReads: 2, maxRetrievedChars: 10000 });

    await broker.readRepoFile("missing.js", HEAD_SHA);    // not_found (1st read)
    await broker.readRepoFile("also-missing.js", HEAD_SHA); // not_found (2nd read)
    const r3 = await broker.readRepoFile("third.js", HEAD_SHA); // budget exceeded (3rd blocked)

    const trace = broker.getTrace();
    expect(trace).toHaveLength(2); // only 2 reads recorded (third was blocked before trace)
    expect(trace[0].result).toBe("not_found");
    expect(trace[1].result).toBe("not_found");
    expect(r3.error).toBe("budget_exceeded");
  });
});

// ── searchRepoText ───────────────────────────────────────────────────────────

describe("RI-3: searchRepoText", () => {

  it("returns search results with paths", async () => {
    const { broker } = makeBroker();

    const result = await broker.searchRepoText("found", HEAD_SHA);

    expect(result.error).toBeUndefined();
    expect(result.results).toHaveLength(1);
    expect(result.results[0].path).toBe("src/found.js");
    expect(result.results[0].ref).toBe(HEAD_SHA);
  });

  it("rejects invalid ref for search", async () => {
    const { broker } = makeBroker();

    const result = await broker.searchRepoText("query", "main");

    expect(result.error).toBe("invalid_ref");
  });

  it("enforces maxSearches", async () => {
    const { broker } = makeBroker(new Map(), { maxSearches: 1 });

    const r1 = await broker.searchRepoText("query1", HEAD_SHA);
    const r2 = await broker.searchRepoText("query2", HEAD_SHA);

    expect(r1.error).toBeUndefined();
    expect(r2.error).toBe("budget_exceeded");
    expect(r2.reason).toBe("max_searches_exceeded");
  });
});

// ── Constructor validation ───────────────────────────────────────────────────

describe("RI-3: constructor validation", () => {

  it("throws when required fields are missing", () => {
    expect(() => createContextBroker({ octokit: {}, owner: "o", repo: "r", baseSha: "b" }))
      .toThrow("headSha");
    expect(() => createContextBroker({ octokit: {}, owner: "o", repo: "r", headSha: "h" }))
      .toThrow("baseSha");
    expect(() => createContextBroker({ owner: "o", repo: "r", baseSha: "b", headSha: "h" }))
      .toThrow("octokit");
  });
});
