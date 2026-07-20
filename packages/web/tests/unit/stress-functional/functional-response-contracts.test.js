// tests/unit/stress-functional/functional-response-contracts.test.js
//
// Engine-driven functional response-contract matrix. Each record-producing
// case runs a one-operation contracted burst via runContractedOperation,
// normalizes the real result through createAttemptRecord, reduces via
// buildOperationReport, and asserts the EXACT:
//   1. full engine result (all classification fields, with volatile
//      durationMs normalized away);
//   2. full normalized attempt record (all declared fields);
//   3. complete reduced logical AND attempt counter objects.
//
// Two fatal-harness-defect cases (assertion throws, assertion returns
// malformed value) assert the engine's full safe-error contract, including
// the exact message and sanitized reason — they do NOT produce attempt
// records.
//
// All cases are network-free: operation run() returns scripted
// ClassifiedOutcomes directly. Deterministic clock is injected so durationMs
// is a known small value (the clock advances only when the scheduler reads
// it, which is exactly twice per single operation: start + settle).

import { describe, it, expect } from "@jest/globals";
import { runContractedOperation } from "../../stress/burst-runner.js";
import { createAttemptRecord, buildOperationReport } from "../../stress/modules/operation-accounting.js";

// ─── Deterministic clock ──────────────────────────────────────────────────
//
// runContractedOperation accepts a `now` override. Each call advances t by
// 10, so a single-operation run records two reads (start, settle) →
// durationMs = 10 (second read minus first). Pinning this value keeps
// durationMs out of the "volatile" bucket: it is fully deterministic.

function detClock() {
  let t = 1000;
  return {
    now: () => (t += 10),
    sleep: async () => { t += 1; await Promise.resolve(); },
  };
}

// The expected durationMs for a single-op run with the clock above.
const EXPECTED_DURATION_MS = 10;

// ─── Outcome builders for scripted operations ────────────────────────────

function completedOutcome(status, body) {
  return {
    transport: "completed",
    status,
    body: body ?? { state: "empty", value: null, error: null },
    error: null,
  };
}

function failedOutcome(errorOpts) {
  return {
    transport: "failed",
    status: null,
    body: { state: "not_read", value: null, error: null },
    error: { category: errorOpts.category, name: "Error", code: errorOpts.code, message: errorOpts.message },
  };
}

// Run a contracted operation and produce its accounting report.
async function runAndAccount(operation, logicalOperationId) {
  const clk = detClock();
  const result = await runContractedOperation(operation, { now: clk.now, sleep: clk.sleep });
  const record = createAttemptRecord(result, {
    logicalOperationId,
    attemptId: `${logicalOperationId}:1`,
    attemptNumber: 1,
    retryable: false,
    final: true,
  });
  const report = buildOperationReport([record]);
  return { result, record, report };
}

// ─── 10 record-producing functional cases ─────────────────────────────────
//
// Each case asserts the EXACT full result, full record, and full counter
// objects. durationMs is the pinned deterministic value; the engine always
// returns `assertionError: null` on success and on not_run.

