// tests/unit/response-contracts.test.js
//
// Defect-sensitive regression tests for the PR2b semantic layer.
//
// Each test names the semantic defect it catches. The red phase runs these
// against the mechanical semantic stub (runContractedBurst = pass-through to
// runBurst, no enrichment) and confirms each fails at the assertion level
// (e.g., `Expected result.http to be "expected", Received undefined`) — not
// at import.
//
// All tests are NETWORK-FREE.

import { describe, it, expect } from "@jest/globals";
import { runContractedBurst } from "../stress/burst-runner.js";

// Helpers (duplicated from burst-runner.test.js for isolation)
function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
function outcome(transport, status = null, body = null) {
  return {
    transport, status,
    body: body ?? { state: "not_read", value: null, error: null },
    error: null,
  };
}

// ─── 1. HTTP classification: expected vs unexpected vs not_received ────────

describe("gate RC-1: HTTP classification", () => {
  it("received status in expectedStatuses → http=expected", async () => {
    const ops = [{
      kind: "read", method: "GET",
      run: async () => outcome("completed", 200),
      responseContract: { expectedStatuses: [200, 429] },
    }];
    const r = await runContractedBurst(ops, { concurrency: 1, pacing: { mode: "none" } });
    expect(r.results[0].http).toBe("expected");
  });

  it("received status outside expectedStatuses → http=unexpected", async () => {
    const ops = [{
      kind: "read", method: "GET",
      run: async () => outcome("completed", 500),
      responseContract: { expectedStatuses: [200, 429] },
    }];
    const r = await runContractedBurst(ops, { concurrency: 1, pacing: { mode: "none" } });
    expect(r.results[0].http).toBe("unexpected");
  });

  it("transport failure → http=not_received", async () => {
    const ops = [{
      kind: "read", method: "GET",
      run: async () => outcome("failed"),
      responseContract: { expectedStatuses: [200] },
    }];
    const r = await runContractedBurst(ops, { concurrency: 1, pacing: { mode: "none" } });
    expect(r.results[0].http).toBe("not_received");
  });

  it("no expectedStatuses declared → all transport-completed are expected", async () => {
    const ops = [{
      kind: "read", method: "GET",
      run: async () => outcome("completed", 404),
      responseContract: { assert: () => ({ passed: true }) },
    }];
    const r = await runContractedBurst(ops, { concurrency: 1, pacing: { mode: "none" } });
    expect(r.results[0].http).toBe("expected");
  });
});

// ─── 2. Assertion classification: passed / failed / not_run ────────────────

