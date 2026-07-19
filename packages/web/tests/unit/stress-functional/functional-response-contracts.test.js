// tests/unit/stress-functional/functional-response-contracts.test.js
//
// Engine-driven functional response-contract matrix. Each record-producing
// case runs a one-operation contracted burst via runContractedOperation,
// normalizes the real result through createAttemptRecord, reduces via
// buildOperationReport, and asserts:
//   1. the full engine result (existing fields);
//   2. the full normalized attempt record (incl. outcome, retryable, final);
//   3. the exact reduced logical and attempt counters.
//
// Two additional fatal-harness-defect cases (assertion throws, assertion
// returns malformed value) assert the engine's safe error contract — they
// do NOT produce attempt records because no completed factual result exists.
//
// All cases are network-free: operation run() returns scripted
// ClassifiedOutcomes directly (no fetch). Deterministic clock + sleeper are
// injected to keep wall-clock out of correctness assertions.

import { describe, it, expect } from "@jest/globals";
import { runContractedOperation } from "../../stress/burst-runner.js";
import { createAttemptRecord, buildOperationReport } from "../../stress/modules/operation-accounting.js";
import { createClock } from "../../stress/modules/scenario-harness.js";

// ─── Deterministic clock/sleeper ──────────────────────────────────────────
//
// runContractedOperation accepts { now, sleep } overrides. We inject a
// deterministic clock so the durationMs recorded on the result is a known
// small value (the clock advances only when the scheduler reads it). The
// sleeper is never invoked in single-operation no-pacing runs but is
// accepted by the engine.

function detClock() {
  let t = 1000;
  return {
    now: () => (t += 10),
    sleep: async () => { t += 1; await Promise.resolve(); },
  };
}

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

    // 1. Engine result.
    expect(result).toMatchObject({ transport: "completed", status: 200, http: "expected", assertion: "passed" });
    // 2. Normalized record.
    expect(record).toMatchObject({
      logicalOperationId: "case-expected-pass", attemptId: "case-expected-pass:1", attemptNumber: 1,
      transport: "completed", http: "expected", assertion: "passed",
      retryable: false, final: true, outcome: "succeeded",
    });
    // 3. Reduced counters.
    expect(report.violations).toEqual([]);
    expect(report.logical).toEqual({ total: 1, started: 1, completed: 1, inFlight: 0, succeeded: 1, failed: 0 });
    expect(report.attempts).toMatchObject({ responseReceived: 1, expectedStatus: 1, assertionPassed: 1 });
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

    expect(result).toMatchObject({ http: "expected", assertion: "failed" });
    expect(record).toMatchObject({ outcome: "failed" });
    expect(record.assertionError).toMatchObject({ code: "BODY_NO_OK", message: "missing ok" });
    expect(report.attempts.assertionFailed).toBe(1);
    expect(report.logical.failed).toBe(1);
  });

  it("case 3: expected status + no assertion → not_run, succeeded (status-only contract)", async () => {
    const { result, record, report } = await runAndAccount({
      kind: "c3", method: "GET",
      run: async () => completedOutcome(200),
      responseContract: { expectedStatuses: [200] },
    }, "case-expected-no-assert");

    expect(result).toMatchObject({ http: "expected", assertion: "not_run" });
    expect(record).toMatchObject({ outcome: "succeeded" });
    expect(record.assertionNotRunReason).toBe("not_declared");
    expect(report.attempts.assertionNotRun).toBe(1);
    expect(report.logical.succeeded).toBe(1);
  });

  it("case 4: unexpected status → failed", async () => {
    const { result, record, report } = await runAndAccount({
      kind: "c4", method: "GET",
      run: async () => completedOutcome(503, { state: "parsed", value: { error: "busy" }, error: null }),
      responseContract: { expectedStatuses: [200] },
    }, "case-unexpected");

    expect(result).toMatchObject({ status: 503, http: "unexpected", assertion: "not_run" });
    expect(record).toMatchObject({ outcome: "failed" });
    expect(report.attempts.unexpectedStatus).toBe(1);
    expect(report.logical.failed).toBe(1);
  });

  it("case 5: transport rejection (connection_refused) → failed", async () => {
    const { result, record, report } = await runAndAccount({
      kind: "c5", method: "GET",
      run: async () => failedOutcome({ category: "connection_refused", code: "ECONNREFUSED", message: "refused" }),
      responseContract: { expectedStatuses: [200] },
    }, "case-transport-reject");

    expect(result).toMatchObject({ transport: "failed", status: null, http: "not_received", assertion: "not_run" });
    expect(result.error).toMatchObject({ category: "connection_refused", code: "ECONNREFUSED" });
    expect(record).toMatchObject({ outcome: "failed" });
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

    expect(result.error).toMatchObject({ category: "timeout", code: "ETIMEDOUT" });
    expect(record).toMatchObject({ outcome: "failed" });
    expect(report.attempts.transportFailed).toBe(1);
  });

  it("case 7: abort → failed", async () => {
    const { result, record, report } = await runAndAccount({
      kind: "c7", method: "GET",
      run: async () => failedOutcome({ category: "abort", code: "ABORT_ERR", message: "aborted" }),
      responseContract: { expectedStatuses: [200] },
    }, "case-abort");

    expect(result.error).toMatchObject({ category: "abort", code: "ABORT_ERR" });
    expect(record).toMatchObject({ outcome: "failed" });
    expect(report.attempts.transportFailed).toBe(1);
  });

  it("case 8: body parse failure + explicit body-parsed assertion → failed", async () => {
    // A response with body.state=parse_failed would derive as "succeeded"
    // under the auto outcome rule (transport=completed, http=expected,
    // assertion=not_run). The case pins an explicit assert that requires
    // body.state=parsed, so the parse failure surfaces as assertion=failed.
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

    expect(result).toMatchObject({ http: "expected", assertion: "failed" });
    expect(result.body).toMatchObject({ state: "parse_failed" });
    expect(record).toMatchObject({ outcome: "failed" });
    expect(record.assertionError).toMatchObject({ code: "BODY_NOT_PARSED" });
    expect(report.attempts.assertionFailed).toBe(1);
    expect(report.logical.failed).toBe(1);
  });

  it("case 11: empty body where allowed (status-only contract) → succeeded", async () => {
    const { result, record, report } = await runAndAccount({
      kind: "c11", method: "GET",
      run: async () => completedOutcome(200), // no body → state:"empty"
      responseContract: { expectedStatuses: [200] },
    }, "case-empty-allowed");

    expect(result.body).toMatchObject({ state: "empty" });
    expect(record).toMatchObject({ outcome: "succeeded" });
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

    expect(result.body).toMatchObject({ state: "empty" });
    expect(record).toMatchObject({ outcome: "failed", assertion: "failed" });
    expect(record.assertionError).toMatchObject({ code: "BODY_REQUIRED" });
    expect(report.logical.failed).toBe(1);
  });
});

