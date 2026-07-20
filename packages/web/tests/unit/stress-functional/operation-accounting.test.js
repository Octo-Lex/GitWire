// tests/unit/stress-functional/operation-accounting.test.js
//
// Synthetic-record invariant tests for the pure accounting reducer. These
// do NOT invoke the burst engine — they prove the reducer's transactional
// contract, phase ordering, cascade suppression, and C4-readiness directly.
//
// Every negative test asserts the EXACT sorted violation array — full
// structured objects with code/message/attemptId/logicalOperationId/
// attemptNumber/phase — so secondary cascade findings, attribution
// drift, or message changes cannot appear without failing the suite.
//
// Companion file functional-response-contracts.test.js drives real engine
// output through createAttemptRecord + buildOperationReport.

import { describe, it, expect } from "@jest/globals";
import {
  createAttemptRecord,
  validateAttemptRecord,
  deriveAttemptOutcome,
  buildOperationReport,
} from "../../stress/modules/operation-accounting.js";

// ─── Helpers ──────────────────────────────────────────────────────────────

/**
 * Build a synthetic normalized attempt record directly, bypassing the
 * engine-result adapter.
 */
function makeAttemptRecord(overrides = {}) {
  const base = {
    logicalOperationId: "op-1",
    attemptId: "op-1:1",
    attemptNumber: 1,
    kind: "synthetic",
    method: "GET",
    transport: "completed",
    http: "expected",
    assertion: "passed",
    status: 200,
    body: { state: "parsed", value: null, error: null },
    error: null,
    assertionError: null,
    assertionNotRunReason: null,
    durationMs: 10,
    retryable: false,
    final: true,
    outcome: "succeeded",
  };
  return { ...base, ...overrides };
}

// A failed-transport variant of makeAttemptRecord, for sequence tests that
// need non-final failures (retry shapes).
function failedTransport(overrides = {}) {
  return makeAttemptRecord({
    transport: "failed", http: "not_received", assertion: "not_run",
    status: null, body: { state: "not_read", value: null, error: null },
    error: { category: "timeout", name: "Error", code: "ETIMEDOUT", message: "timed out" },
    assertionNotRunReason: "transport_failed",
    outcome: "failed",
    ...overrides,
  });
}

// Short constructors for the canonical Phase-1/2/3/4 violation shapes.
// Keep these in sync with operation-accounting.js's `violation()` helper:
// fields are attached only when defined, so a violation without an
// attemptNumber omits that key entirely.
function v(code, message, { attemptId, logicalOperationId, attemptNumber, phase } = {}) {
  const o = { code, message };
  if (attemptId !== undefined) o.attemptId = attemptId;
  if (logicalOperationId !== undefined) o.logicalOperationId = logicalOperationId;
  if (attemptNumber !== undefined) o.attemptNumber = attemptNumber;
  if (phase !== undefined) o.phase = phase;
  return o;
}

const P1 = "phase_1_record_shape";
const P2 = "phase_2_engine_consistency";
const P3 = "phase_3_global_identity";
const P4 = "phase_4_logical_sequence";

// Zero-counter constants matching the module's internal ZERO_LOGICAL/ZERO_ATTEMPTS.
// Used for exact transactional-report assertions (zero aggregates on violation).
const ZERO_LOGICAL = Object.freeze({
  total: 0, started: 0, completed: 0, inFlight: 0, succeeded: 0, failed: 0,
});
const ZERO_ATTEMPTS = Object.freeze({
  total: 0, started: 0, completed: 0, inFlight: 0,
  transportFailed: 0, responseReceived: 0,
  expectedStatus: 0, unexpectedStatus: 0,
  assertionPassed: 0, assertionFailed: 0, assertionNotRun: 0,
});

// Exact violation-array comparison helper: violations are already sorted
// by the reducer's compareViolations, so we compare the array as-is.
function expectViolations(report, expectedSorted) {
  expect(report.violations).toEqual(expectedSorted);
}

// ─── deriveAttemptOutcome unit tests ──────────────────────────────────────

describe("deriveAttemptOutcome — 3-rule order", () => {
  it("transport=failed → failed", () => {
    expect(deriveAttemptOutcome({ transport: "failed", http: "not_received", assertion: "not_run" })).toBe("failed");
  });
  it("transport=completed but http=unexpected → failed", () => {
    expect(deriveAttemptOutcome({ transport: "completed", http: "unexpected", assertion: "not_run" })).toBe("failed");
  });
  it("transport=completed, http=expected, assertion=failed → failed", () => {
    expect(deriveAttemptOutcome({ transport: "completed", http: "expected", assertion: "failed" })).toBe("failed");
  });
  it("transport=completed, http=expected, assertion=not_run → succeeded (status-only contract)", () => {
    expect(deriveAttemptOutcome({ transport: "completed", http: "expected", assertion: "not_run" })).toBe("succeeded");
  });
  it("transport=completed, http=expected, assertion=passed → succeeded", () => {
    expect(deriveAttemptOutcome({ transport: "completed", http: "expected", assertion: "passed" })).toBe("succeeded");
  });
});

// ─── Valid reductions ─────────────────────────────────────────────────────

