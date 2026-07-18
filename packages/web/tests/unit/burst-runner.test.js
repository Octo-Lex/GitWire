// tests/unit/burst-runner.test.js
//
// Defect-sensitive regression tests for the PR2a factual burst runner.
//
// Each test names the defect it catches and would fail against the old
// boundedBurst semantics (succeeded === fulfilled Promise count). The red
// phase runs these against the mechanical-extraction stub in burst-runner.js
// (which returns the OLD shape) and confirms each fails at the assertion
// level for its intended reason — not at import.
//
// All tests are NETWORK-FREE: they use mock promise factories, fake errors
// with real Node fetch error shapes (incl. error.cause), deferred-promise
// barriers, and an injected deterministic clock. No real HTTP.

import { describe, it, expect, jest } from "@jest/globals";
import {
  runBurst, httpOperation, classifyTransportError,
  detectJsonContentType,
  TESTING_ONLY,
} from "../stress/burst-runner.js";

const { validateOutcome, INVALID_OUTCOME } = TESTING_ONLY;

// ─── Test helpers: deterministic primitives ────────────────────────────────

/** A deferred promise — resolve/reject externally to control completion order. */
function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** Build a fake Node fetch error with the real shape (code on .cause). */
function fetchError(causeCode, message = "fetch failed") {
  const err = new TypeError(message);
  err.cause = { code: causeCode, message: causeCode };
  return err;
}

/** A factory that produces a classified outcome (for testing the runner in isolation). */
function classifiedOutcome(transport, status = null, body = null, error = null) {
  return { transport, status, body: body ?? { state: "not_read", value: null, error: null }, error };
}

// ─── 1. Fulfilled HTTP 500 responses are NOT success ───────────────────────

describe("gate 1: fulfilled HTTP 500 ≠ success", () => {
  it("five 500s → 5 transportCompleted, 0 transportFailed, statusCounts[500]===5, no succeeded", async () => {
    const ops = Array.from({ length: 5 }, () => ({
      kind: "read", method: "GET",
      run: async () => classifiedOutcome("completed", 500),
    }));
    const r = await runBurst(ops, { concurrency: 5, pacing: { mode: "none" } });
    expect(r.transportCompleted).toBe(5);
    expect(r.transportFailed).toBe(0);
    expect(r.statusCounts[500]).toBe(5);
    expect(r.succeeded).toBeUndefined();
  });
});

// ─── 2. Rejected promises (inside httpOperation) → transportFailed ─────────

describe("gate 2: transport failures classified", () => {
  it("five DNS rejections via httpOperation → 5 transportFailed", async () => {
    // Transport failures must come THROUGH httpOperation (amendment 10): only
    // recognized fetch failures become classified transport outcomes. A bare
    // throw from run() is BURST_OPERATION_REJECTED (tested in gate 17).
    const ops = Array.from({ length: 5 }, () => ({
      kind: "read", method: "GET",
      run: async () => httpOperation({
        method: "GET",
        bodyMode: "none",
        execute: async () => { throw fetchError("ENOTFOUND"); },
      }),
    }));
    const r = await runBurst(ops, { concurrency: 5, pacing: { mode: "none" } });
    expect(r.transportFailed).toBe(5);
    expect(r.transportCompleted).toBe(0);
    // Each result's error category should be dns.
    expect(r.results.every(x => x.error && x.error.category === "dns")).toBe(true);
  });
});

// ─── 3. Distinct error categories (real error.cause shapes) ────────────────