describe("functional response contracts — record-producing cases", () => {
  it("case 1: expected status + assertion passes → succeeded", async () => {
    const { result, record, report } = await runAndAccount({
      kind: "c1", method: "GET",
      run: async () => completedOutcome(200, { state: "parsed", value: { ok: true }, error: null }),
      responseContract: {
        expectedStatuses: [200],
        assert: ({ body }) => body.value && body.value.ok
          ? { passed: true }
          : { passed: false, code: "BODY_NO_OK", message: "missing ok" },
      },
    }, "case-expected-pass");

    // 1. Full engine result.
    expect(result).toEqual({
      id: 0, kind: "c1", method: "GET", durationMs: EXPECTED_DURATION_MS,
      transport: "completed", status: 200,
      body: { state: "parsed", value: { ok: true }, error: null },
      error: null,
      http: "expected", assertion: "passed", assertionNotRunReason: null, assertionError: null,
    });
    // 2. Full normalized record.
    expect(record).toEqual({
      logicalOperationId: "case-expected-pass", attemptId: "case-expected-pass:1", attemptNumber: 1,
      kind: "c1", method: "GET",
      transport: "completed", http: "expected", assertion: "passed",
      status: 200,
      body: { state: "parsed", value: { ok: true }, error: null },
      error: null, assertionError: null, assertionNotRunReason: null,
      durationMs: EXPECTED_DURATION_MS,
      retryable: false, final: true, outcome: "succeeded",
    });
    // 3. Exact counters.
    expect(report.logical).toEqual({ total: 1, started: 1, completed: 1, inFlight: 0, succeeded: 1, failed: 0 });
    expect(report.attempts).toEqual({
      total: 1, started: 1, completed: 1, inFlight: 0,
      transportFailed: 0, responseReceived: 1,
      expectedStatus: 1, unexpectedStatus: 0,
      assertionPassed: 1, assertionFailed: 0, assertionNotRun: 0,
    });
  });

  it("case 2: expected status + assertion fails → failed", async () => {
    const { result, record, report } = await runAndAccount({
      kind: "c2", method: "GET",
      run: async () => completedOutcome(200, { state: "parsed", value: { ok: false }, error: null }),
      responseContract: {
        expectedStatuses: [200],
        assert: ({ body }) => body.value && body.value.ok
          ? { passed: true }
          : { passed: false, code: "BODY_NO_OK", message: "missing ok" },
      },
    }, "case-expected-fail");

    expect(result.http).toBe("expected");
    expect(result.assertion).toBe("failed");
    expect(result.assertionError).toEqual({ code: "BODY_NO_OK", message: "missing ok" });
    expect(record).toEqual({
      logicalOperationId: "case-expected-fail", attemptId: "case-expected-fail:1", attemptNumber: 1,
      kind: "c2", method: "GET",
      transport: "completed", http: "expected", assertion: "failed",
      status: 200,
      body: { state: "parsed", value: { ok: false }, error: null },
      error: null,
      assertionError: { code: "BODY_NO_OK", message: "missing ok" },
      assertionNotRunReason: null,
      durationMs: EXPECTED_DURATION_MS,
      retryable: false, final: true, outcome: "failed",
    });
    expect(report.logical).toEqual({ total: 1, started: 1, completed: 1, inFlight: 0, succeeded: 0, failed: 1 });
    expect(report.attempts).toEqual({
      total: 1, started: 1, completed: 1, inFlight: 0,
      transportFailed: 0, responseReceived: 1,
      expectedStatus: 1, unexpectedStatus: 0,
      assertionPassed: 0, assertionFailed: 1, assertionNotRun: 0,
    });
  });

  it("case 3: expected status + no assertion → not_run, succeeded (status-only contract)", async () => {
    const { result, record, report } = await runAndAccount({
      kind: "c3", method: "GET",
      run: async () => completedOutcome(200),
      responseContract: { expectedStatuses: [200] },
    }, "case-expected-no-assert");

    expect(result.http).toBe("expected");
    expect(result.assertion).toBe("not_run");
    expect(result.assertionNotRunReason).toBe("not_declared");
    expect(record).toEqual({
      logicalOperationId: "case-expected-no-assert", attemptId: "case-expected-no-assert:1", attemptNumber: 1,
      kind: "c3", method: "GET",
      transport: "completed", http: "expected", assertion: "not_run",
      status: 200,
      body: { state: "empty", value: null, error: null },
      error: null, assertionError: null, assertionNotRunReason: "not_declared",
      durationMs: EXPECTED_DURATION_MS,
      retryable: false, final: true, outcome: "succeeded",
    });
    expect(report.attempts.assertionNotRun).toBe(1);
    expect(report.logical.succeeded).toBe(1);
  });

  it("case 4: unexpected status → failed", async () => {
    const { result, record, report } = await runAndAccount({
      kind: "c4", method: "GET",
      run: async () => completedOutcome(503, { state: "parsed", value: { error: "busy" }, error: null }),
      responseContract: { expectedStatuses: [200] },
    }, "case-unexpected");

    expect(result.http).toBe("unexpected");
    expect(result.assertion).toBe("not_run");
    expect(result.assertionNotRunReason).toBe("not_declared");
    expect(record).toEqual({
      logicalOperationId: "case-unexpected", attemptId: "case-unexpected:1", attemptNumber: 1,
      kind: "c4", method: "GET",
      transport: "completed", http: "unexpected", assertion: "not_run",
      status: 503,
      body: { state: "parsed", value: { error: "busy" }, error: null },
      error: null, assertionError: null, assertionNotRunReason: "not_declared",
      durationMs: EXPECTED_DURATION_MS,
      retryable: false, final: true, outcome: "failed",
    });
    expect(report.attempts.unexpectedStatus).toBe(1);
    expect(report.logical.failed).toBe(1);
  });

  it("case 5: transport rejection (connection_refused) → failed", async () => {
    const { result, record, report } = await runAndAccount({
      kind: "c5", method: "GET",
      run: async () => failedOutcome({ category: "connection_refused", code: "ECONNREFUSED", message: "refused" }),
      responseContract: { expectedStatuses: [200] },
    }, "case-transport-reject");

    expect(result.transport).toBe("failed");
    expect(result.status).toBe(null);
    expect(result.http).toBe("not_received");
    expect(result.assertion).toBe("not_run");
    expect(result.assertionNotRunReason).toBe("transport_failed");
    expect(result.error).toEqual({ category: "connection_refused", name: "Error", code: "ECONNREFUSED", message: "refused" });
    expect(record).toEqual({
      logicalOperationId: "case-transport-reject", attemptId: "case-transport-reject:1", attemptNumber: 1,
      kind: "c5", method: "GET",
      transport: "failed", http: "not_received", assertion: "not_run",
      status: null,
      body: { state: "not_read", value: null, error: null },
      error: { category: "connection_refused", name: "Error", code: "ECONNREFUSED", message: "refused" },
      assertionError: null, assertionNotRunReason: "transport_failed",
      durationMs: EXPECTED_DURATION_MS,
      retryable: false, final: true, outcome: "failed",
    });
    expect(report.attempts.transportFailed).toBe(1);
    expect(report.attempts.responseReceived).toBe(0);
    expect(report.logical.failed).toBe(1);
  });

  it("case 6: timeout → failed", async () => {
    const { result, record, report } = await runAndAccount({
      kind: "c6", method: "GET",
      run: async () => failedOutcome({ category: "timeout", code: "ETIMEDOUT", message: "timed out" }),
      responseContract: { expectedStatuses: [200] },
    }, "case-timeout");

    expect(result.error).toEqual({ category: "timeout", name: "Error", code: "ETIMEDOUT", message: "timed out" });
    expect(record.outcome).toBe("failed");
    expect(report.attempts.transportFailed).toBe(1);
  });

  it("case 7: abort → failed", async () => {
    const { result, record, report } = await runAndAccount({
      kind: "c7", method: "GET",
      run: async () => failedOutcome({ category: "abort", code: "ABORT_ERR", message: "aborted" }),
      responseContract: { expectedStatuses: [200] },
    }, "case-abort");

    expect(result.error).toEqual({ category: "abort", name: "Error", code: "ABORT_ERR", message: "aborted" });
    expect(record.outcome).toBe("failed");
    expect(report.attempts.transportFailed).toBe(1);
  });

  it("case 8: body parse failure + explicit body-parsed assertion → failed", async () => {
    // A response with body.state=parse_failed would derive as "succeeded"
    // under the auto outcome rule. The case pins an explicit assert that
    // requires body.state=parsed, so the parse failure surfaces as
    // assertion=failed.
    const { result, record, report } = await runAndAccount({
      kind: "c8", method: "GET",
      run: async () => ({
        transport: "completed", status: 200,
        body: { state: "parse_failed", value: null, error: { category: "body_parse", message: "invalid JSON" } },
        error: null,
      }),
      responseContract: {
        expectedStatuses: [200],
        assert: ({ body }) => body.state === "parsed"
          ? { passed: true }
          : { passed: false, code: "BODY_NOT_PARSED", message: "response body was not parsed" },
      },
    }, "case-body-parse-fail");

    expect(result.http).toBe("expected");
    expect(result.assertion).toBe("failed");
    expect(result.body).toEqual({ state: "parse_failed", value: null, error: { category: "body_parse", message: "invalid JSON" } });
    expect(record).toEqual({
      logicalOperationId: "case-body-parse-fail", attemptId: "case-body-parse-fail:1", attemptNumber: 1,
      kind: "c8", method: "GET",
      transport: "completed", http: "expected", assertion: "failed",
      status: 200,
      body: { state: "parse_failed", value: null, error: { category: "body_parse", message: "invalid JSON" } },
      error: null,
      assertionError: { code: "BODY_NOT_PARSED", message: "response body was not parsed" },
      assertionNotRunReason: null,
      durationMs: EXPECTED_DURATION_MS,
      retryable: false, final: true, outcome: "failed",
    });
    expect(report.attempts.assertionFailed).toBe(1);
    expect(report.logical.failed).toBe(1);
  });

  it("case 11: empty body where allowed (status-only contract) → succeeded", async () => {
    const { result, record, report } = await runAndAccount({
      kind: "c11", method: "GET",
      run: async () => completedOutcome(200), // no body → state:"empty"
      responseContract: { expectedStatuses: [200] },
    }, "case-empty-allowed");

    expect(result.body).toEqual({ state: "empty", value: null, error: null });
    expect(record.body).toEqual({ state: "empty", value: null, error: null });
    expect(record.outcome).toBe("succeeded");
    expect(report.logical.succeeded).toBe(1);
  });

  it("case 12: empty body where prohibited (assert requires parsed) → failed", async () => {
    const { result, record, report } = await runAndAccount({
      kind: "c12", method: "GET",
      run: async () => completedOutcome(200), // body.state="empty"
      responseContract: {
        expectedStatuses: [200],
        assert: ({ body }) => body.state === "parsed"
          ? { passed: true }
          : { passed: false, code: "BODY_REQUIRED", message: "response body required" },
      },
    }, "case-empty-prohibited");

    expect(result.body).toEqual({ state: "empty", value: null, error: null });
    expect(record).toEqual({
      logicalOperationId: "case-empty-prohibited", attemptId: "case-empty-prohibited:1", attemptNumber: 1,
      kind: "c12", method: "GET",
      transport: "completed", http: "expected", assertion: "failed",
      status: 200,
      body: { state: "empty", value: null, error: null },
      error: null,
      assertionError: { code: "BODY_REQUIRED", message: "response body required" },
      assertionNotRunReason: null,
      durationMs: EXPECTED_DURATION_MS,
      retryable: false, final: true, outcome: "failed",
    });
    expect(report.logical.failed).toBe(1);
  });
});