describe("gate RC-2: assertion classification", () => {
  it("assert callback returns passed:true → assertion=passed", async () => {
    const ops = [{
      kind: "read", method: "GET",
      run: async () => outcome("completed", 200, { state: "parsed", value: { ok: true }, error: null }),
      responseContract: { expectedStatuses: [200], assert: ({ body }) => body.value?.ok ? { passed: true } : { passed: false, code: "X", message: "m" } },
    }];
    const r = await runContractedBurst(ops, { concurrency: 1, pacing: { mode: "none" } });
    expect(r.results[0].assertion).toBe("passed");
  });

  it("assert callback returns passed:false → assertion=failed with code/message", async () => {
    const ops = [{
      kind: "read", method: "GET",
      run: async () => outcome("completed", 200, { state: "parsed", value: {}, error: null }),
      responseContract: { expectedStatuses: [200], assert: () => ({ passed: false, code: "EXPECTED_PAGE", message: "wrong page" }) },
    }];
    const r = await runContractedBurst(ops, { concurrency: 1, pacing: { mode: "none" } });
    expect(r.results[0].assertion).toBe("failed");
    expect(r.results[0].assertionError.code).toBe("EXPECTED_PAGE");
    expect(r.results[0].assertionError.message).toContain("wrong page");
  });

  it("transport failure → assertion=not_run, reason=transport_failed", async () => {
    const ops = [{
      kind: "read", method: "GET",
      run: async () => outcome("failed"),
      responseContract: { expectedStatuses: [200], assert: () => ({ passed: true }) },
    }];
    const r = await runContractedBurst(ops, { concurrency: 1, pacing: { mode: "none" } });
    expect(r.results[0].assertion).toBe("not_run");
    expect(r.results[0].assertionNotRunReason).toBe("transport_failed");
  });

  it("no assert declared → assertion=not_run, reason=not_declared", async () => {
    const ops = [{
      kind: "read", method: "GET",
      run: async () => outcome("completed", 200),
      responseContract: { expectedStatuses: [200] },
    }];
    const r = await runContractedBurst(ops, { concurrency: 1, pacing: { mode: "none" } });
    expect(r.results[0].assertion).toBe("not_run");
    expect(r.results[0].assertionNotRunReason).toBe("not_declared");
  });

  it("status excluded by assertOnStatuses → assertion=not_run, reason=status_not_applicable", async () => {
    const ops = [{
      kind: "read", method: "GET",
      run: async () => outcome("completed", 429),
      responseContract: { expectedStatuses: [200, 429], assertOnStatuses: [200], assert: () => ({ passed: true }) },
    }];
    const r = await runContractedBurst(ops, { concurrency: 1, pacing: { mode: "none" } });
    expect(r.results[0].http).toBe("expected"); // 429 is in expectedStatuses
    expect(r.results[0].assertion).toBe("not_run"); // but assert only runs on 200
    expect(r.results[0].assertionNotRunReason).toBe("status_not_applicable");
  });
});

// ─── 3. Preflight validation ──────────────────────────────────────────────

describe("gate RC-3: preflight validation", () => {
  it("missing responseContract → INVALID_RESPONSE_CONTRACT before traffic", async () => {
    const ops = [{ kind: "read", method: "GET", run: async () => outcome("completed", 200) }];
    await expect(runContractedBurst(ops, { concurrency: 1, pacing: { mode: "none" } }))
      .rejects.toMatchObject({ code: "INVALID_RESPONSE_CONTRACT" });
  });

  it("empty expectedStatuses → INVALID_RESPONSE_CONTRACT", async () => {
    const ops = [{ kind: "r", method: "GET", run: async () => outcome("completed", 200), responseContract: { expectedStatuses: [] } }];
    await expect(runContractedBurst(ops, { concurrency: 1, pacing: { mode: "none" } }))
      .rejects.toMatchObject({ code: "INVALID_RESPONSE_CONTRACT" });
  });

  it("vacuous contract (no expectedStatuses, no assert) → INVALID_RESPONSE_CONTRACT", async () => {
    const ops = [{ kind: "r", method: "GET", run: async () => outcome("completed", 200), responseContract: {} }];
    await expect(runContractedBurst(ops, { concurrency: 1, pacing: { mode: "none" } }))
      .rejects.toMatchObject({ code: "INVALID_RESPONSE_CONTRACT" });
  });
});

// ─── 4. Aggregate counts ──────────────────────────────────────────────────

describe("gate RC-4: aggregate reconciliation", () => {
  it("httpExpected + httpUnexpected + httpNotReceived === attempted", async () => {
    const ops = [
      { kind: "ok", method: "GET", run: async () => outcome("completed", 200), responseContract: { expectedStatuses: [200] } },
      { kind: "bad", method: "GET", run: async () => outcome("completed", 500), responseContract: { expectedStatuses: [200] } },
      { kind: "fail", method: "GET", run: async () => outcome("failed"), responseContract: { expectedStatuses: [200] } },
    ];
    const r = await runContractedBurst(ops, { concurrency: 3, pacing: { mode: "none" } });
    expect(r.httpExpected + r.httpUnexpected + r.httpNotReceived).toBe(r.attempted);
  });

  it("assertionPassed + assertionFailed + assertionNotRun === attempted", async () => {
    const ops = [
      { kind: "ok", method: "GET", run: async () => outcome("completed", 200, { state: "parsed", value: { ok: true }, error: null }), responseContract: { expectedStatuses: [200], assert: ({ body }) => body.value?.ok ? { passed: true } : { passed: false, code: "X", message: "m" } } },
      { kind: "bad", method: "GET", run: async () => outcome("completed", 200, { state: "parsed", value: {}, error: null }), responseContract: { expectedStatuses: [200], assert: () => ({ passed: false, code: "X", message: "m" }) } },
      { kind: "fail", method: "GET", run: async () => outcome("failed"), responseContract: { expectedStatuses: [200], assert: () => ({ passed: true }) } },
    ];
    const r = await runContractedBurst(ops, { concurrency: 3, pacing: { mode: "none" } });
    expect(r.assertionPassed + r.assertionFailed + r.assertionNotRun).toBe(r.attempted);
  });
});