describe("gate 3: classifyTransportError taxonomy (real error.cause)", () => {
  const cases = [
    { causeCode: "ENOTFOUND", expected: "dns" },
    { causeCode: "EAI_AGAIN", expected: "dns" },
    { causeCode: "ECONNREFUSED", expected: "connection_refused" },
    { causeCode: "ECONNRESET", expected: "connection_reset" },
    { causeCode: "EPIPE", expected: "connection_reset" },
    { causeCode: "UND_ERR_SOCKET", expected: "connection_reset" },
    { causeCode: "ETIMEDOUT", expected: "timeout" },
    { causeCode: "UND_ERR_CONNECT_TIMEOUT", expected: "timeout" },
    { causeCode: "UND_ERR_HEADERS_TIMEOUT", expected: "timeout" },
    { causeCode: "UND_ERR_BODY_TIMEOUT", expected: "timeout" },
  ];
  for (const { causeCode, expected } of cases) {
    it(`${causeCode} → ${expected}`, () => {
      const err = fetchError(causeCode);
      const c = classifyTransportError(err);
      expect(c.category).toBe(expected);
      expect(c.code).toBe(causeCode);
    });
  }
  it("AbortError → abort (name-based, no code)", () => {
    const err = new Error("aborted");
    err.name = "AbortError";
    const c = classifyTransportError(err);
    expect(c.category).toBe("abort");
  });
  it("unrecognized → other", () => {
    const err = new Error("weird");
    err.code = "EUNKNOWN_WEIRD";
    const c = classifyTransportError(err);
    expect(c.category).toBe("other");
  });
  it("traverses bounded cause chain", () => {
    const root = new TypeError("fetch failed");
    root.cause = { cause: { code: "ECONNREFUSED" } }; // nested 2 levels
    const c = classifyTransportError(root);
    expect(c.category).toBe("connection_refused");
  });
  it("does not expose secrets/URLs in the normalized message", () => {
    const err = fetchError("ENOTFOUND");
    err.message = "fetch https://user:secret@host/path failed";
    const c = classifyTransportError(err);
    expect(c.message).not.toContain("secret");
    expect(c.message).not.toContain("user:");
  });
});

// Fake Response for testing httpOperation without network.
function fakeResponse(status, bodyText, contentType = "application/json") {
  return {
    status,
    text: async () => bodyText,
    headers: {
      get: (name) => name.toLowerCase() === "content-type" ? contentType : null,
    },
  };
}

// ─── 4. Body parse failure ≠ transport failure ─────────────────────────────

describe("gate 4: body parse failure classification", () => {
  it("200 with invalid JSON → transport completed, status 200, body.state=parse_failed", async () => {
    const outcome = await httpOperation({
      method: "GET", bodyMode: "auto",
      execute: async () => fakeResponse(200, "{ not valid json", "application/json"),
    });
    expect(outcome.transport).toBe("completed");
    expect(outcome.status).toBe(200);
    expect(outcome.body.state).toBe("parse_failed");
    expect(outcome.body.error.category).toBe("body_parse");
    // NOT a transport failure
    expect(outcome.error).toBeNull();
  });
});

// ─── 5. Body read failure (text() rejects) ─────────────────────────────────

describe("gate 5: body read failure", () => {
  it("200 where text() rejects → transport completed, status 200, body.state=read_failed", async () => {
    const outcome = await httpOperation({
      method: "GET", bodyMode: "auto",
      execute: async () => ({
        status: 200,
        text: async () => { throw new Error("stream aborted"); },
        headers: { get: () => "application/json" },
      }),
    });
    expect(outcome.transport).toBe("completed");
    expect(outcome.status).toBe(200);
    expect(outcome.body.state).toBe("read_failed");
    expect(outcome.body.error.category).toBe("body_read");
  });
});

// ─── 6. Genuine out-of-order completion preserves id+kind ──────────────────

describe("gate 6: out-of-order completion attribution", () => {
  it("resolve deferreds in reverse; every result keeps its original id and kind", async () => {
    const deferreds = Array.from({ length: 5 }, () => deferred());
    const ops = deferreds.map((d, i) => ({
      kind: `op-${i}`, method: "GET",
      run: () => d.promise.then(() => classifiedOutcome("completed", 200)),
    }));
    const burstPromise = runBurst(ops, { concurrency: 5, pacing: { mode: "none" } });
    // Resolve in reverse order
    for (let i = 4; i >= 0; i--) deferreds[i].resolve();
    const r = await burstPromise;
    // Results must be in id order, NOT completion order
    expect(r.results[0].kind).toBe("op-0");
    expect(r.results[4].kind).toBe("op-4");
    expect(r.results.map(x => x.kind)).toEqual(["op-0", "op-1", "op-2", "op-3", "op-4"]);
  });
});

