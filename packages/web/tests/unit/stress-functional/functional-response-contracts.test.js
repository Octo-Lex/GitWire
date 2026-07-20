// tests/unit/stress-functional/functional-response-contracts.test.js
//
// Engine-driven functional response-contract matrix. Every record-producing
// case runs a one-operation contracted burst via runContractedOperation,
// normalizes the real result through createAttemptRecord, reduces via
// buildOperationReport, and asserts the EXACT full:
//   1. engine result (all fields, with durationMs pinned via deterministic clock);
//   2. normalized attempt record (all declared fields);
//   3. complete logical AND attempt counter objects;
//   4. logicalOperations entry and attemptsById entry.
//
// Two fatal-harness-defect cases pin the full safe-error contract. One
// cross-case reconciliation verifies the spec section-5 invariants.

import { describe, it, expect } from "@jest/globals";
import { runContractedOperation } from "../../stress/burst-runner.js";
import { createAttemptRecord, buildOperationReport } from "../../stress/modules/operation-accounting.js";

// ─── Deterministic clock ──────────────────────────────────────────────────
//
// runContractedOperation accepts a `now` override. Each call advances t by
// 10, so a single-op run records two reads (opStart + durationMs) →
// durationMs = 10. Pinning this value keeps durationMs out of the "volatile"
// bucket: it is fully deterministic and asserted exactly.

function detClock() {
  let t = 1000;
  return {
    now: () => (t += 10),
    sleep: async () => { t += 1; await Promise.resolve(); },
  };
}

const DURATION_MS = 10; // pinned: (t_after_settle) - (t_at_start) = 10

// ─── Outcome builders ─────────────────────────────────────────────────────

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

// ─── 10 record-producing functional cases (table-driven, exact-full) ──────