// ─── 2 fatal harness-defect cases ─────────────────────────────────────────
//
// The contracted engine throws BURST_OPERATION_REJECTED for assertion-
// programming defects. These cases pin the FULL safe-error contract,
// including the exact message and sanitized reason string.

describe("functional response contracts — fatal harness-defect cases", () => {
  it("case 9: assertion callback throws → BURST_OPERATION_REJECTED with full attribution", async () => {
    const op = {
      kind: "c9", method: "GET",
      run: async () => completedOutcome(200, { state: "parsed", value: {}, error: null }),
      responseContract: {
        expectedStatuses: [200],
        assert: () => { throw new Error("assertion boom"); },
      },
    };
    const clk = detClock();
    let caught = null;
    try {
      await runContractedOperation(op, { now: clk.now, sleep: clk.sleep });
    } catch (err) {
      caught = err;
    }
    expect(caught).not.toBeNull();
    // Full safe-error contract.
    expect(caught.code).toBe("BURST_OPERATION_REJECTED");
    expect(caught.message).toBe("operation 0 assertion callback threw");
    expect(caught.operation).toEqual({ id: 0, kind: "c9", method: "GET" });
    // Sanitized reason — the assertion's thrown message, bounded and cleaned.
    expect(caught.reason).toBe("assertion boom");
  });

  it("case 10: assertion returns malformed value (passed:42) → BURST_OPERATION_REJECTED", async () => {
    const op = {
      kind: "c10", method: "GET",
      run: async () => completedOutcome(200, { state: "parsed", value: {}, error: null }),
      responseContract: {
        expectedStatuses: [200],
        // passed must be exactly true|false; 42 is malformed.
        assert: () => ({ passed: 42 }),
      },
    };
    const clk = detClock();
    let caught = null;
    try {
      await runContractedOperation(op, { now: clk.now, sleep: clk.sleep });
    } catch (err) {
      caught = err;
    }
    expect(caught).not.toBeNull();
    expect(caught.code).toBe("BURST_OPERATION_REJECTED");
    expect(caught.message).toBe("operation 0 assertion callback returned unknown passed value");
    expect(caught.operation).toEqual({ id: 0, kind: "c10", method: "GET" });
    // Sanitized reason uses typeof (a fixed, bounded string) — never
    // interpolates the raw passed value, which could be excessively long
    // or secret-bearing.
    expect(caught.reason).toBe("passed must be exactly true or false; received number");
  });
});