// ─── 5. Semantic latency populations ──────────────────────────────────────

describe("gate RC-5: semantic latency populations", () => {
  it("httpExpected population exists and is null-valued when empty", async () => {
    const ops = [{
      kind: "r", method: "GET",
      run: async () => outcome("failed"),
      responseContract: { expectedStatuses: [200] },
    }];
    const r = await runContractedBurst(ops, { concurrency: 1, pacing: { mode: "none" } });
    expect(r.semanticLatency.httpExpected.population).toBe("http_expected");
    expect(r.semanticLatency.httpExpected.count).toBe(0);
    expect(r.semanticLatency.httpExpected.p95Ms).toBeNull();
  });

  it("assertionPassed population exists and is null-valued when empty", async () => {
    const ops = [{
      kind: "r", method: "GET",
      run: async () => outcome("failed"),
      responseContract: { expectedStatuses: [200], assert: () => ({ passed: true }) },
    }];
    const r = await runContractedBurst(ops, { concurrency: 1, pacing: { mode: "none" } });
    expect(r.semanticLatency.assertionPassed.population).toBe("assertion_passed");
    expect(r.semanticLatency.assertionPassed.count).toBe(0);
    expect(r.semanticLatency.assertionPassed.p95Ms).toBeNull();
  });
});

// ─── 6. Callback fail-closed behavior ─────────────────────────────────────

describe("gate RC-6: callback fail-closed", () => {
  it("callback throw → BURST_OPERATION_REJECTED, no aggregate returned", async () => {
    const ops = [{
      kind: "r", method: "GET",
      run: async () => outcome("completed", 200),
      responseContract: { expectedStatuses: [200], assert: () => { throw new Error("boom"); } },
    }];
    await expect(runContractedBurst(ops, { concurrency: 1, pacing: { mode: "none" } }))
      .rejects.toMatchObject({ code: "BURST_OPERATION_REJECTED" });
  });

  it("callback returns boolean → BURST_OPERATION_REJECTED", async () => {
    const ops = [{
      kind: "r", method: "GET",
      run: async () => outcome("completed", 200),
      responseContract: { expectedStatuses: [200], assert: () => true },
    }];
    await expect(runContractedBurst(ops, { concurrency: 1, pacing: { mode: "none" } }))
      .rejects.toMatchObject({ code: "BURST_OPERATION_REJECTED" });
  });

  it("passed:false without code → BURST_OPERATION_REJECTED", async () => {
    const ops = [{
      kind: "r", method: "GET",
      run: async () => outcome("completed", 200),
      responseContract: { expectedStatuses: [200], assert: () => ({ passed: false }) },
    }];
    await expect(runContractedBurst(ops, { concurrency: 1, pacing: { mode: "none" } }))
      .rejects.toMatchObject({ code: "BURST_OPERATION_REJECTED" });
  });

  it("boolean return carries full {id, kind, method} attribution + sanitized reason", async () => {
    // This exercises validateCallbackReturn (not the catch branch for throws).
    const ops = [{
      kind: "malformed", method: "POST",
      run: async () => outcome("completed", 200),
      responseContract: { expectedStatuses: [200], assert: () => true },
    }];
    await expect(runContractedBurst(ops, { concurrency: 1, pacing: { mode: "none" } }))
      .rejects.toMatchObject({
        code: "BURST_OPERATION_REJECTED",
        operation: { id: 0, kind: "malformed", method: "POST" },
      });
  });

  it("undefined return carries full attribution + sanitized reason", async () => {
    const ops = [{
      kind: "undef-op", method: "GET",
      run: async () => outcome("completed", 200),
      responseContract: { expectedStatuses: [200], assert: () => undefined },
    }];
    let caught;
    try { await runContractedBurst(ops, { concurrency: 1, pacing: { mode: "none" } }); }
    catch (e) { caught = e; }
    expect(caught.code).toBe("BURST_OPERATION_REJECTED");
    expect(caught.operation.id).toBe(0);
    expect(caught.operation.kind).toBe("undef-op");
    expect(caught.operation.method).toBe("GET");
    expect(typeof caught.reason).toBe("string");
  });

  it("custom thenable return → BURST_OPERATION_REJECTED", async () => {
    // A custom thenable (not a native Promise) must also be rejected.
    const thenable = { then: (resolve) => resolve({ passed: true }) };
    const ops = [{
      kind: "thenable", method: "GET",
      run: async () => outcome("completed", 200),
      responseContract: { expectedStatuses: [200], assert: () => thenable },
    }];
    await expect(runContractedBurst(ops, { concurrency: 1, pacing: { mode: "none" } }))
      .rejects.toMatchObject({
        code: "BURST_OPERATION_REJECTED",
        operation: { id: 0, kind: "thenable", method: "GET" },
      });
  });
});