describe("buildOperationReport — valid single-attempt reductions", () => {
  it("single succeeded attempt → exact counters, logicalOperations, attemptsById", () => {
    const r = makeAttemptRecord();
    const report = buildOperationReport([r]);
    expect(report.violations).toEqual([]);
    expect(report.logical).toEqual({ total: 1, started: 1, completed: 1, inFlight: 0, succeeded: 1, failed: 0 });
    expect(report.attempts).toEqual({
      total: 1, started: 1, completed: 1, inFlight: 0,
      transportFailed: 0, responseReceived: 1,
      expectedStatus: 1, unexpectedStatus: 0,
      assertionPassed: 1, assertionFailed: 0, assertionNotRun: 0,
    });
    expect(report.logicalOperations).toEqual([
      { logicalOperationId: "op-1", attemptIds: ["op-1:1"], attemptCount: 1, finalAttemptId: "op-1:1", outcome: "succeeded" },
    ]);
    expect(Object.keys(report.attemptsById)).toEqual(["op-1:1"]);
    expect(report.attemptsById["op-1:1"]).toMatchObject({ attemptId: "op-1:1", outcome: "succeeded" });
  });

  it("single transport-failed attempt → counters reflect failure", () => {
    const r = failedTransport();
    const report = buildOperationReport([r]);
    expect(report.violations).toEqual([]);
    expect(report.attempts.transportFailed).toBe(1);
    expect(report.attempts.responseReceived).toBe(0);
    expect(report.attempts.assertionNotRun).toBe(1);
    expect(report.logical.failed).toBe(1);
    expect(report.logical.succeeded).toBe(0);
  });

  it("empty input → zero/empty report, no violations", () => {
    const report = buildOperationReport([]);
    expect(report.logical).toEqual({ total: 0, started: 0, completed: 0, inFlight: 0, succeeded: 0, failed: 0 });
    expect(report.attempts.total).toBe(0);
    expect(report.logicalOperations).toEqual([]);
    expect(report.violations).toEqual([]);
  });
});

// ─── Valid multi-attempt (C4-readiness) ───────────────────────────────────

describe("buildOperationReport — multi-attempt retry shapes (C4-ready)", () => {
  it("retry → success: logical outcome derived from final attempt only", () => {
    const records = [
      failedTransport({ attemptId: "op-1:1", attemptNumber: 1, final: false, retryable: true }),
      makeAttemptRecord({ attemptId: "op-1:2", attemptNumber: 2, final: true, retryable: false, outcome: "succeeded" }),
    ];
    const report = buildOperationReport(records);
    expect(report.violations).toEqual([]);
    expect(report.logical).toEqual({ total: 1, started: 1, completed: 1, inFlight: 0, succeeded: 1, failed: 0 });
    expect(report.attempts.total).toBe(2);
    expect(report.attempts.transportFailed).toBe(1);
    expect(report.attempts.responseReceived).toBe(1);
    expect(report.logicalOperations[0].outcome).toBe("succeeded");
    expect(report.logicalOperations[0].finalAttemptId).toBe("op-1:2");
  });

  it("retry → exhausted failure: final attempt failed with retryable=true is valid", () => {
    const records = [
      failedTransport({ attemptId: "op-1:1", attemptNumber: 1, final: false, retryable: true }),
      failedTransport({ attemptId: "op-1:2", attemptNumber: 2, final: false, retryable: true }),
      failedTransport({ attemptId: "op-1:3", attemptNumber: 3, final: true, retryable: true }),
    ];
    const report = buildOperationReport(records);
    expect(report.violations).toEqual([]);
    expect(report.logical.failed).toBe(1);
    expect(report.attempts.total).toBe(3);
    expect(report.attempts.transportFailed).toBe(3);
  });

  it("mixed logical operations in one input → separate logicalOperations entries", () => {
    const records = [
      makeAttemptRecord({ logicalOperationId: "op-b", attemptId: "op-b:1", attemptNumber: 1, final: true, retryable: false }),
      makeAttemptRecord({ logicalOperationId: "op-a", attemptId: "op-a:1", attemptNumber: 1, final: true, retryable: false }),
    ];
    const report = buildOperationReport(records);
    expect(report.violations).toEqual([]);
    expect(report.logical.total).toBe(2);
    expect(report.logicalOperations.map((op) => op.logicalOperationId)).toEqual(["op-a", "op-b"]);
  });
});

// ─── Transactional contract — exact violation arrays ─────────────────────