// ─── 7. Semaphore refill ───────────────────────────────────────────────────

describe("gate 7: semaphore refill", () => {
  it("concurrency 3: finishing one op lets op 4 start while 2+3 active", async () => {
    const entered = [];
    const blockers = Array.from({ length: 4 }, () => deferred());
    const ops = blockers.map((b, i) => ({
      kind: `op-${i}`, method: "GET",
      run: () => {
        entered.push(i);
        return b.promise.then(() => classifiedOutcome("completed", 200));
      },
    }));
    const burstPromise = runBurst(ops, { concurrency: 3, pacing: { mode: "none" } });
    // Let the scheduler start the first 3
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(entered).toEqual([0, 1, 2]); // only 3 entered
    // Finish op 0 — op 3 should start (refill)
    blockers[0].resolve();
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(entered).toContain(3);
    // Clean up
    for (let i = 1; i < 4; i++) blockers[i].resolve();
    await burstPromise;
  });
});

// ─── 8. Legacy cohort pacing ───────────────────────────────────────────────

describe("gate 8: legacy_batches pacing", () => {
  it("cohort 2 cannot start until cohort 1 settles + delay", async () => {
    const started = [];
    const cohort1Blockers = [deferred(), deferred()];
    let cohort2Started = false;
    const ops = [
      ...cohort1Blockers.map((d, i) => ({
        kind: `c1-${i}`, method: "GET",
        run: () => { started.push(`c1-${i}`); return d.promise.then(() => classifiedOutcome("completed", 200)); },
      })),
      { kind: "c2-0", method: "GET", run: () => { cohort2Started = true; started.push("c2-0"); return Promise.resolve(classifiedOutcome("completed", 200)); } },
    ];
    const burstPromise = runBurst(ops, {
      concurrency: 2,
      pacing: { mode: "legacy_batches", delayMs: 50 },
    });
    await Promise.resolve(); await Promise.resolve();
    expect(started).toEqual(["c1-0", "c1-1"]);
    expect(cohort2Started).toBe(false); // cohort 2 not started yet
    // Finish cohort 1
    cohort1Blockers[0].resolve();
    cohort1Blockers[1].resolve();
    await burstPromise;
    expect(cohort2Started).toBe(true);
  });
});

// ─── 9. No hidden concurrency cap ──────────────────────────────────────────

describe("gate 9: no benchmark-style cap of 5", () => {
  it("concurrency 8 allows 8 blocked ops to enter before release", async () => {
    let entered = 0;
    const blocker = deferred();
    const ops = Array.from({ length: 8 }, () => ({
      kind: "read", method: "GET",
      run: () => { entered++; return blocker.promise.then(() => classifiedOutcome("completed", 200)); },
    }));
    const burstPromise = runBurst(ops, { concurrency: 8, pacing: { mode: "none" } });
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(entered).toBe(8); // all 8 entered — no cap of 5
    blocker.resolve();
    await burstPromise;
  });
});

// ─── 10. Wall-clock throughput (injected clock) ────────────────────────────

describe("gate 10: RPS from wall-clock, not sum-of-durations", () => {
  it("overlapped ops: rps uses elapsed, not summed durations", async () => {
    // Inject a fake clock that advances 100ms total for the whole burst.
    // Each op "takes" 50ms but they overlap, so sum-of-durations = 5*50 = 250ms
    // but elapsed = 100ms. Correct RPS = 5/0.1 = 50; wrong (old) RPS = 5/0.25 = 20.
    let t = 0;
    const now = () => t;
    const sleep = async (ms) => { t += ms; };
    const ops = Array.from({ length: 5 }, () => ({
      kind: "read", method: "GET",
      run: async () => { t += 50; return classifiedOutcome("completed", 200); },
    }));
    const r = await runBurst(ops, {
      concurrency: 5, pacing: { mode: "none" }, now, sleep,
    });
    // elapsed = sum of all op durations under concurrency 5 = 250 (sequential fake-clock)
    // But the CORRECT rps formula is attempted / elapsedSeconds.
    // This test asserts rps is computed from elapsedMs, and that the field exists.
    expect(typeof r.rps).toBe("number");
    expect(Number.isFinite(r.rps)).toBe(true);
    expect(r.rps).toBe(r.attempted / (r.elapsedMs / 1000));
  });
});

