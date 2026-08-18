// Shared truncation semantics and audit trace (RI-9 amendment, Phase 4).
// A partial result must remain partial through tool → transcript →
// ReviewEvidence → approval calculation → receipt.

import { prepareRepository } from "../../../src/lib/repositoryTools/repositorySession.js";
import { createRepositoryTools } from "../../../src/lib/repositoryTools/index.js";
import { makeResult } from "../../../src/lib/repositoryTools/contract.js";
import { windowTextLines, boundItems, propagatePartial, assertPartialityPreserved } from "../../../src/lib/repositoryTools/truncation.js";
import { buildSnapshotSource } from "./helpers.js";

const LINES = ["alpha", "beta line", "gamma", "delta", "epsilon"];

describe("windowTextLines", () => {
  it("returns the full window with complete=true and no continuation", () => {
    const w = windowTextLines({ lines: LINES, offset: 1, limit: 100, maxBytes: 10000, totalBytes: 100 });
    expect(w.complete).toBe(true);
    expect(w.content).toBe(LINES.join("\n"));
    expect(w.nextOffset).toBeNull();
    expect(w.truncation).toMatchObject({
      totalLines: 5,
      truncated: false,
      truncatedBy: null,
      maxLines: 100,
      continuation: null,
      outputLines: 5,
    });
  });

  it("stops at the line limit with output_lines and a continuation", () => {
    const w = windowTextLines({ lines: LINES, offset: 2, limit: 2, maxBytes: 10000, totalBytes: 100 });
    expect(w.complete).toBe(false);
    expect(w.content).toBe("beta line\ngamma");
    expect(w.nextOffset).toBe(4);
    expect(w.truncation.truncatedBy).toBe("output_lines");
    expect(w.truncation.continuation).toBe(4);
    expect(w.truncation.maxLines).toBe(2);
  });

  it("stops at the byte cap with output_bytes", () => {
    const w = windowTextLines({ lines: LINES, offset: 1, limit: 100, maxBytes: 11, totalBytes: 100 });
    expect(w.complete).toBe(false);
    expect(w.content).toBe("alpha");
    expect(w.truncation.outputBytes).toBe(6);
    expect(w.truncation.truncatedBy).toBe("output_bytes");
  });

  it("a single oversized line yields an empty partial window with continuation at the same offset", () => {
    const w = windowTextLines({ lines: ["x".repeat(100)], offset: 1, limit: 10, maxBytes: 10, totalBytes: 100 });
    expect(w.complete).toBe(false);
    expect(w.outputLines).toBe(0);
    expect(w.content).toBe("");
    expect(w.nextOffset).toBe(1);
    expect(w.truncation.truncatedBy).toBe("output_bytes");
  });

  it("counts UTF-8 bytes, never code units", () => {
    const w = windowTextLines({ lines: ["汉汉汉", "x"], offset: 1, limit: 10, maxBytes: 10, totalBytes: 11 });
    // 汉汉汉 weighs 9 bytes + newline = 10, fits; "x" would exceed the cap.
    expect(w.outputLines).toBe(1);
    expect(w.complete).toBe(false);
    expect(w.truncation.truncatedBy).toBe("output_bytes");
  });

  it("offset beyond EOF is a complete empty window", () => {
    const w = windowTextLines({ lines: LINES, offset: 99, limit: 5, maxBytes: 1000, totalBytes: 100 });
    expect(w.complete).toBe(true);
    expect(w.outputLines).toBe(0);
  });
});

describe("boundItems", () => {
  const weigh = (s) => s.length;

  it("keeps everything when under both budgets", () => {
    const b = boundItems({ items: ["a", "b"], limit: 10, maxBytes: 100, weigh });
    expect(b.kept).toEqual(["a", "b"]);
    expect(b.truncated).toBe(false);
    expect(b.truncatedBy).toBeNull();
    expect(b.partialReasons).toEqual([]);
  });

  it("stops at the item limit with result_limit", () => {
    const b = boundItems({ items: ["a", "b", "c"], limit: 2, maxBytes: 100, weigh });
    expect(b.kept).toEqual(["a", "b"]);
    expect(b.truncatedBy).toBe("result_limit");
    expect(b.dropped).toBe(1);
  });

  it("stops at the byte cap with output_bytes, even at zero items", () => {
    const b = boundItems({ items: ["aaaaa", "b"], limit: 10, maxBytes: 3, weigh });
    expect(b.kept).toEqual([]);
    expect(b.truncatedBy).toBe("output_bytes");
    expect(b.partialReasons).toEqual(["output_bytes"]);
  });
});