describe("buildOperationReport — transactional: any violation → zero aggregates", () => {
  it("duplicate attemptId → exact violation array, zero aggregates", () => {
    const records = [
      makeAttemptRecord({ attemptId: "op-1:1", attemptNumber: 1, final: true }),
      makeAttemptRecord({ attemptId: "op-1:1", attemptNumber: 1, final: true }),
    ];
    const report = buildOperationReport(records);
    expect(report.logical.total).toBe(0);
    expect(report.attempts.total).toBe(0);
    expect(report.logicalOperations).toEqual([]);
    // Violations are sorted by compareViolations: phase → logicalOperationId
    // → attemptNumber → attemptId → code. MULTIPLE_FINAL_ATTEMPTS has no
    // attemptNumber (-1) so sorts before DUPLICATE_ATTEMPT_NUMBER (1).
    expectViolations(report, [
      v("DUPLICATE_ATTEMPT_ID", "attemptId must be globally unique; duplicate at input index 1", { attemptId: "op-1:1", logicalOperationId: "op-1", phase: P3 }),
      v("MULTIPLE_FINAL_ATTEMPTS", "logical operation has 2 final attempts; expected exactly 1", { logicalOperationId: "op-1", phase: P4 }),
      v("DUPLICATE_ATTEMPT_NUMBER", "duplicate attemptNumber 1 within logical operation", { attemptId: "op-1:1", logicalOperationId: "op-1", attemptNumber: 1, phase: P4 }),
    ]);
  });

  it("non-array input throws INVALID_REPORT_ARG (only top-level arg throws)", () => {
    expect(() => buildOperationReport("not an array")).toThrow(/attemptRecords must be an array/);
    expect(() => buildOperationReport(null)).toThrow(/attemptRecords must be an array/);
    expect(() => buildOperationReport({})).toThrow(/attemptRecords must be an array/);
  });
});

// ─── B-fix regressions: malformed records, impossible semantics, cascade, mutation ─