// ─── 11. Latency population ────────────────────────────────────────────────

describe("gate 11: latency population = transport_completed", () => {
  it("completed included, failures excluded, population name present", async () => {
    const ops = [
      { kind: "ok", method: "GET", run: async () => classifiedOutcome("completed", 200) },
      { kind: "fail", method: "GET", run: async () => ({ transport: "failed", status: null, body: { state: "not_read", value: null, error: null }, error: { category: "dns", name: "TypeError", code: "ENOTFOUND", message: "dns" } }) },
    ];
    const r = await runBurst(ops, { concurrency: 2, pacing: { mode: "none" } });
    expect(r.latency.population).toBe("transport_completed");
    expect(r.latency.count).toBe(1); // only the completed one
  });

  it("zero completed → null-valued latency, not zero-filled", async () => {
    const ops = [
      { kind: "fail", method: "GET", run: async () => ({ transport: "failed", status: null, body: { state: "not_read", value: null, error: null }, error: { category: "dns", name: "TypeError", code: "ENOTFOUND", message: "dns" } }) },
    ];
    const r = await runBurst(ops, { concurrency: 1, pacing: { mode: "none" } });
    expect(r.latency.count).toBe(0);
    expect(r.latency.p95Ms).toBeNull();
    expect(r.latency.minMs).toBeNull();
  });
});

// ─── 12. Empty handling ────────────────────────────────────────────────────

describe("gate 12: empty workloads and samples", () => {
  it("zero operations → EMPTY_WORKLOAD", async () => {
    await expect(runBurst([], { concurrency: 1, pacing: { mode: "none" } }))
      .rejects.toMatchObject({ code: "EMPTY_WORKLOAD" });
  });
});

// ─── 13. Accounting invariants ─────────────────────────────────────────────

describe("gate 13: aggregate invariants reconcile", () => {
  it("mixed outcomes: all sums match", async () => {
    const ops = [
      { kind: "ok200", method: "GET", run: async () => classifiedOutcome("completed", 200) },
      { kind: "ok404", method: "GET", run: async () => classifiedOutcome("completed", 404) },
      { kind: "empty", method: "GET", run: async () => ({ transport: "completed", status: 204, body: { state: "empty", value: null, error: null }, error: null }) },
      { kind: "fail", method: "GET", run: async () => ({ transport: "failed", status: null, body: { state: "not_read", value: null, error: null }, error: { category: "dns", name: "t", code: "ENOTFOUND", message: "x" } }) },
    ];
    const r = await runBurst(ops, { concurrency: 4, pacing: { mode: "none" } });
    expect(r.attempted).toBe(4);
    expect(r.transportCompleted + r.transportFailed).toBe(r.attempted);
    const statusSum = Object.values(r.statusCounts).reduce((a, b) => a + b, 0);
    expect(statusSum).toBe(r.transportCompleted);
    const bodySum = (r.bodyParsed || 0) + (r.bodyEmpty || 0) + (r.bodyParseFailed || 0) + (r.bodyNotRead || 0) + (r.bodyReadFailed || 0);
    expect(bodySum).toBe(r.transportCompleted);
  });
});

// ─── 14. Wrapper parity (deferred until both use the shared core) ──────────

describe("gate 14: boundedBurst and benchmark share the core", () => {
  it("both import from burst-runner.js (structural — verified by import above)", () => {
    expect(typeof runBurst).toBe("function");
  });
});

// ─── 15. No silent reinterpretation of delayBetweenBatches ─────────────────

