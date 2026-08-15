// Envelope boundary (RI-9 amendment correction) — every invocation through
// createRepositoryTools() resolves to a contract envelope. Invalid numeric
// arguments and backend rejections become audited error envelopes; nothing
// escapes the instrument as a thrown exception.

import { prepareRepository } from "../../../src/lib/repositoryTools/repositorySession.js";
import { createRepositoryTools } from "../../../src/lib/repositoryTools/index.js";
import { isAuthoritativeAbsence } from "../../../src/lib/repositoryTools/contract.js";
import { buildSnapshotSource } from "./helpers.js";

let session;
let tools;

beforeAll(async () => {
  const head = await buildSnapshotSource({ "a.txt": "alpha\nbeta\n", "b.md": "beta\n" }, { ref: "boundary" });
  session = await prepareRepository({
    invocationId: "boundary-suite",
    headSha: "boundary",
    acquire: { mode: "snapshot", headTree: head, blobs: head.blobs },
  });
  tools = createRepositoryTools(session);
  // Warm the tracked-index cache so the injected-rejection test exercises
  // the operation's own git invocation, not index loading.
  await tools.find({});
});

afterAll(() => {
  session?.close?.();
});

/** The client-specified assertion set for a boundary error envelope. */
async function expectErrorEnvelope(call, expectedCode) {
  const result = await call();
  expect(result.status).toBe("error");
  expect(result.complete).toBe(false);
  expect(result.data).toBeUndefined();
  expect(isAuthoritativeAbsence(result)).toBe(false);
  expect(result.error.code).toBe(expectedCode);
  expect(result.repositorySessionId).toBe(session.id);
  expect(result.headSha).toBe(session.headSha);
  return result;
}

describe("invalid numeric arguments become audited E_INVALID_INPUT envelopes", () => {
  it.each([
    ["read limit 0", () => tools.read({ path: "a.txt", limit: 0 })],
    ["read negative offset", () => tools.read({ path: "a.txt", offset: -1 })],
    ["read fractional offset", () => tools.read({ path: "a.txt", offset: 1.5 })],
    ["grep limit 0", () => tools.grep({ pattern: "alpha", limit: 0 })],
    ["grep timeoutMs 0", () => tools.grep({ pattern: "alpha", timeoutMs: 0 })],
    ["grep context above max", () => tools.grep({ pattern: "alpha", context: 99 })],
    ["find limit 0", () => tools.find({ limit: 0 })],
    ["ls limit 0", () => tools.ls({ limit: 0 })],
    ["ls fractional limit", () => tools.ls({ path: ".", limit: 1.5 })],
  ])("%s resolves to an error envelope and is audited", async (_name, call) => {
    const result = await expectErrorEnvelope(call, "E_INVALID_INPUT");

    const entry = session.auditTrace().at(-1);
    expect(entry.status).toBe("error");
    expect(entry.complete).toBe(false);
    expect(entry.errorCode).toBe("E_INVALID_INPUT");
    expect(entry.partialReasons).toEqual([]);
    expect(typeof entry.durationMs).toBe("number");
  });

  it("the invalid value is visible in the audited parameters", async () => {
    await tools.grep({ pattern: "alpha", limit: 0 });
    const entry = session.auditTrace().at(-1);
    expect(entry.operation).toBe("grep");
    expect(entry.params).toMatchObject({ pattern: "alpha", limit: 0 });
  });
});

describe("injected backend rejection becomes an audited E_BACKEND_FAILED envelope", () => {
  // Captured lazily (tests run after beforeAll, when `session` exists).
  let originalRun = null;

  function injectRun(rejector) {
    if (!originalRun) originalRun = session.run.bind(session);
    session.run = rejector;
  }

  function restoreRun() {
    if (originalRun) session.run = originalRun;
  }

  afterAll(() => restoreRun());

  it("a rejecting git backend never rejects the caller", async () => {
    injectRun(() => Promise.reject(new Error("injected backend failure")));
    const result = await expectErrorEnvelope(
      () => tools.grep({ pattern: "alpha" }),
      "E_BACKEND_FAILED"
    );
    expect(result.error.message).toContain("injected backend failure");

    const entry = session.auditTrace().at(-1);
    expect(entry.operation).toBe("grep");
    expect(entry.status).toBe("error");
    expect(entry.errorCode).toBe("E_BACKEND_FAILED");
    restoreRun();
  });

  it("a non-Error rejection is still a contract envelope", async () => {
    injectRun(() => Promise.reject("raw string failure"));
    const result = await expectErrorEnvelope(
      () => tools.read({ path: "a.txt" }),
      "E_BACKEND_FAILED"
    );
    expect(result.error.message).toContain("raw string failure");
    restoreRun();
  });
});

describe("closed-session invocation resolves to an error envelope", () => {
  it("returns E_SESSION_CLOSED instead of throwing; the final trace is unchanged", async () => {
    const head = await buildSnapshotSource({ "x.txt": "x\n" }, { ref: "closed" });
    const closedSession = await prepareRepository({
      invocationId: "boundary-closed",
      headSha: "closed",
      acquire: { mode: "snapshot", headTree: head, blobs: head.blobs },
    });
    const closedTools = createRepositoryTools(closedSession);
    closedSession.close();

    const result = await closedTools.grep({ pattern: "x" });
    expect(result.status).toBe("error");
    expect(result.complete).toBe(false);
    expect(result.data).toBeUndefined();
    expect(isAuthoritativeAbsence(result)).toBe(false);
    expect(result.error.code).toBe("E_SESSION_CLOSED");
    // Recording is impossible on a closed session — the trace stays final.
    expect(closedSession.auditTrace()).toEqual([]);
  });
});

describe("the boundary does not change normal outcomes", () => {
  it("success, partial, and tool-level error envelopes still record as before", async () => {
    const before = session.auditTrace().length;

    const ok = await tools.read({ path: "a.txt" });
    expect(ok.status).toBe("success");

    const partial = await tools.read({ path: "a.txt", limit: 1 });
    expect(partial.status).toBe("partial");
    expect(partial.partialReasons).toEqual(["output_lines"]);

    const escaped = await tools.read({ path: "../out" });
    expect(escaped.status).toBe("error");
    expect(escaped.error.code).toBe("E_PATH_ESCAPE");

    const trace = session.auditTrace();
    expect(trace).toHaveLength(before + 3);
    expect(trace.at(-3)).toMatchObject({ operation: "read", status: "success" });
    expect(trace.at(-2)).toMatchObject({ operation: "read", status: "partial", partialReasons: ["output_lines"] });
    expect(trace.at(-1)).toMatchObject({ operation: "read", status: "error", errorCode: "E_PATH_ESCAPE" });
  });
});