// ─── 7. Correlation under reverse completion ──────────────────────────────

describe("gate RC-7: contract/result correlation under reverse completion", () => {
  it("results retain correct contracts when deferreds resolve in reverse", async () => {
    const d1 = deferred(), d2 = deferred();
    const ops = [
      { kind: "a", method: "GET", run: () => d1.promise.then(() => outcome("completed", 200)), responseContract: { expectedStatuses: [200] } },
      { kind: "b", method: "GET", run: () => d2.promise.then(() => outcome("completed", 404)), responseContract: { expectedStatuses: [200] } },
    ];
    const burstP = runContractedBurst(ops, { concurrency: 2, pacing: { mode: "none" } });
    d2.resolve(); // reverse order
    d1.resolve();
    const r = await burstP;
    expect(r.results[0].kind).toBe("a");
    expect(r.results[0].http).toBe("expected"); // 200 is expected
    expect(r.results[1].kind).toBe("b");
    expect(r.results[1].http).toBe("unexpected"); // 404 is not in [200]
  });
});

// ─── 8. Factual fields unchanged ──────────────────────────────────────────

describe("gate RC-8: factual fields remain unchanged", () => {
  it("factual transport/status/body/error fields are still present on enriched results", async () => {
    const ops = [{
      kind: "r", method: "GET",
      run: async () => outcome("completed", 200, { state: "parsed", value: { x: 1 }, error: null }),
      responseContract: { expectedStatuses: [200] },
    }];
    const r = await runContractedBurst(ops, { concurrency: 1, pacing: { mode: "none" } });
    expect(r.results[0].transport).toBe("completed");
    expect(r.results[0].status).toBe(200);
    expect(r.results[0].body.state).toBe("parsed");
    expect(r.results[0].body.value).toEqual({ x: 1 });
    expect(r.results[0].error).toBeNull();
    // Factual latency (transport_completed) still present
    expect(r.latency.population).toBe("transport_completed");
  });
});

// ─── Round-2 expanded engine tests ────────────────────────────────────────