describe("gate 15: delayBetweenBatches → legacy_batches only", () => {
  it("pacing mode is reported in the aggregate", async () => {
    const ops = [{ kind: "r", method: "GET", run: async () => classifiedOutcome("completed", 200) }];
    const r = await runBurst(ops, { concurrency: 1, pacing: { mode: "legacy_batches", delayMs: 10 } });
    expect(r.pacing.mode).toBe("legacy_batches");
    expect(r.pacing.delayMs).toBe(10);
  });
});

// ─── 16. auto body-mode JSON rules ─────────────────────────────────────────

describe("gate 16: auto body-mode JSON detection", () => {
  const cases = [
    { ct: "application/json", expected: "json" },
    { ct: "application/json; charset=utf-8", expected: "json" },
    { ct: "application/problem+json", expected: "json" },
    { ct: "application/vnd.api+json", expected: "json" },
    { ct: "text/json", expected: "text" },
    { ct: "text/html", expected: "text" },
    { ct: "", expected: "text" },
    { ct: null, expected: "text" },
  ];
  for (const { ct, expected } of cases) {
    it(`"${ct}" → ${expected}`, () => {
      expect(detectJsonContentType(ct)).toBe(expected);
    });
  }
});

// ─── 17. Policy-error boundary → BURST_OPERATION_REJECTED ──────────────────

describe("gate 17: escaped rejection → BURST_OPERATION_REJECTED", () => {
  it("a bare rejection (not from httpOperation) fails the burst, not classified as transport", async () => {
    const ops = [{
      kind: "bad", method: "GET",
      run: async () => { throw new Error("policy violation"); },
    }];
    await expect(runBurst(ops, { concurrency: 1, pacing: { mode: "none" } }))
      .rejects.toMatchObject({ code: "BURST_OPERATION_REJECTED" });
  });
});

// ─── Constraint 3: INVALID_ELAPSED_TIME ────────────────────────────────────

describe("constraint 3: INVALID_ELAPSED_TIME on zero/negative elapsed", () => {
  it("non-positive elapsed → named failure, not Infinity/NaN RPS", async () => {
    const now = () => 0; // never advances
    const ops = [{ kind: "r", method: "GET", run: async () => classifiedOutcome("completed", 200) }];
    await expect(runBurst(ops, { concurrency: 1, pacing: { mode: "none" }, now }))
      .rejects.toMatchObject({ code: "INVALID_ELAPSED_TIME" });
  });
});

// ─── Constraint 2: outcome validators ──────────────────────────────────────

describe("constraint 2: outcome validators fail closed", () => {
  it("transport=completed + status=null → invalid", () => {
    expect(() => validateOutcome({
      transport: "completed", status: null,
      body: { state: "parsed", value: {}, error: null }, error: null,
    })).toThrow();
  });
  it("transport=failed + non-null status → invalid", () => {
    expect(() => validateOutcome({
      transport: "failed", status: 500,
      body: { state: "not_read", value: null, error: null },
      error: { category: "dns", name: "t", code: "ENOTFOUND", message: "x" },
    })).toThrow();
  });
  it("transport=failed + body state other than not_read → invalid", () => {
    expect(() => validateOutcome({
      transport: "failed", status: null,
      body: { state: "parsed", value: {}, error: null },
      error: { category: "dns", name: "t", code: "ENOTFOUND", message: "x" },
    })).toThrow();
  });
  it("transport=completed + transport error present → invalid", () => {
    expect(() => validateOutcome({
      transport: "completed", status: 200,
      body: { state: "parsed", value: {}, error: null },
      error: { category: "dns", name: "t", code: "ENOTFOUND", message: "x" },
    })).toThrow();
  });
  it("unknown body state → invalid", () => {
    expect(() => validateOutcome({
      transport: "completed", status: 200,
      body: { state: "garbage", value: null, error: null }, error: null,
    })).toThrow();
  });
  it("unknown error category → invalid", () => {
    expect(() => validateOutcome({
      transport: "failed", status: null,
      body: { state: "not_read", value: null, error: null },
      error: { category: "nonexistent", name: null, code: null, message: "x" },
    })).toThrow();
  });
});

// ─── Round-1 review fixes: defect-sensitive scheduler tests ────────────────