describe("functional response contracts — record-producing cases (exact full outputs)", () => {
  const cases = [
    {
      label: "case 1: expected status + assertion passes → succeeded",
      lid: "case-expected-pass",
      op: () => ({
        kind: "c1", method: "GET",
        run: async () => completedOutcome(200, { state: "parsed", value: { ok: true }, error: null }),
        responseContract: {
          expectedStatuses: [200],
          assert: ({ body }) => body.value && body.value.ok
            ? { passed: true }
            : { passed: false, code: "BODY_NO_OK", message: "missing ok" },
        },
      }),
      // Expected full result + record + counters.
      expectedResultShape: { transport: "completed", status: 200, http: "expected", assertion: "passed",
        body: { state: "parsed", value: { ok: true }, error: null }, error: null,
        assertionError: null, assertionNotRunReason: null },
      expectedRecord: { outcome: "succeeded" },
      expectedLogical: { total: 1, started: 1, completed: 1, inFlight: 0, succeeded: 1, failed: 0 },
      expectedAttempts: { total: 1, started: 1, completed: 1, inFlight: 0,
        transportFailed: 0, responseReceived: 1, expectedStatus: 1, unexpectedStatus: 0,
        assertionPassed: 1, assertionFailed: 0, assertionNotRun: 0 },
    },
    {
      label: "case 2: expected status + assertion fails → failed",
      lid: "case-expected-fail",
      op: () => ({
        kind: "c2", method: "GET",
        run: async () => completedOutcome(200, { state: "parsed", value: { ok: false }, error: null }),
        responseContract: {
          expectedStatuses: [200],
          assert: ({ body }) => body.value && body.value.ok
            ? { passed: true }
            : { passed: false, code: "BODY_NO_OK", message: "missing ok" },
        },
      }),
      expectedResultShape: { transport: "completed", status: 200, http: "expected", assertion: "failed",
        body: { state: "parsed", value: { ok: false }, error: null }, error: null,
        assertionError: { code: "BODY_NO_OK", message: "missing ok" }, assertionNotRunReason: null },
      expectedRecord: { outcome: "failed" },
      expectedLogical: { total: 1, started: 1, completed: 1, inFlight: 0, succeeded: 0, failed: 1 },
      expectedAttempts: { total: 1, started: 1, completed: 1, inFlight: 0,
        transportFailed: 0, responseReceived: 1, expectedStatus: 1, unexpectedStatus: 0,
        assertionPassed: 0, assertionFailed: 1, assertionNotRun: 0 },
    },
    {
      label: "case 3: expected status + no assertion → not_run, succeeded (status-only)",
      lid: "case-expected-no-assert",
      op: () => ({
        kind: "c3", method: "GET",
        run: async () => completedOutcome(200),
        responseContract: { expectedStatuses: [200] },
      }),
      expectedResultShape: { transport: "completed", status: 200, http: "expected", assertion: "not_run",
        body: { state: "empty", value: null, error: null }, error: null,
        assertionError: null, assertionNotRunReason: "not_declared" },
      expectedRecord: { outcome: "succeeded" },
      expectedLogical: { total: 1, started: 1, completed: 1, inFlight: 0, succeeded: 1, failed: 0 },
      expectedAttempts: { total: 1, started: 1, completed: 1, inFlight: 0,
        transportFailed: 0, responseReceived: 1, expectedStatus: 1, unexpectedStatus: 0,
        assertionPassed: 0, assertionFailed: 0, assertionNotRun: 1 },
    },
    {
      label: "case 4: unexpected status → failed",
      lid: "case-unexpected",
      op: () => ({
        kind: "c4", method: "GET",
        run: async () => completedOutcome(503, { state: "parsed", value: { error: "busy" }, error: null }),
        responseContract: { expectedStatuses: [200] },
      }),
      expectedResultShape: { transport: "completed", status: 503, http: "unexpected", assertion: "not_run",
        body: { state: "parsed", value: { error: "busy" }, error: null }, error: null,
        assertionError: null, assertionNotRunReason: "not_declared" },
      expectedRecord: { outcome: "failed" },
      expectedLogical: { total: 1, started: 1, completed: 1, inFlight: 0, succeeded: 0, failed: 1 },
      expectedAttempts: { total: 1, started: 1, completed: 1, inFlight: 0,
        transportFailed: 0, responseReceived: 1, expectedStatus: 0, unexpectedStatus: 1,
        assertionPassed: 0, assertionFailed: 0, assertionNotRun: 1 },
    },
    {
      label: "case 5: transport rejection (connection_refused) → failed",
      lid: "case-transport-reject",
      op: () => ({
        kind: "c5", method: "GET",
        run: async () => failedOutcome({ category: "connection_refused", code: "ECONNREFUSED", message: "refused" }),
        responseContract: { expectedStatuses: [200] },
      }),
      expectedResultShape: { transport: "failed", status: null, http: "not_received", assertion: "not_run",
        body: { state: "not_read", value: null, error: null },
        error: { category: "connection_refused", name: "Error", code: "ECONNREFUSED", message: "refused" },
        assertionError: null, assertionNotRunReason: "transport_failed" },
      expectedRecord: { outcome: "failed" },
      expectedLogical: { total: 1, started: 1, completed: 1, inFlight: 0, succeeded: 0, failed: 1 },
      expectedAttempts: { total: 1, started: 1, completed: 1, inFlight: 0,
        transportFailed: 1, responseReceived: 0, expectedStatus: 0, unexpectedStatus: 0,
        assertionPassed: 0, assertionFailed: 0, assertionNotRun: 1 },
    },
    {
      label: "case 6: timeout → failed",
      lid: "case-timeout",
      op: () => ({
        kind: "c6", method: "GET",
        run: async () => failedOutcome({ category: "timeout", code: "ETIMEDOUT", message: "timed out" }),
        responseContract: { expectedStatuses: [200] },
      }),
      expectedResultShape: { transport: "failed", status: null, http: "not_received", assertion: "not_run",
        body: { state: "not_read", value: null, error: null },
        error: { category: "timeout", name: "Error", code: "ETIMEDOUT", message: "timed out" },
        assertionError: null, assertionNotRunReason: "transport_failed" },
      expectedRecord: { outcome: "failed" },
      expectedLogical: { total: 1, started: 1, completed: 1, inFlight: 0, succeeded: 0, failed: 1 },
      expectedAttempts: { total: 1, started: 1, completed: 1, inFlight: 0,
        transportFailed: 1, responseReceived: 0, expectedStatus: 0, unexpectedStatus: 0,
        assertionPassed: 0, assertionFailed: 0, assertionNotRun: 1 },
    },
    {
      label: "case 7: abort → failed",
      lid: "case-abort",
      op: () => ({
        kind: "c7", method: "GET",
        run: async () => failedOutcome({ category: "abort", code: "ABORT_ERR", message: "aborted" }),
        responseContract: { expectedStatuses: [200] },
      }),
      expectedResultShape: { transport: "failed", status: null, http: "not_received", assertion: "not_run",
        body: { state: "not_read", value: null, error: null },
        error: { category: "abort", name: "Error", code: "ABORT_ERR", message: "aborted" },
        assertionError: null, assertionNotRunReason: "transport_failed" },
      expectedRecord: { outcome: "failed" },
      expectedLogical: { total: 1, started: 1, completed: 1, inFlight: 0, succeeded: 0, failed: 1 },
      expectedAttempts: { total: 1, started: 1, completed: 1, inFlight: 0,
        transportFailed: 1, responseReceived: 0, expectedStatus: 0, unexpectedStatus: 0,
        assertionPassed: 0, assertionFailed: 0, assertionNotRun: 1 },
    },
    {
      label: "case 8: body parse failure + explicit body-parsed assertion → failed",
      lid: "case-body-parse-fail",
      op: () => ({
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
      }),
      expectedResultShape: { transport: "completed", status: 200, http: "expected", assertion: "failed",
        body: { state: "parse_failed", value: null, error: { category: "body_parse", message: "invalid JSON" } },
        error: null,
        assertionError: { code: "BODY_NOT_PARSED", message: "response body was not parsed" },
        assertionNotRunReason: null },
      expectedRecord: { outcome: "failed" },
      expectedLogical: { total: 1, started: 1, completed: 1, inFlight: 0, succeeded: 0, failed: 1 },
      expectedAttempts: { total: 1, started: 1, completed: 1, inFlight: 0,
        transportFailed: 0, responseReceived: 1, expectedStatus: 1, unexpectedStatus: 0,
        assertionPassed: 0, assertionFailed: 1, assertionNotRun: 0 },
    },
    {
      label: "case 11: empty body where allowed (status-only contract) → succeeded",
      lid: "case-empty-allowed",
      op: () => ({
        kind: "c11", method: "GET",
        run: async () => completedOutcome(200),
        responseContract: { expectedStatuses: [200] },
      }),
      expectedResultShape: { transport: "completed", status: 200, http: "expected", assertion: "not_run",
        body: { state: "empty", value: null, error: null }, error: null,
        assertionError: null, assertionNotRunReason: "not_declared" },
      expectedRecord: { outcome: "succeeded" },
      expectedLogical: { total: 1, started: 1, completed: 1, inFlight: 0, succeeded: 1, failed: 0 },
      expectedAttempts: { total: 1, started: 1, completed: 1, inFlight: 0,
        transportFailed: 0, responseReceived: 1, expectedStatus: 1, unexpectedStatus: 0,
        assertionPassed: 0, assertionFailed: 0, assertionNotRun: 1 },
    },
    {
      label: "case 12: empty body where prohibited (assert requires parsed) → failed",
      lid: "case-empty-prohibited",
      op: () => ({
        kind: "c12", method: "GET",
        run: async () => completedOutcome(200),
        responseContract: {
          expectedStatuses: [200],
          assert: ({ body }) => body.state === "parsed"
            ? { passed: true }
            : { passed: false, code: "BODY_REQUIRED", message: "response body required" },
        },
      }),
      expectedResultShape: { transport: "completed", status: 200, http: "expected", assertion: "failed",
        body: { state: "empty", value: null, error: null }, error: null,
        assertionError: { code: "BODY_REQUIRED", message: "response body required" },
        assertionNotRunReason: null },
      expectedRecord: { outcome: "failed" },
      expectedLogical: { total: 1, started: 1, completed: 1, inFlight: 0, succeeded: 0, failed: 1 },
      expectedAttempts: { total: 1, started: 1, completed: 1, inFlight: 0,
        transportFailed: 0, responseReceived: 1, expectedStatus: 1, unexpectedStatus: 0,
        assertionPassed: 0, assertionFailed: 1, assertionNotRun: 0 },
    },
  ];

  for (const c of cases) {
    it(c.label, async () => {
      const { result, record, report } = await runAndAccount(c.op(), c.lid);

      // 1. Exact full engine result. Combine the pinned identity fields
      //    (id/kind/method from the op; durationMs from the deterministic
      //    clock) with the per-case shape.
      expect(result).toEqual({
        id: 0,
        kind: c.op().kind,
        method: "GET",
        durationMs: DURATION_MS,
        ...c.expectedResultShape,
      });

      // 2. Exact full normalized record. Identity fields are pinned by the
      //    adapter call; engine fields come from the result above.
      expect(record).toEqual({
        logicalOperationId: c.lid,
        attemptId: `${c.lid}:1`,
        attemptNumber: 1,
        kind: c.op().kind,
        method: "GET",
        transport: c.expectedResultShape.transport,
        http: c.expectedResultShape.http,
        assertion: c.expectedResultShape.assertion,
        status: c.expectedResultShape.status,
        body: c.expectedResultShape.body,
        error: c.expectedResultShape.error,
        assertionError: c.expectedResultShape.assertionError,
        assertionNotRunReason: c.expectedResultShape.assertionNotRunReason,
        durationMs: DURATION_MS,
        retryable: false,
        final: true,
        outcome: c.expectedRecord.outcome,
      });

      // 3. Exact complete counters.
      expect(report.violations).toEqual([]);
      expect(report.logical).toEqual(c.expectedLogical);
      expect(report.attempts).toEqual(c.expectedAttempts);

      // 4. logicalOperations entry + attemptsById entry.
      expect(report.logicalOperations).toEqual([
        {
          logicalOperationId: c.lid,
          attemptIds: [`${c.lid}:1`],
          attemptCount: 1,
          finalAttemptId: `${c.lid}:1`,
          outcome: c.expectedRecord.outcome,
        },
      ]);
      expect(Object.keys(report.attemptsById)).toEqual([`${c.lid}:1`]);
      expect(report.attemptsById[`${c.lid}:1`]).toEqual(record);
    });
  }
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
    expect(caught.code).toBe("BURST_OPERATION_REJECTED");
    expect(caught.message).toBe("operation 0 assertion callback threw");
    expect(caught.operation).toEqual({ id: 0, kind: "c9", method: "GET" });
    expect(caught.reason).toBe("assertion boom");
  });

  it("case 10: assertion returns malformed value (passed:42) → BURST_OPERATION_REJECTED", async () => {
    const op = {
      kind: "c10", method: "GET",
      run: async () => completedOutcome(200, { state: "parsed", value: {}, error: null }),
      responseContract: {
        expectedStatuses: [200],
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
    expect(caught.reason).toBe("passed must be exactly true or false; received number");
  });
});

