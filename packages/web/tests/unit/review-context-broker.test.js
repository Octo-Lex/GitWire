// tests/unit/review-context-broker.test.js
// Tests for RI-3: Bounded exact-SHA Context Broker.

import { createContextBroker, normalizePath, DEFAULT_BUDGETS } from "../../src/services/reviewContextBroker.js";
import { createHash } from "node:crypto";

const BASE_SHA = "base123";
const HEAD_SHA = "head456";

// Octokit mock that serves content, tree, and blob requests
function makeOctokit(contentMap, treeMap, blobMap) {
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
        throw Object.assign(new Error("404 Not Found: " + path), { status: 404 });
      }

      // GET /git/trees/{sha}?recursive=1
      if (route.includes("GET") && route.includes("/git/trees/")) {
        const sha = params.tree_sha;
        if (treeMap.has(sha)) {
          return { data: { sha, tree: treeMap.get(sha), truncated: false } };
        }
        return { data: { sha, tree: [], truncated: false } };
      }

      // GET /git/blobs/{sha}
      if (route.includes("GET") && route.includes("/git/blobs/")) {
        const sha = params.file_sha;
        if (blobMap.has(sha)) {
          const content = blobMap.get(sha);
          return {
            data: {
              sha,
              encoding: "base64",
              content: Buffer.from(content, "utf-8").toString("base64"),
            },
          };
        }
        throw new Error("404 Blob not found: " + sha);
      }

      return { data: {} };
    },
  };
}