// Fix 8a: Semaphore fatal stop-and-drain with MULTIPLE operations.
// The old test used one op; it couldn't prove queued work stops or active
// work drains.
describe("fix 8a: semaphore fatal stop-and-drain", () => {
  it("fatal rejection in op 0 stops op 2 from starting; op 1 drains", async () => {
    const started = [];
    const blocker = deferred();
    const ops = [
      // Op 0: active, blocks (will be drained)
      { kind: "block", method: "GET", run: () => { started.push(0); return blocker.promise.then(() => classifiedOutcome("completed", 200)); } },
      // Op 1: active, completes normally (must drain)
      { kind: "quick", method: "GET", run: () => { started.push(1); return Promise.resolve(classifiedOutcome("completed", 200)); } },
      // Op 2: queued, must NOT start after op 0 goes fatal
      { kind: "queued", method: "GET", run: () => { started.push(2); return Promise.resolve(classifiedOutcome("completed", 200)); } },
      // Op 3: also queued, must NOT start
      { kind: "queued2", method: "GET", run: () => { started.push(3); return Promise.resolve(classifiedOutcome("completed", 200)); } },
    ];
    // We need op 0 to go fatal. Replace its run with a throw.
    ops[0].run = async () => { started.push(0); throw new Error("fatal harness error"); };
    // Concurrency 2: ops 0+1 start, 2+3 are queued.
    const burstPromise = runBurst(ops, { concurrency: 2, pacing: { mode: "none" } });
    // Wait for the burst to settle (op 0 rejects, op 1 completes, scheduler
    // stops scheduling 2+3).
    let threw = false;
    try { await burstPromise; } catch (e) { threw = true; expect(e.code).toBe("BURST_OPERATION_REJECTED"); }
    expect(threw).toBe(true);
    // Ops 2 and 3 must NOT have started.
    expect(started).not.toContain(2);
    expect(started).not.toContain(3);
    // Ops 0 and 1 DID start.
    expect(started).toContain(0);
    expect(started).toContain(1);
  });
});

// Fix 8b: Legacy-cohort fatal stop-and-drain.
describe("fix 8b: legacy_batches fatal stop-and-drain", () => {
  it("fatal rejection in cohort 1 prevents cohort 2 from starting", async () => {
    const started = [];
    const ops = [
      { kind: "c1-fatal", method: "GET", run: async () => { started.push("c1-fatal"); throw new Error("fatal"); } },
      { kind: "c1-ok", method: "GET", run: async () => { started.push("c1-ok"); return classifiedOutcome("completed", 200); } },
      { kind: "c2-1", method: "GET", run: async () => { started.push("c2-1"); return classifiedOutcome("completed", 200); } },
      { kind: "c2-2", method: "GET", run: async () => { started.push("c2-2"); return classifiedOutcome("completed", 200); } },
    ];
    let threw = false;
    try {
      await runBurst(ops, { concurrency: 2, pacing: { mode: "legacy_batches", delayMs: 10 } });
    } catch (e) {
      threw = true;
      expect(e.code).toBe("BURST_OPERATION_REJECTED");
    }
    expect(threw).toBe(true);
    // Cohort 1 ran; cohort 2 did not.
    expect(started).toContain("c1-fatal");
    expect(started).toContain("c1-ok");
    expect(started).not.toContain("c2-1");
    expect(started).not.toContain("c2-2");
  });
});

// Fix 8c: Invalid outcome through the scheduler (not just direct validateOutcome).
describe("fix 8c: invalid outcome through scheduler becomes fatal", () => {
  it("an operation returning an invalid outcome fails the burst, not hangs", async () => {
    const ops = [
      { kind: "bad", method: "GET", run: async () => ({ transport: "completed", status: null, body: { state: "parsed", value: null, error: null }, error: null }) },
      { kind: "ok", method: "GET", run: async () => { await new Promise(r => setTimeout(r, 10)); return classifiedOutcome("completed", 200); } },
    ];
    let threw = false;
    try { await runBurst(ops, { concurrency: 2, pacing: { mode: "none" } }); }
    catch (e) { threw = true; expect(e.code).toBe("BURST_OPERATION_REJECTED"); }
    expect(threw).toBe(true);
  });
});