// ─── Cross-case reconciliation ────────────────────────────────────────────

describe("functional response contracts — counter reconciliation", () => {
  it("aggregate invariants hold for a mixed-case batch", async () => {
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
    // Canonical invariants.
    expect(a.transportFailed + a.responseReceived).toBe(a.completed);
    expect(a.expectedStatus + a.unexpectedStatus).toBe(a.responseReceived);
    expect(a.assertionPassed + a.assertionFailed + a.assertionNotRun).toBe(a.completed);
    expect(l.succeeded + l.failed).toBe(l.completed);
    // Exact totals.
    expect(a).toEqual({
      total: 5, started: 5, completed: 5, inFlight: 0,
      transportFailed: 1, responseReceived: 4,
      expectedStatus: 3, unexpectedStatus: 1,
      assertionPassed: 1, assertionFailed: 1, assertionNotRun: 3,
    });
    expect(l).toEqual({ total: 5, started: 5, completed: 5, inFlight: 0, succeeded: 2, failed: 3 });
    // logicalOperations sorted by logicalOperationId; each carries its outcome.
    expect(report.logicalOperations.map((op) => [op.logicalOperationId, op.outcome])).toEqual([
      ["b1", "succeeded"],
      ["b2", "failed"],
      ["b3", "failed"],
      ["b4", "failed"],
      ["b5", "succeeded"],
    ]);
  });
});