// ─── Cross-case reconciliation ────────────────────────────────────────────

describe("functional response contracts — counter reconciliation", () => {
  it("aggregate invariants hold for a mixed-case batch", async () => {
    // Build a single batch from one record of each non-fatal classification
    // family and verify the canonical invariants from the spec section 5:
    //   attempts.transportFailed + attempts.responseReceived === attempts.completed
    //   attempts.expectedStatus + attempts.unexpectedStatus === attempts.responseReceived
    //   attempts.assertionPassed + attempts.assertionFailed + attempts.assertionNotRun === attempts.completed
    //   logical.succeeded + logical.failed === logical.completed
    const cases = [
      { lid: "b1", run: async () => completedOutcome(200, { state: "parsed", value: { ok: 1 }, error: null }),
        contract: { expectedStatuses: [200], assert: () => ({ passed: true }) } },
      { lid: "b2", run: async () => completedOutcome(200, { state: "parsed", value: {}, error: null }),
        contract: { expectedStatuses: [200], assert: () => ({ passed: false, code: "X", message: "y" }) } },
      { lid: "b3", run: async () => completedOutcome(503), contract: { expectedStatuses: [200] } },
      { lid: "b4", run: async () => failedOutcome({ category: "timeout", code: "ETIMEDOUT", message: "m" }),
        contract: { expectedStatuses: [200] } },
      { lid: "b5", run: async () => completedOutcome(200), contract: { expectedStatuses: [200] } },
    ];

    const records = [];
    for (const c of cases) {
      const clk = detClock();
      const result = await runContractedOperation({
        kind: c.lid, method: "GET", run: c.run, responseContract: c.contract,
      }, { now: clk.now, sleep: clk.sleep });
      records.push(createAttemptRecord(result, {
        logicalOperationId: c.lid, attemptId: `${c.lid}:1`,
        attemptNumber: 1, retryable: false, final: true,
      }));
    }

    const report = buildOperationReport(records);
    expect(report.violations).toEqual([]);

    const a = report.attempts;
    const l = report.logical;
    expect(a.transportFailed + a.responseReceived).toBe(a.completed);
    expect(a.expectedStatus + a.unexpectedStatus).toBe(a.responseReceived);
    expect(a.assertionPassed + a.assertionFailed + a.assertionNotRun).toBe(a.completed);
    expect(l.succeeded + l.failed).toBe(l.completed);
    // Specifics: 1 passed + 1 failed-assert + 1 unexpected + 1 transport-failed + 1 status-only.
    expect(a).toEqual({
      total: 5, started: 5, completed: 5, inFlight: 0,
      transportFailed: 1, responseReceived: 4,
      expectedStatus: 3, unexpectedStatus: 1,
      assertionPassed: 1, assertionFailed: 1, assertionNotRun: 3,
    });
    expect(l).toEqual({ total: 5, started: 5, completed: 5, inFlight: 0, succeeded: 2, failed: 3 });
  });
});