// Fix 5a: Preflight rejects invalid assertOnStatuses
describe("gate RC-9: assertOnStatuses validation", () => {
  it("string in assertOnStatuses → INVALID_RESPONSE_CONTRACT", async () => {
    const ops = [{
      kind: "r", method: "GET", run: async () => outcome("completed", 200),
      responseContract: { expectedStatuses: [200], assertOnStatuses: ["429"], assert: () => ({ passed: true }) },
    }];
    await expect(runContractedBurst(ops, { concurrency: 1, pacing: { mode: "none" } }))
      .rejects.toMatchObject({ code: "INVALID_RESPONSE_CONTRACT" });
  });

  it("negative status in assertOnStatuses → INVALID_RESPONSE_CONTRACT", async () => {
    const ops = [{
      kind: "r", method: "GET", run: async () => outcome("completed", 200),
      responseContract: { expectedStatuses: [200], assertOnStatuses: [-1], assert: () => ({ passed: true }) },
    }];
    await expect(runContractedBurst(ops, { concurrency: 1, pacing: { mode: "none" } }))
      .rejects.toMatchObject({ code: "INVALID_RESPONSE_CONTRACT" });
  });

  it("duplicate status in assertOnStatuses → INVALID_RESPONSE_CONTRACT", async () => {
    const ops = [{
      kind: "r", method: "GET", run: async () => outcome("completed", 200),
      responseContract: { expectedStatuses: [200], assertOnStatuses: [200, 200], assert: () => ({ passed: true }) },
    }];
    await expect(runContractedBurst(ops, { concurrency: 1, pacing: { mode: "none" } }))
      .rejects.toMatchObject({ code: "INVALID_RESPONSE_CONTRACT" });
  });

  it("assertOnStatuses without assert → INVALID_RESPONSE_CONTRACT", async () => {
    const ops = [{
      kind: "r", method: "GET", run: async () => outcome("completed", 200),
      responseContract: { expectedStatuses: [200], assertOnStatuses: [200] },
    }];
    await expect(runContractedBurst(ops, { concurrency: 1, pacing: { mode: "none" } }))
      .rejects.toMatchObject({ code: "INVALID_RESPONSE_CONTRACT" });
  });
});

// Fix 5b: null/primitive descriptor validation
describe("gate RC-10: descriptor validation", () => {
  it("null descriptor → INVALID_RESPONSE_CONTRACT", async () => {
    await expect(runContractedBurst([null], { concurrency: 1, pacing: { mode: "none" } }))
      .rejects.toMatchObject({ code: "INVALID_RESPONSE_CONTRACT" });
  });

  it("primitive descriptor → INVALID_RESPONSE_CONTRACT", async () => {
    await expect(runContractedBurst([42], { concurrency: 1, pacing: { mode: "none" } }))
      .rejects.toMatchObject({ code: "INVALID_RESPONSE_CONTRACT" });
  });

  it("descriptor without run function → INVALID_RESPONSE_CONTRACT", async () => {
    const ops = [{ kind: "r", method: "GET", responseContract: { expectedStatuses: [200] } }];
    await expect(runContractedBurst(ops, { concurrency: 1, pacing: { mode: "none" } }))
      .rejects.toMatchObject({ code: "INVALID_RESPONSE_CONTRACT" });
  });
});

// Fix 5c: Preflight zero-traffic sentinel
describe("gate RC-11: preflight stops before traffic", () => {
  it("malformed contract prevents run() from being called", async () => {
    let runCalled = false;
    const ops = [
      // First op has a malformed contract (empty expectedStatuses).
      { kind: "bad", method: "GET", run: async () => { runCalled = true; return outcome("completed", 200); },
        responseContract: { expectedStatuses: [] } },
      // Second op would run if preflight didn't stop.
      { kind: "ok", method: "GET", run: async () => { runCalled = true; return outcome("completed", 200); },
        responseContract: { expectedStatuses: [200] } },
    ];
    await expect(runContractedBurst(ops, { concurrency: 2, pacing: { mode: "none" } }))
      .rejects.toMatchObject({ code: "INVALID_RESPONSE_CONTRACT" });
    expect(runCalled).toBe(false); // No operation started
  });
});