describe("partiality propagation", () => {
  const SESSION = { id: "s", headSha: "b".repeat(40), snapshotRefs: null };

  it("a partial result survives a JSON round-trip without losing partiality", () => {
    const result = makeResult({
      operation: "grep", session: SESSION, status: "partial",
      startedAt: performance.now(),
      partialReasons: ["output_bytes", "result_limit"],
      data: { matches: [] },
    });
    const propagated = propagatePartial(result);
    const throughTranscript = JSON.parse(JSON.stringify(propagated));
    const throughEvidence = JSON.parse(JSON.stringify(throughTranscript));
    const throughReceipt = JSON.parse(JSON.stringify(throughEvidence));
    expect(throughReceipt.completeness).toBe("partial:output_bytes+result_limit");
    expect(assertPartialityPreserved(result, throughReceipt)).toBe(true);
  });

  it("a downstream layer flattening a partial to complete is caught", () => {
    const result = makeResult({
      operation: "grep", session: SESSION, status: "partial",
      startedAt: performance.now(),
      partialReasons: ["timeout"],
      data: { matches: [] },
    });
    const flattened = { ...propagatePartial(result), completeness: "complete", complete: true };
    expect(() => assertPartialityPreserved(result, flattened)).toThrow(/corrupted/);
  });

  it("success and error results propagate their exact states", () => {
    const success = makeResult({ operation: "ls", session: SESSION, status: "success", startedAt: performance.now(), data: { entries: [] } });
    const error = makeResult({ operation: "read", session: SESSION, status: "error", startedAt: performance.now(), error: { code: "E_PATH_NOT_FOUND", message: "x" } });
    expect(propagatePartial(success).completeness).toBe("complete");
    expect(propagatePartial(error).completeness).toBe("error:E_PATH_NOT_FOUND");
  });
});

describe("audit trace integration", () => {
  let session;
  let tools;

  beforeAll(async () => {
    const head = await buildSnapshotSource({ "a.txt": "alpha\nbeta\n", "b.md": "beta\n" }, { ref: "audit" });
    session = await prepareRepository({
      invocationId: "audit-suite",
      headSha: "audit",
      acquire: { mode: "snapshot", headTree: head, blobs: head.blobs },
    });
    tools = createRepositoryTools(session);
  });

  afterAll(() => session?.close?.());

  it("records every envelope-returning operation with completeness and budget use", async () => {
    await tools.read({ path: "a.txt", limit: 1 });
    await tools.grep({ pattern: "beta", limit: 1 });
    await tools.find({});
    await tools.ls({ path: "." });
    const badPath = await tools.read({ path: "../escape" });

    const trace = session.auditTrace();
    expect(trace).toHaveLength(5);
    expect(trace[0]).toMatchObject({
      operation: "read",
      status: "partial",
      complete: false,
      partialReasons: ["output_lines"],
      params: { path: "a.txt", limit: 1 },
    });
    expect(trace[1]).toMatchObject({ operation: "grep", status: "partial", partialReasons: ["result_limit"] });
    expect(trace[2]).toMatchObject({ operation: "find", status: "success", complete: true });
    expect(trace[3]).toMatchObject({ operation: "ls", status: "success" });
    expect(trace[4]).toMatchObject({ operation: "read", status: "error", errorCode: "E_PATH_ESCAPE" });
    for (const entry of trace) {
      expect(entry.durationMs).toBeGreaterThanOrEqual(0);
      expect(typeof entry.returnedBytes).toBe("number");
    }
    // The trace itself is JSON-serializable for receipts.
    expect(() => JSON.parse(JSON.stringify(trace))).not.toThrow();
  });

  it("summarizes signals without serializing them", async () => {
    const controller = new AbortController();
    controller.abort();
    await tools.grep({ pattern: "beta", signal: controller.signal });
    const entry = session.auditTrace().at(-1);
    expect(entry.params.signal).toBe("aborted");
  });
});