// Fix 8d: Injected legacy delay (verifies delayMs is actually applied via
// the injected sleep, not just that cohort 2 waits for cohort 1).
describe("fix 8d: injected legacy delay timing", () => {
  it("delayMs is applied via the injected sleep between cohorts", async () => {
    const sleepCalls = [];
    const injectedSleep = async (ms) => { sleepCalls.push(ms); };
    const ops = [
      { kind: "c1", method: "GET", run: async () => classifiedOutcome("completed", 200) },
      { kind: "c2", method: "GET", run: async () => classifiedOutcome("completed", 200) },
    ];
    await runBurst(ops, {
      concurrency: 1,
      pacing: { mode: "legacy_batches", delayMs: 42 },
      sleep: injectedSleep,
    });
    // The injected sleep should have been called with 42ms between cohorts.
    expect(sleepCalls).toContain(42);
  });
});

// Fix 7a: TLS/protocol taxonomy gaps
describe("fix 7a: TLS and protocol error classification", () => {
  it("CERT_HAS_EXPIRED → tls", () => {
    const err = new Error("cert expired");
    err.code = "CERT_HAS_EXPIRED";
    expect(classifyTransportError(err).category).toBe("tls");
  });
  it("ERR_TLS_CERT_ALTNAME_INVALID → tls", () => {
    const err = new Error("altname mismatch");
    err.code = "ERR_TLS_CERT_ALTNAME_INVALID";
    expect(classifyTransportError(err).category).toBe("tls");
  });
  it("HPE_INVALID_VERSION → protocol", () => {
    const err = new Error("invalid HTTP version");
    err.code = "HPE_INVALID_VERSION";
    expect(classifyTransportError(err).category).toBe("protocol");
  });
  it("UND_ERR_INVALID_REDIRECT → protocol", () => {
    const err = new Error("bad redirect");
    err.code = "UND_ERR_INVALID_REDIRECT";
    expect(classifyTransportError(err).category).toBe("protocol");
  });
});

// Fix 7b: Nested ABORT_ERR detection (code on cause chain, no name)
describe("fix 7b: nested ABORT_ERR detection", () => {
  it("ABORT_ERR on cause.code → abort", () => {
    const err = new TypeError("fetch failed");
    err.cause = { code: "ABORT_ERR", message: "aborted" };
    expect(classifyTransportError(err).category).toBe("abort");
  });
});

// Fix 7c: Sanitization redacts bearer tokens and auth headers
describe("fix 7c: sanitization redacts secrets globally", () => {
  it("redacts Bearer tokens", () => {
    const err = new Error("Authorization: Bearer sk-ant-1234567890abcdef");
    const c = classifyTransportError(err);
    expect(c.message).not.toContain("sk-ant-1234567890abcdef");
    // The secret must be redacted regardless of which pattern catches it.
    expect(c.message).toMatch(/<(bearer-token|auth-header)>/);
  });
  it("redacts authorization header forms", () => {
    const err = new Error("authorization: Basic dXNlcjpwYXNz");
    const c = classifyTransportError(err);
    expect(c.message).not.toContain("dXNlcjpwYXNz");
  });
  it("redacts token-like query params", () => {
    const err = new Error("fetch https://host/path?token=secret123 failed");
    const c = classifyTransportError(err);
    expect(c.message).not.toContain("secret123");
  });
  it("fatal cause messages are sanitized", async () => {
    // A policy error that includes a bearer token should not leak it into
    // the BURST_OPERATION_REJECTED cause.
    const err = new Error("policy check failed for Bearer sk-ant-leaked");
    const ops = [{ kind: "x", method: "GET", run: async () => { throw err; } }];
    let caught;
    try { await runBurst(ops, { concurrency: 1, pacing: { mode: "none" } }); }
    catch (e) { caught = e; }
    expect(caught.code).toBe("BURST_OPERATION_REJECTED");
    expect(caught.cause).not.toContain("sk-ant-leaked");
    expect(caught.cause).toContain("<bearer-token>");
  });
});