// ─── 2 fatal harness-defect cases ─────────────────────────────────────────
//
// The contracted engine intentionally throws BURST_OPERATION_REJECTED for
// assertion-programming defects rather than returning a partial aggregate.
// These cases assert the full safe error contract — they do NOT produce
// attempt records and do NOT enter buildOperationReport.

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
    expect(caught.code).toBe("BURST_OPERATION_REJECTED");
    expect(caught.operation).toMatchObject({ id: 0, kind: "c9", method: "GET" });
    // Reason is sanitized (no full stack in summary reports).
    expect(typeof caught.reason).toBe("string");
    expect(caught.reason.length).toBeGreaterThan(0);
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
    expect(caught.operation).toMatchObject({ id: 0, kind: "c10", method: "GET" });
    expect(caught.reason).toMatch(/passed/i);
  });
});

// ─── Cross-check: counter reconciliation across all 10 record-producing cases ─

describe("functional response contracts — counter reconciliation", () => {
  it("aggregate invariants hold for a mixed-case batch", async () => {
    // Build a single batch from one record of each non-fatal classification
    // family and verify the canonical invariants from the spec section 5:
    //   attempts.transportFailed + attempts.responseReceived === attempts.completed
    //   attempts.expectedStatus + attempts.unexpectedStatus === attempts.responseReceived
    //   attempts.assertionPassed + attempts.assertionFailed + attempts.assertionNotRun === attempts.completed
    //   logical.succeeded + logical.failed === logical.completed
    const cases = [
      // passed
      { lid: "b1", run: async () => completedOutcome(200, { state: "parsed", value: { ok: 1 }, error: null }),
        contract: { expectedStatuses: [200], assert: () => ({ passed: true }) } },
      // failed-assertion
      { lid: "b2", run: async () => completedOutcome(200, { state: "parsed", value: {}, error: null }),
        contract: { expectedStatuses: [200], assert: () => ({ passed: false, code: "X", message: "y" }) } },
      // unexpected
      { lid: "b3", run: async () => completedOutcome(503), contract: { expectedStatuses: [200] } },
      // transport-failed
      { lid: "b4", run: async () => failedOutcome({ category: "timeout", code: "ETIMEDOUT", message: "m" }),
        contract: { expectedStatuses: [200] } },
      // not-run (status-only succeeded)
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
    // Specifics: 1 passed + 1 failed-assert + 1 unexpected + 1 transport-failed + 1 status-only
    expect(a.transportFailed).toBe(1);
    expect(a.responseReceived).toBe(4);
    expect(a.expectedStatus).toBe(3);
    expect(a.unexpectedStatus).toBe(1);
    expect(a.assertionPassed).toBe(1);
    expect(a.assertionFailed).toBe(1);
    expect(a.assertionNotRun).toBe(3); // unexpected + transport-failed + status-only
    expect(l.succeeded).toBe(2); // b1 (passed) + b5 (status-only)
    expect(l.failed).toBe(3);    // b2 + b3 + b4
  });
});