describe("buildOperationReport — B-fix defect regressions", () => {
  it("null record → exact INVALID_ATTEMPT_RECORD violation, zero aggregates", () => {
    const report = buildOperationReport([null]);
    expectViolations(report, [
      v("INVALID_ATTEMPT_RECORD", "attempt record must be a non-null non-array object", { phase: P1 }),
    ]);
    expect(report.logical.total).toBe(0);
    expect(report.attempts.total).toBe(0);
  });

  it("primitive record → exact INVALID_ATTEMPT_RECORD violation", () => {
    expectViolations(buildOperationReport([42]), [
      v("INVALID_ATTEMPT_RECORD", "attempt record must be a non-null non-array object", { phase: P1 }),
    ]);
    expectViolations(buildOperationReport(["str"]), [
      v("INVALID_ATTEMPT_RECORD", "attempt record must be a non-null non-array object", { phase: P1 }),
    ]);
  });

  it("array record → exact INVALID_ATTEMPT_RECORD violation", () => {
    expectViolations(buildOperationReport([[]]), [
      v("INVALID_ATTEMPT_RECORD", "attempt record must be a non-null non-array object", { phase: P1 }),
    ]);
  });

  it("transport=completed + http=not_received → exact SEMANTIC_COMPLETED_HTTP", () => {
    const r = makeAttemptRecord({ transport: "completed", http: "not_received", outcome: "failed" });
    const report = buildOperationReport([r]);
    expectViolations(report, [
      v("SEMANTIC_COMPLETED_HTTP", 'transport=completed requires http=expected|unexpected, got "not_received"', { attemptId: "op-1:1", logicalOperationId: "op-1", phase: P2 }),
    ]);
    expect(report.attempts.total).toBe(0);
  });

  it("cascade suppression is whole-group: a Phase-1 defect sibling suppresses Phase 4", () => {
    const records = [
      failedTransport({ attemptId: "op-1:1", attemptNumber: 1, final: false, retryable: true }),
      makeAttemptRecord({ attemptId: "op-1:2", attemptNumber: 2, final: true, retryable: false, durationMs: -1, outcome: "succeeded" }),
    ];
    const report = buildOperationReport(records);
    expectViolations(report, [
      v("INVALID_DURATION", "durationMs must be a non-negative finite number, got -1", { attemptId: "op-1:2", logicalOperationId: "op-1", phase: P1 }),
    ]);
  });

  it("cascade suppression includes Phase-2 defects", () => {
    const records = [
      makeAttemptRecord({ attemptId: "op-1:1", attemptNumber: 1, final: false, retryable: true, outcome: "succeeded" }),
      makeAttemptRecord({ attemptId: "op-1:2", attemptNumber: 2, final: true, retryable: false, durationMs: -1, outcome: "succeeded" }),
    ];
    const report = buildOperationReport(records);
    expectViolations(report, [
      v("INVALID_DURATION", "durationMs must be a non-negative finite number, got -1", { attemptId: "op-1:2", logicalOperationId: "op-1", phase: P1 }),
      v("NONFINAL_SUCCEEDED_ATTEMPT", "outcome=succeeded requires final=true (a later attempt after success is a defect)", { attemptId: "op-1:1", logicalOperationId: "op-1", attemptNumber: 1, phase: P2 }),
    ]);
  });

  it("overlength logicalOperationId suppresses Phase 4 for its group (B2-fix regression)", () => {
    // Use a SHORT attemptId so only the logicalOperationId length check fires.
    // (A long attemptId would also trigger INVALID_ATTEMPT_ID, obscuring the
    // target: the Phase-4 cascade suppression for the long logical op.)
    const longId = "x".repeat(201);
    const report = buildOperationReport([
      failedTransport({ logicalOperationId: longId, attemptId: "short:1", attemptNumber: 1, final: false, retryable: true }),
    ]);
    expectViolations(report, [
      v("INVALID_LOGICAL_OPERATION_ID", "logicalOperationId length must be ≤200", { attemptId: "short:1", logicalOperationId: longId, phase: P1 }),
    ]);
  });

  it("empty reports do not share mutable arrays across calls", () => {
    const first = buildOperationReport([]);
    first.violations.push({ code: "CORRUPTED" });
    first.logicalOperations.push({ polluted: true });
    const second = buildOperationReport([]);
    expect(second.violations).toEqual([]);
    expect(second.logicalOperations).toEqual([]);
  });

  it("transactional violation reports use fresh arrays", () => {
    const r1 = buildOperationReport([null]);
    const beforeLen = r1.violations.length;
    r1.violations.push({ code: "EXTRA" });
    const r2 = buildOperationReport([null]);
    expect(r2.violations.length).toBe(beforeLen);
    expectViolations(r2, [v("INVALID_ATTEMPT_RECORD", "attempt record must be a non-null non-array object", { phase: P1 })]);
  });

  it("BigInt attemptNumber + BigInt durationMs → exact transactional report, no throw", () => {
    const report = buildOperationReport([makeAttemptRecord({ attemptNumber: 1n, durationMs: 5n })]);
    // Two Phase-1 violations; the malformed values appear ONLY in messages
    // (via describeValue), never in the typed attemptNumber field — so the
    // sorter's numeric subtraction cannot crash on BigInt.
    expectViolations(report, [
      v("INVALID_ATTEMPT_NUMBER", "attemptNumber must be a positive integer, got <unserializable bigint>", { attemptId: "op-1:1", logicalOperationId: "op-1", phase: P1 }),
      v("INVALID_DURATION", "durationMs must be a non-negative finite number, got <unserializable bigint>", { attemptId: "op-1:1", logicalOperationId: "op-1", phase: P1 }),
    ]);
    expect(report.logical).toEqual(ZERO_LOGICAL);
    expect(report.attempts).toEqual(ZERO_ATTEMPTS);
    expect(report.logicalOperations).toEqual([]);
    expect(Object.keys(report.attemptsById)).toEqual([]);
  });

  it("Symbol attemptId + invalid logicalOperationId → exact transactional report, no throw", () => {
    const report = buildOperationReport([makeAttemptRecord({ logicalOperationId: "", attemptId: Symbol("bad") })]);
    // Both identity fields are invalid; neither enters typed violation fields
    // (attemptId is a Symbol, not a string; logicalOperationId is empty).
    // The violation() helper only attaches string/number fields — undefined
    // and mistyped values stay out of the structured output.
    expectViolations(report, [
      v("MISSING_ATTEMPT_ID", "attemptId must be a non-empty string", { logicalOperationId: "", phase: P1 }),
      v("MISSING_LOGICAL_OPERATION_ID", "logicalOperationId must be a non-empty string", { phase: P1 }),
    ]);
    expect(report.logical).toEqual(ZERO_LOGICAL);
    expect(report.attempts).toEqual(ZERO_ATTEMPTS);
  });

  it("circular transport value → exact transactional report, no throw", () => {
    const circ = {};
    circ.self = circ;
    const report = buildOperationReport([makeAttemptRecord({ transport: circ })]);
    expect(report.violations.every((x) => x.code === "UNKNOWN_TRANSPORT")).toBe(true);
    expect(report.logical.total).toBe(0);
  });

  it("symbol http classification → exact transactional report, no throw", () => {
    const report = buildOperationReport([makeAttemptRecord({ http: Symbol("x") })]);
    expect(report.violations.every((x) => x.code === "UNKNOWN_HTTP")).toBe(true);
    expect(report.attempts.total).toBe(0);
  });

  it("function assertion classification → exact transactional report, no throw", () => {
    const report = buildOperationReport([makeAttemptRecord({ assertion: () => {} })]);
    expect(report.violations.every((x) => x.code === "UNKNOWN_ASSERTION")).toBe(true);
    expect(report.logical.total).toBe(0);
  });
});

// ─── B4-fix regressions: transport-error shape validation ────────────────

describe("buildOperationReport — B4 transport-error shape", () => {
  // All cases use a failed-transport base and vary only the error field.
  // Every case must produce exactly [INVALID_TRANSPORT_ERROR] with zero
  // aggregates via the full buildOperationReport transactional path.
  function failedWith(error) {
    return failedTransport({ error });
  }

  function expectOnlyTransportError(report) {
    expect(report.violations.map((x) => x.code)).toEqual(["INVALID_TRANSPORT_ERROR"]);
    expect(report.logical).toEqual(ZERO_LOGICAL);
    expect(report.attempts).toEqual(ZERO_ATTEMPTS);
    expect(report.logicalOperations).toEqual([]);
    expect(Object.keys(report.attemptsById)).toEqual([]);
  }

  it("error = { category: 'timeout' } (missing name/code/message) → INVALID_TRANSPORT_ERROR", () => {
    expectOnlyTransportError(buildOperationReport([failedWith({ category: "timeout" })]));
  });

  it("error = { category, name, code, message: '' } (empty message) → INVALID_TRANSPORT_ERROR", () => {
    expectOnlyTransportError(buildOperationReport([failedWith({ category: "timeout", name: null, code: null, message: "" })]));
  });

  it("error.name = 42 (non-string, non-null) → INVALID_TRANSPORT_ERROR", () => {
    expectOnlyTransportError(buildOperationReport([failedWith({ category: "timeout", name: 42, code: "E", message: "x" })]));
  });

  it("error.code = {} (object, not string/null) → INVALID_TRANSPORT_ERROR", () => {
    expectOnlyTransportError(buildOperationReport([failedWith({ category: "timeout", name: null, code: {}, message: "x" })]));
  });
});