// Fix 5d: Callback return validation expanded
describe("gate RC-12: expanded callback validation", () => {
  it("promise return → BURST_OPERATION_REJECTED", async () => {
    const ops = [{
      kind: "r", method: "GET", run: async () => outcome("completed", 200),
      responseContract: { expectedStatuses: [200], assert: () => Promise.resolve({ passed: true }) },
    }];
    await expect(runContractedBurst(ops, { concurrency: 1, pacing: { mode: "none" } }))
      .rejects.toMatchObject({ code: "BURST_OPERATION_REJECTED" });
  });

  it("undefined return → BURST_OPERATION_REJECTED", async () => {
    const ops = [{
      kind: "r", method: "GET", run: async () => outcome("completed", 200),
      responseContract: { expectedStatuses: [200], assert: () => undefined },
    }];
    await expect(runContractedBurst(ops, { concurrency: 1, pacing: { mode: "none" } }))
      .rejects.toMatchObject({ code: "BURST_OPERATION_REJECTED" });
  });

  it("passed:true with empty-string code → BURST_OPERATION_REJECTED (property presence)", async () => {
    const ops = [{
      kind: "r", method: "GET", run: async () => outcome("completed", 200),
      responseContract: { expectedStatuses: [200], assert: () => ({ passed: true, code: "" }) },
    }];
    await expect(runContractedBurst(ops, { concurrency: 1, pacing: { mode: "none" } }))
      .rejects.toMatchObject({ code: "BURST_OPERATION_REJECTED" });
  });

  it("passed:true with empty-string message → BURST_OPERATION_REJECTED (property presence)", async () => {
    const ops = [{
      kind: "r", method: "GET", run: async () => outcome("completed", 200),
      responseContract: { expectedStatuses: [200], assert: () => ({ passed: true, message: "" }) },
    }];
    await expect(runContractedBurst(ops, { concurrency: 1, pacing: { mode: "none" } }))
      .rejects.toMatchObject({ code: "BURST_OPERATION_REJECTED" });
  });

  it("passed:false with lowercase code → BURST_OPERATION_REJECTED (format)", async () => {
    const ops = [{
      kind: "r", method: "GET", run: async () => outcome("completed", 200),
      responseContract: { expectedStatuses: [200], assert: () => ({ passed: false, code: "lowercase_code", message: "x" }) },
    }];
    await expect(runContractedBurst(ops, { concurrency: 1, pacing: { mode: "none" } }))
      .rejects.toMatchObject({ code: "BURST_OPERATION_REJECTED" });
  });

  it("fatal error carries full {id, kind, method} attribution", async () => {
    const ops = [{
      kind: "my-op", method: "POST", run: async () => outcome("completed", 200),
      responseContract: { expectedStatuses: [200], assert: () => { throw new Error("boom"); } },
    }];
    let caught;
    try { await runContractedBurst(ops, { concurrency: 1, pacing: { mode: "none" } }); }
    catch (e) { caught = e; }
    expect(caught.code).toBe("BURST_OPERATION_REJECTED");
    expect(caught.operation.id).toBe(0);
    expect(caught.operation.kind).toBe("my-op");
    expect(caught.operation.method).toBe("POST");
    expect(caught.reason).toContain("boom");
  });
});

// Fix 5e: httpNotReceived === transportFailed
describe("gate RC-13: transport failure counts", () => {
  it("httpNotReceived equals transportFailed", async () => {
    const ops = [
      { kind: "ok", method: "GET", run: async () => outcome("completed", 200),
        responseContract: { expectedStatuses: [200] } },
      { kind: "fail", method: "GET", run: async () => outcome("failed"),
        responseContract: { expectedStatuses: [200] } },
    ];
    const r = await runContractedBurst(ops, { concurrency: 2, pacing: { mode: "none" } });
    expect(r.httpNotReceived).toBe(r.transportFailed);
  });
});