function makeBroker(contentMap = new Map(), treeMap = new Map(), blobMap = new Map(), budgets) {
  const octokit = makeOctokit(contentMap, treeMap, blobMap);
  const broker = createContextBroker({
    octokit, owner: "org", repo: "repo", baseSha: BASE_SHA, headSha: HEAD_SHA, budgets,
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
    expect(result.truncated).toBe(false);
  });

  it("reads a file at the base SHA", async () => {
    const map = new Map([[BASE_SHA + ":src/app.js", "old version"]]);
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

  it("enforces maxFileReads and records budget-denied in trace", async () => {
    const map = new Map();
    map.set(HEAD_SHA + ":file0.js", "x");
    map.set(HEAD_SHA + ":file1.js", "x");
    map.set(HEAD_SHA + ":file2.js", "x");
    const { broker } = makeBroker(map, new Map(), new Map(), { maxFileReads: 2, maxRetrievedChars: 10000 });

    const r1 = await broker.readRepoFile("file0.js", HEAD_SHA);
    const r2 = await broker.readRepoFile("file1.js", HEAD_SHA);
    const r3 = await broker.readRepoFile("file2.js", HEAD_SHA);

    expect(r1.error).toBeUndefined();
    expect(r2.error).toBeUndefined();
    expect(r3.error).toBe("budget_exceeded");
    expect(r3.reason).toBe("max_file_reads_exceeded");

    // Budget-denied attempt must appear in trace
    const trace = broker.getTrace();
    const deniedEntry = trace.find(t => t.result === "budget_exceeded");
    expect(deniedEntry).toBeDefined();
    expect(deniedEntry.reason).toBe("max_file_reads_exceeded");
    expect(deniedEntry.path).toBe("file2.js");
  });

  it("enforces maxRetrievedChars — truncated read has explicit bounded-partial representation", async () => {
    const content = "a".repeat(100);
    const map = new Map([[HEAD_SHA + ":file.js", content]]);
    const { broker } = makeBroker(map, new Map(), new Map(), { maxRetrievedChars: 50, maxFileReads: 10 });

    const r1 = await broker.readRepoFile("file.js", HEAD_SHA);

    expect(r1.error).toBeUndefined();
    expect(r1.content.length).toBe(50);
    expect(r1.truncated).toBe(true); // explicit bounded-partial marker
    expect(r1.range).toBeDefined(); // range records what was represented

    const r2 = await broker.readRepoFile("file.js", HEAD_SHA);
    expect(r2.error).toBe("budget_exceeded");
    expect(r2.reason).toBe("max_retrieved_chars_exceeded");
  });

  it("enforces maxContextRounds and traces the denial", async () => {
    const map = new Map([[HEAD_SHA + ":file.js", "x"]]);
    const { broker } = makeBroker(map, new Map(), new Map(), { maxContextRounds: 1, maxFileReads: 10, maxRetrievedChars: 10000 });

    const r1 = await broker.readRepoFile("file.js", HEAD_SHA);
    expect(r1.error).toBeUndefined();
    broker.endRound();

    const r2 = await broker.readRepoFile("file.js", HEAD_SHA);
    expect(r2.error).toBe("budget_exceeded");
    expect(r2.reason).toBe("max_context_rounds_exceeded");

    const trace = broker.getTrace();
    const denied = trace.find(t => t.result === "budget_exceeded" && t.reason === "max_context_rounds_exceeded");
    expect(denied).toBeDefined();
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
    expect(trace[0].resolvedSha).toBe(HEAD_SHA);
    expect(trace[0].blobSha).toBe("blobsha_src/x.js");
    expect(trace[0].contentDigest).toMatch(/^sha256:/);
    expect(trace[0].result).toBe("ok");
  });

  it("records truncated reads as ok_truncated", async () => {
    const content = "a".repeat(100);
    const map = new Map([[HEAD_SHA + ":big.js", content]]);
    const { broker } = makeBroker(map, new Map(), new Map(), { maxRetrievedChars: 50, maxFileReads: 10 });

    await broker.readRepoFile("big.js", HEAD_SHA);

    const trace = broker.getTrace();
    expect(trace[0].result).toBe("ok_truncated");
    expect(trace[0].truncated).toBe(true);
  });
});

// ── searchRepoText (exact-SHA) ───────────────────────────────────────────────

describe("RI-3: searchRepoText (exact-SHA tree search)", () => {

  it("searches blob content at the exact SHA and returns immutable identity", async () => {
    const tree = [
      { path: "src/found.js", type: "blob", sha: "blobsha_found" },
      { path: "src/other.js", type: "blob", sha: "blobsha_other" },
    ];
    const blobs = new Map([
      ["blobsha_found", "function found() { return true; }"],
      ["blobsha_other", "function other() { return false; }"],
    ]);
    const { broker } = makeBroker(new Map(), new Map([[HEAD_SHA, tree]]), blobs);

    const result = await broker.searchRepoText("found", HEAD_SHA);

    expect(result.error).toBeUndefined();
    expect(result.results).toHaveLength(1);
    expect(result.results[0].path).toBe("src/found.js");
    expect(result.results[0].resolvedSha).toBe(HEAD_SHA);
    expect(result.results[0].blobSha).toBe("blobsha_found");
    expect(result.results[0].contentDigest).toMatch(/^sha256:/);
    expect(result.results[0].line).toBe(1);
    expect(result.results[0].fragment).toContain("found");
  });

  it("rejects invalid ref for search", async () => {
    const { broker } = makeBroker();
    const result = await broker.searchRepoText("query", "main");
    expect(result.error).toBe("invalid_ref");
  });

  it("enforces maxSearches and traces the denial", async () => {
    const tree = [{ path: "f.js", type: "blob", sha: "s" }];
    const blobs = new Map([["s", "content"]]);
    const { broker } = makeBroker(new Map(), new Map([[HEAD_SHA, tree]]), blobs, { maxSearches: 1, maxRetrievedChars: 10000 });

    const r1 = await broker.searchRepoText("content", HEAD_SHA);
    const r2 = await broker.searchRepoText("more", HEAD_SHA);

    expect(r1.error).toBeUndefined();
    expect(r2.error).toBe("budget_exceeded");
    expect(r2.reason).toBe("max_searches_exceeded");

    const trace = broker.getTrace();
    const denied = trace.find(t => t.type === "repo_search" && t.result === "budget_exceeded");
    expect(denied).toBeDefined();
  });

  it("search respects the char budget — stops when budget would be exceeded", async () => {
    const tree = [
      { path: "a.js", type: "blob", sha: "sha_a" },
      { path: "b.js", type: "blob", sha: "sha_b" },
    ];
    const longContent = "match ".repeat(100); // 600 chars
    const blobs = new Map([
      ["sha_a", longContent],
      ["sha_b", longContent],
    ]);
    // Set a very small char budget so only one result fits
    const { broker } = makeBroker(new Map(), new Map([[HEAD_SHA, tree]]), blobs, {
      maxSearches: 5, maxSearchResults: 10, maxRetrievedChars: 700, maxFileReads: 10,
    });

    const result = await broker.searchRepoText("match", HEAD_SHA);

    expect(result.error).toBeUndefined();
    // Only 1 result should fit in the budget (each fragment ~500 chars)
    expect(result.results.length).toBeLessThanOrEqual(2);
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