// ─── Phase 1: record-shape violations (exact arrays) ─────────────────────

describe("validateAttemptRecord — Phase 1 record shape", () => {
  it("missing logicalOperationId → exact violation", () => {
    expect(validateAttemptRecord(makeAttemptRecord({ logicalOperationId: "" }))).toEqual([
      v("MISSING_LOGICAL_OPERATION_ID", "logicalOperationId must be a non-empty string", { attemptId: "op-1:1", phase: P1 }),
    ]);
  });

  it("missing attemptId → exact violation", () => {
    expect(validateAttemptRecord(makeAttemptRecord({ attemptId: "" }))).toEqual([
      v("MISSING_ATTEMPT_ID", "attemptId must be a non-empty string", { logicalOperationId: "op-1", phase: P1 }),
    ]);
  });

  it("non-positive attemptNumber → exact violation", () => {
    expect(validateAttemptRecord(makeAttemptRecord({ attemptNumber: 0 }))).toEqual([
      v("INVALID_ATTEMPT_NUMBER", "attemptNumber must be a positive integer, got 0", { attemptId: "op-1:1", logicalOperationId: "op-1", attemptNumber: 0, phase: P1 }),
    ]);
    expect(validateAttemptRecord(makeAttemptRecord({ attemptNumber: -1 }))).toEqual([
      v("INVALID_ATTEMPT_NUMBER", "attemptNumber must be a positive integer, got -1", { attemptId: "op-1:1", logicalOperationId: "op-1", attemptNumber: -1, phase: P1 }),
    ]);
    expect(validateAttemptRecord(makeAttemptRecord({ attemptNumber: 1.5 }))).toEqual([
      v("INVALID_ATTEMPT_NUMBER", "attemptNumber must be a positive integer, got 1.5", { attemptId: "op-1:1", logicalOperationId: "op-1", attemptNumber: 1.5, phase: P1 }),
    ]);
  });

  it("unknown transport → exact violation", () => {
    expect(validateAttemptRecord(makeAttemptRecord({ transport: "purple" }))).toEqual([
      v("UNKNOWN_TRANSPORT", 'transport must be one of completed|failed, got "purple"', { attemptId: "op-1:1", logicalOperationId: "op-1", phase: P1 }),
    ]);
  });

  it("unknown http → exact violation", () => {
    expect(validateAttemptRecord(makeAttemptRecord({ http: "purple" }))).toEqual([
      v("UNKNOWN_HTTP", 'http must be one of expected|unexpected|not_received, got "purple"', { attemptId: "op-1:1", logicalOperationId: "op-1", phase: P1 }),
    ]);
  });

  it("unknown assertion → exact violation", () => {
    expect(validateAttemptRecord(makeAttemptRecord({ assertion: "purple" }))).toEqual([
      v("UNKNOWN_ASSERTION", 'assertion must be one of passed|failed|not_run, got "purple"', { attemptId: "op-1:1", logicalOperationId: "op-1", phase: P1 }),
    ]);
  });

  it("negative durationMs → exact violation", () => {
    expect(validateAttemptRecord(makeAttemptRecord({ durationMs: -1 }))).toEqual([
      v("INVALID_DURATION", "durationMs must be a non-negative finite number, got -1", { attemptId: "op-1:1", logicalOperationId: "op-1", phase: P1 }),
    ]);
  });

  it("non-finite durationMs → exact violation", () => {
    expect(validateAttemptRecord(makeAttemptRecord({ durationMs: Infinity }))).toEqual([
      v("INVALID_DURATION", "durationMs must be a non-negative finite number, got null", { attemptId: "op-1:1", logicalOperationId: "op-1", phase: P1 }),
    ]);
    expect(validateAttemptRecord(makeAttemptRecord({ durationMs: NaN }))).toEqual([
      v("INVALID_DURATION", "durationMs must be a non-negative finite number, got null", { attemptId: "op-1:1", logicalOperationId: "op-1", phase: P1 }),
    ]);
  });

  it("non-boolean retryable → exact violation", () => {
    expect(validateAttemptRecord(makeAttemptRecord({ retryable: "yes" }))).toEqual([
      v("INVALID_RETRYABLE", "retryable must be boolean, got string", { attemptId: "op-1:1", logicalOperationId: "op-1", phase: P1 }),
    ]);
  });

  it("non-boolean final → exact violation", () => {
    expect(validateAttemptRecord(makeAttemptRecord({ final: "yes" }))).toEqual([
      v("INVALID_FINAL", "final must be boolean, got string", { attemptId: "op-1:1", logicalOperationId: "op-1", phase: P1 }),
    ]);
  });

  it("non-object record → exact INVALID_ATTEMPT_RECORD violation (not a throw)", () => {
    expect(validateAttemptRecord(null)).toEqual([v("INVALID_ATTEMPT_RECORD", "attempt record must be a non-null non-array object", { phase: P1 })]);
    expect(validateAttemptRecord("string")).toEqual([v("INVALID_ATTEMPT_RECORD", "attempt record must be a non-null non-array object", { phase: P1 })]);
    expect(validateAttemptRecord([])).toEqual([v("INVALID_ATTEMPT_RECORD", "attempt record must be a non-null non-array object", { phase: P1 })]);
  });

  it("Phase 1 defect suppresses Phase 2 cascade", () => {
    const viols = validateAttemptRecord(makeAttemptRecord({ transport: "purple" }));
    expect(viols.every((x) => x.phase === P1)).toBe(true);
  });
});