// Fix 5f: Assertion not-run reason reconciliation
describe("gate RC-14: assertion not-run reasons", () => {
  it("reasons reconcile with counts", async () => {
    const ops = [
      // transport_failed → not_run, transport_failed
      { kind: "fail", method: "GET", run: async () => outcome("failed"),
        responseContract: { expectedStatuses: [200], assert: () => ({ passed: true }) } },
      // no assert → not_run, not_declared
      { kind: "no-assert", method: "GET", run: async () => outcome("completed", 200),
        responseContract: { expectedStatuses: [200] } },
      // status excluded → not_run, status_not_applicable
      { kind: "excluded", method: "GET", run: async () => outcome("completed", 429),
        responseContract: { expectedStatuses: [200, 429], assertOnStatuses: [200], assert: () => ({ passed: true }) } },
    ];
    const r = await runContractedBurst(ops, { concurrency: 3, pacing: { mode: "none" } });
    const reasons = r.results.map(x => x.assertionNotRunReason).filter(Boolean);
    expect(reasons).toContain("transport_failed");
    expect(reasons).toContain("not_declared");
    expect(reasons).toContain("status_not_applicable");
    // All three are not_run
    expect(r.assertionNotRun).toBe(3);
  });
});

// Fix 5g: Network-free pagination descriptor (no assert, no assertOnStatuses)
describe("gate RC-15: pagination status-only descriptor", () => {
  it("descriptor with expectedStatuses but no assert does not fail preflight", async () => {
    const ops = [{
      kind: "pagination", method: "GET",
      run: async () => outcome("completed", 200),
      responseContract: { expectedStatuses: [200, 429] },
    }];
    const r = await runContractedBurst(ops, { concurrency: 1, pacing: { mode: "none" } });
    expect(r.httpExpected).toBe(1);
    expect(r.results[0].assertion).toBe("not_run");
    expect(r.results[0].assertionNotRunReason).toBe("not_declared");
  });
});

// ─── Round-4: sanitized malformed-return reasons + static gate tests ──────

// Fix 1: malformed-return reasons must be sanitized and bounded
describe("gate RC-16: sanitized malformed-return reasons", () => {
  it("long secret-bearing passed value → reason does not contain secret, is bounded", async () => {
    const secret = "Bearer sk-ant-" + "x".repeat(300);
    const ops = [{
      kind: "leak-test", method: "POST",
      run: async () => outcome("completed", 200),
      responseContract: { expectedStatuses: [200], assert: () => ({ passed: secret }) },
    }];
    let caught;
    try { await runContractedBurst(ops, { concurrency: 1, pacing: { mode: "none" } }); }
    catch (e) { caught = e; }
    expect(caught.code).toBe("BURST_OPERATION_REJECTED");
    expect(caught.operation.id).toBe(0);
    expect(caught.operation.kind).toBe("leak-test");
    expect(caught.operation.method).toBe("POST");
    // The secret must NOT appear in the reason.
    expect(caught.reason).not.toContain("sk-ant");
    expect(caught.reason).not.toContain("Bearer");
    // The reason must be bounded.
    expect(caught.reason.length).toBeLessThanOrEqual(200);
    // The reason should describe the type (string), not the value.
    expect(caught.reason).toContain("string");
  });

  it("secret-bearing code in passed:false return → reason sanitized", async () => {
    const secretCode = "Bearer sk-ant-secret123";
    const ops = [{
      kind: "code-leak", method: "GET",
      run: async () => outcome("completed", 200),
      responseContract: { expectedStatuses: [200], assert: () => ({ passed: false, code: secretCode, message: "x" }) },
    }];
    let caught;
    try { await runContractedBurst(ops, { concurrency: 1, pacing: { mode: "none" } }); }
    catch (e) { caught = e; }
    expect(caught.code).toBe("BURST_OPERATION_REJECTED");
    // The secret code must not appear in the reason.
    expect(caught.reason).not.toContain("sk-ant-secret123");
  });
});