// ─── Phase 2: engine-result and semantic consistency (exact arrays) ──────

describe("validateAttemptRecord — Phase 2 consistency", () => {
  it("invalid engine outcome (transport=completed but status=null) → exact stable wrapper", () => {
    // The reducer does NOT expose the engine's internal error text; the
    // accounting diagnostic schema is a stable wrapper so the reducer and
    // engine can evolve independently.
    expect(validateAttemptRecord(makeAttemptRecord({ status: null }))).toEqual([
      v("INVALID_ENGINE_OUTCOME", "engine outcome validation failed", { attemptId: "op-1:1", logicalOperationId: "op-1", phase: P2 }),
    ]);
  });

  it("completed status is a string → exact INVALID_STATUS_FOR_TRANSPORT", () => {
    expect(validateAttemptRecord(makeAttemptRecord({ status: "200" }))).toEqual([
      v("INVALID_STATUS_FOR_TRANSPORT", 'transport=completed requires integer status 100-599, got "200"', { attemptId: "op-1:1", logicalOperationId: "op-1", phase: P2 }),
    ]);
  });

  it("completed status below 100 → exact INVALID_STATUS_FOR_TRANSPORT", () => {
    expect(validateAttemptRecord(makeAttemptRecord({ status: 99 }))).toEqual([
      v("INVALID_STATUS_FOR_TRANSPORT", "transport=completed requires integer status 100-599, got 99", { attemptId: "op-1:1", logicalOperationId: "op-1", phase: P2 }),
    ]);
  });

  it("completed status above 599 → exact INVALID_STATUS_FOR_TRANSPORT", () => {
    expect(validateAttemptRecord(makeAttemptRecord({ status: 600 }))).toEqual([
      v("INVALID_STATUS_FOR_TRANSPORT", "transport=completed requires integer status 100-599, got 600", { attemptId: "op-1:1", logicalOperationId: "op-1", phase: P2 }),
    ]);
  });

  it("failed transport with null error → exact INVALID_TRANSPORT_ERROR", () => {
    const r = failedTransport({ error: null });
    expect(validateAttemptRecord(r)).toEqual([
      v("INVALID_TRANSPORT_ERROR", "transport=failed requires a classified transport-error object", { attemptId: "op-1:1", logicalOperationId: "op-1", phase: P2 }),
    ]);
  });
});

// ─── B4 transactional-path regressions for status/error ──────────────────
//
// These verify that buildOperationReport produces the correct exact
// transactional report (zero aggregates + exact violation array) for the
// same status/error defects the unit-level validateAttemptRecord tests
// above pin. The validateAttemptRecord tests prove the per-record layer;
// these prove the transactional reducer layer.

describe("buildOperationReport — B4 status/error transactional path", () => {
  it("status = '200' (string) → exact transactional report", () => {
    const report = buildOperationReport([makeAttemptRecord({ status: "200" })]);
    expectViolations(report, [
      v("INVALID_STATUS_FOR_TRANSPORT", 'transport=completed requires integer status 100-599, got "200"', { attemptId: "op-1:1", logicalOperationId: "op-1", phase: P2 }),
    ]);
    expect(report.logical).toEqual(ZERO_LOGICAL);
    expect(report.attempts).toEqual(ZERO_ATTEMPTS);
    expect(report.logicalOperations).toEqual([]);
    expect(Object.keys(report.attemptsById)).toEqual([]);
  });

  it("status = 99 (below range) → exact transactional report", () => {
    const report = buildOperationReport([makeAttemptRecord({ status: 99 })]);
    expectViolations(report, [
      v("INVALID_STATUS_FOR_TRANSPORT", "transport=completed requires integer status 100-599, got 99", { attemptId: "op-1:1", logicalOperationId: "op-1", phase: P2 }),
    ]);
    expect(report.logical).toEqual(ZERO_LOGICAL);
  });

  it("status = 600 (above range) → exact transactional report", () => {
    const report = buildOperationReport([makeAttemptRecord({ status: 600 })]);
    expectViolations(report, [
      v("INVALID_STATUS_FOR_TRANSPORT", "transport=completed requires integer status 100-599, got 600", { attemptId: "op-1:1", logicalOperationId: "op-1", phase: P2 }),
    ]);
    expect(report.attempts).toEqual(ZERO_ATTEMPTS);
  });

  it("transport = failed, error = null → exact transactional report", () => {
    const report = buildOperationReport([failedTransport({ error: null })]);
    expectViolations(report, [
      v("INVALID_TRANSPORT_ERROR", "transport=failed requires a classified transport-error object", { attemptId: "op-1:1", logicalOperationId: "op-1", phase: P2 }),
    ]);
    expect(report.logical).toEqual(ZERO_LOGICAL);
    expect(report.logicalOperations).toEqual([]);
  });

  it("transport=failed but http=expected → exact SEMANTIC_TRANSPORT_HTTP", () => {
    expect(validateAttemptRecord(failedTransport({ http: "expected" }))).toEqual([
      v("SEMANTIC_TRANSPORT_HTTP", "transport=failed requires http=not_received, got expected", { attemptId: "op-1:1", logicalOperationId: "op-1", phase: P2 }),
    ]);
  });

  it("assertion=passed but assertionError set → exact SEMANTIC_PASSED_ERROR", () => {
    expect(validateAttemptRecord(makeAttemptRecord({ assertion: "passed", assertionError: { code: "X", message: "y" } }))).toEqual([
      v("SEMANTIC_PASSED_ERROR", "assertion=passed requires assertionError=null", { attemptId: "op-1:1", logicalOperationId: "op-1", phase: P2 }),
    ]);
  });

  it("assertion=failed but assertionError missing → exact SEMANTIC_FAILED_ERROR", () => {
    expect(validateAttemptRecord(makeAttemptRecord({ assertion: "failed", assertionError: null, outcome: "failed" }))).toEqual([
      v("SEMANTIC_FAILED_ERROR", "assertion=failed requires assertionError with non-empty code and message", { attemptId: "op-1:1", logicalOperationId: "op-1", phase: P2 }),
    ]);
  });

  it("assertion=not_run but assertionError set → exact SEMANTIC_NOT_RUN_ERROR", () => {
    expect(validateAttemptRecord(makeAttemptRecord({
      transport: "completed", http: "expected", assertion: "not_run",
      assertionNotRunReason: "not_declared", assertionError: { code: "X", message: "y" },
    }))).toEqual([
      v("SEMANTIC_NOT_RUN_ERROR", "assertion=not_run requires assertionError=null", { attemptId: "op-1:1", logicalOperationId: "op-1", phase: P2 }),
    ]);
  });

  it("transport=completed + http=not_received → exact SEMANTIC_COMPLETED_HTTP", () => {
    expect(validateAttemptRecord(makeAttemptRecord({ transport: "completed", http: "not_received", outcome: "failed" }))).toEqual([
      v("SEMANTIC_COMPLETED_HTTP", 'transport=completed requires http=expected|unexpected, got "not_received"', { attemptId: "op-1:1", logicalOperationId: "op-1", phase: P2 }),
    ]);
  });

  it("outcome mismatches classifications → exact OUTCOME_MISMATCH", () => {
    expect(validateAttemptRecord(makeAttemptRecord({
      transport: "completed", http: "unexpected", assertion: "not_run",
      assertionNotRunReason: "status_not_applicable", outcome: "succeeded",
    }))).toEqual([
      v("OUTCOME_MISMATCH", 'outcome="succeeded" but classifications imply failed', { attemptId: "op-1:1", logicalOperationId: "op-1", phase: P2 }),
    ]);
  });

  it("succeeded attempt with final=false → exact NONFINAL_SUCCEEDED_ATTEMPT", () => {
    expect(validateAttemptRecord(makeAttemptRecord({ final: false }))).toEqual([
      v("NONFINAL_SUCCEEDED_ATTEMPT", "outcome=succeeded requires final=true (a later attempt after success is a defect)", { attemptId: "op-1:1", logicalOperationId: "op-1", attemptNumber: 1, phase: P2 }),
    ]);
  });
});

// ─── Phase 4: per-logical-operation sequence violations (exact arrays) ───

describe("buildOperationReport — Phase 4 logical sequence", () => {
  it("noncontiguous attempt numbers (1, 3) → exact violation", () => {
    const records = [
      failedTransport({ attemptId: "op-1:1", attemptNumber: 1, final: false, retryable: true }),
      makeAttemptRecord({ attemptId: "op-1:3", attemptNumber: 3, final: true, retryable: false }),
    ];
    const report = buildOperationReport(records);
    expectViolations(report, [
      v("NONCONTIGUOUS_ATTEMPT_NUMBERS", 'attemptNumbers must be contiguous starting at 1; got [1,3] for logical operation', { logicalOperationId: "op-1", phase: P4 }),
    ]);
    expect(report.logical.total).toBe(0);
  });

  it("multiple final attempts → exact violation", () => {
    const records = [
      makeAttemptRecord({ attemptId: "op-1:1", attemptNumber: 1, final: true }),
      failedTransport({ attemptId: "op-1:2", attemptNumber: 2, final: true }),
    ];
    expectViolations(buildOperationReport(records), [
      v("MULTIPLE_FINAL_ATTEMPTS", "logical operation has 2 final attempts; expected exactly 1", { logicalOperationId: "op-1", phase: P4 }),
    ]);
  });

  it("no final attempt → exact violation", () => {
    const records = [
      failedTransport({ attemptId: "op-1:1", attemptNumber: 1, final: false, retryable: true }),
    ];
    expectViolations(buildOperationReport(records), [
      v("NO_FINAL_ATTEMPT", "logical operation has no final attempt", { logicalOperationId: "op-1", phase: P4 }),
    ]);
  });

  it("duplicate attemptNumber within one logical op → exact violation", () => {
    const records = [
      failedTransport({ attemptId: "op-1:1a", attemptNumber: 1, final: false, retryable: true }),
      makeAttemptRecord({ attemptId: "op-1:1b", attemptNumber: 1, final: true }),
    ];
    expectViolations(buildOperationReport(records), [
      v("DUPLICATE_ATTEMPT_NUMBER", "duplicate attemptNumber 1 within logical operation", { logicalOperationId: "op-1", attemptId: "op-1:1b", attemptNumber: 1, phase: P4 }),
    ]);
  });

  it("final attempt with a later sibling → exact FINAL_NOT_HIGHEST + FINAL_NOT_LAST", () => {
    const records = [
      failedTransport({ attemptId: "op-1:1", attemptNumber: 1, final: false, retryable: true }),
      makeAttemptRecord({ attemptId: "op-1:2", attemptNumber: 2, final: true, retryable: false }),
      failedTransport({ attemptId: "op-1:3", attemptNumber: 3, final: false, retryable: true }),
    ];
    expectViolations(buildOperationReport(records), [
      v("FINAL_NOT_HIGHEST", "final attempt number 2 is not the highest (3)", { logicalOperationId: "op-1", attemptId: "op-1:2", phase: P4 }),
      v("FINAL_NOT_LAST", "attempt 3 follows the final attempt 2", { logicalOperationId: "op-1", attemptId: "op-1:3", attemptNumber: 3, phase: P4 }),
    ]);
  });
});

// ─── createAttemptRecord adapter ──────────────────────────────────────────

describe("createAttemptRecord — adapter", () => {
  it("copies only declared fields and computes outcome", () => {
    const engineResult = {
      kind: "read", method: "GET", durationMs: 5,
      transport: "completed", status: 200,
      body: { state: "parsed", value: { ok: 1 }, error: null },
      error: null, http: "expected", assertion: "passed",
      assertionNotRunReason: null, assertionError: null,
      someExtraEngineField: "should not propagate",
    };
    const record = createAttemptRecord(engineResult, {
      logicalOperationId: "op-1", attemptId: "op-1:1",
      attemptNumber: 1, retryable: false, final: true,
    });
    expect(record.someExtraEngineField).toBeUndefined();
    expect(record.outcome).toBe("succeeded");
    expect(record.body).toEqual({ state: "parsed", value: { ok: 1 }, error: null });
  });

  it("deep-copies nested body/error so engine-object mutation cannot affect the record", () => {
    const body = { state: "parsed", value: { ok: 1 }, error: null };
    const engineResult = {
      kind: "t", method: "GET", durationMs: 1,
      transport: "completed", status: 200, body,
      error: null, http: "expected", assertion: "passed",
      assertionNotRunReason: null, assertionError: null,
    };
    const record = createAttemptRecord(engineResult, {
      logicalOperationId: "op-1", attemptId: "op-1:1",
      attemptNumber: 1, retryable: false, final: true,
    });
    body.value.ok = 999;
    expect(record.body.value.ok).toBe(1);
  });

  it("throws INVALID_ADAPTER_ARGS on missing/malformed metadata", () => {
    const ok = { transport: "completed", status: 200, body: { state: "empty", value: null, error: null }, error: null, http: "expected", assertion: "passed", assertionNotRunReason: null, assertionError: null };
    expect(() => createAttemptRecord(ok, null)).toThrow(/metadata must be an object/);
    expect(() => createAttemptRecord(ok, { logicalOperationId: "", attemptId: "x", attemptNumber: 1, retryable: false, final: true })).toThrow(/logicalOperationId/);
    expect(() => createAttemptRecord(ok, { logicalOperationId: "x", attemptId: "y", attemptNumber: 0, retryable: false, final: true })).toThrow(/attemptNumber/);
    expect(() => createAttemptRecord(ok, { logicalOperationId: "x", attemptId: "y", attemptNumber: 1, retryable: "no", final: true })).toThrow(/retryable/);
  });
});

// ─── attemptsById prototype-pollution guard ───────────────────────────────

describe("buildOperationReport — attemptsById null prototype", () => {
  it("an attemptId of __proto__ does not pollute the global object prototype", () => {
    const r = makeAttemptRecord({ attemptId: "__proto__", logicalOperationId: "evil", final: true });
    const report = buildOperationReport([r]);
    expect(report.violations).toEqual([]);
    expect(Object.getPrototypeOf(report.attemptsById)).toBe(null);
    expect(report.attemptsById["__proto__"]).toMatchObject({ attemptId: "__proto__", logicalOperationId: "evil" });
    expect({}.polluted).toBeUndefined();
    expect(Object.prototype.polluted).toBeUndefined();
  });
});
