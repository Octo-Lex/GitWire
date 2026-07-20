// tests/unit/stress-functional/operation-accounting.test.js
//
// Synthetic-record invariant tests for the pure accounting reducer. These
// do NOT invoke the burst engine — they prove the reducer's transactional
// contract, phase ordering, cascade suppression, and C4-readiness directly.
//
// Every negative test asserts the EXACT sorted violation array — no
// toContain looseness — so secondary cascade findings cannot appear
// without failing the suite.
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
 * engine-result adapter. Used for invariant tests that need states C2's
 * single-attempt engine matrix cannot naturally produce (retry sequences,
 * malformed records, noncontiguous numbers, etc.).
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

// Exact sorted code array — the canonical assertion for negative tests.
function codes(report) {
  return report.violations.map((v) => v.code).sort();
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
  it("single succeeded attempt → exact counters", () => {
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
    // retryable and final are independent. A final failed attempt may still
    // represent an intrinsically retryable error whose budget was exhausted.
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

// ─── Transactional contract ───────────────────────────────────────────────

describe("buildOperationReport — transactional: any violation → zero aggregates", () => {
  it("duplicate attemptId → exact violation set, zero aggregates", () => {
    // Two records with the SAME attemptId AND attemptNumber (1). Phase 3
    // reports the duplicate identity; Phase 4 sees two finals and a
    // duplicate attemptNumber in the same group. All three are genuine
    // findings about the duplicate; the transactional contract zeroes the
    // aggregates regardless.
    const records = [
      makeAttemptRecord({ attemptId: "op-1:1", attemptNumber: 1, final: true }),
      makeAttemptRecord({ attemptId: "op-1:1", attemptNumber: 1, final: true }),
    ];
    const report = buildOperationReport(records);
    expect(report.logical.total).toBe(0);
    expect(report.attempts.total).toBe(0);
    expect(report.logicalOperations).toEqual([]);
    expect(codes(report)).toEqual(["DUPLICATE_ATTEMPT_ID", "DUPLICATE_ATTEMPT_NUMBER", "MULTIPLE_FINAL_ATTEMPTS"]);
  });

  it("non-array input throws INVALID_REPORT_ARG (only top-level arg throws)", () => {
    expect(() => buildOperationReport("not an array")).toThrow(/attemptRecords must be an array/);
    expect(() => buildOperationReport(null)).toThrow(/attemptRecords must be an array/);
    expect(() => buildOperationReport({})).toThrow(/attemptRecords must be an array/);
  });
});

// ─── B-fix regressions: malformed records, impossible semantics, cascade, mutation ─

describe("buildOperationReport — B-fix defect regressions", () => {
  it("null record → INVALID_ATTEMPT_RECORD violation, zero aggregates (not a throw)", () => {
    const report = buildOperationReport([null]);
    expect(codes(report)).toEqual(["INVALID_ATTEMPT_RECORD"]);
    expect(report.logical.total).toBe(0);
    expect(report.attempts.total).toBe(0);
  });

  it("primitive record → INVALID_ATTEMPT_RECORD violation", () => {
    expect(codes(buildOperationReport([42]))).toEqual(["INVALID_ATTEMPT_RECORD"]);
    expect(codes(buildOperationReport(["str"]))).toEqual(["INVALID_ATTEMPT_RECORD"]);
  });

  it("array record → INVALID_ATTEMPT_RECORD violation", () => {
    expect(codes(buildOperationReport([[]]))).toEqual(["INVALID_ATTEMPT_RECORD"]);
  });

  it("transport=completed + http=not_received → SEMANTIC_COMPLETED_HTTP (no silent inconsistent counters)", () => {
    const r = makeAttemptRecord({ transport: "completed", http: "not_received", outcome: "failed" });
    const report = buildOperationReport([r]);
    expect(codes(report)).toEqual(["SEMANTIC_COMPLETED_HTTP"]);
    expect(report.attempts.total).toBe(0); // transactional — no authoritative counters
  });

  it("cascade suppression is whole-group: a Phase-1 defect sibling suppresses Phase 4 for the entire logical op", () => {
    // Attempt 2 has INVALID_DURATION (Phase 1). Attempt 1 is valid but
    // non-final. Without whole-group suppression, the reducer would also
    // emit NO_FINAL_ATTEMPT (because attempt 2 is omitted from sequencing).
    const records = [
      makeAttemptRecord({ attemptId: "op-1:1", attemptNumber: 1, final: false, retryable: true,
        outcome: "failed", transport: "failed", http: "not_received", assertion: "not_run",
        status: null, body: { state: "not_read", value: null, error: null },
        error: { category: "timeout", name: "Error", code: "ETIMEDOUT", message: "m" },
        assertionNotRunReason: "transport_failed" }),
      makeAttemptRecord({ attemptId: "op-1:2", attemptNumber: 2, final: true, retryable: false,
        durationMs: -1 }), // INVALID_DURATION (Phase 1)
    ];
    const report = buildOperationReport(records);
    expect(codes(report)).toEqual(["INVALID_DURATION"]);
    expect(codes(report)).not.toContain("NO_FINAL_ATTEMPT");
    expect(codes(report)).not.toContain("MULTIPLE_FINAL_ATTEMPTS");
  });

  it("cascade suppression includes Phase-2 defects, not only Phase-1", () => {
    // Attempt 1 succeeds but is non-final → NONFINAL_SUCCEEDED_ATTEMPT (Phase 2).
    // Attempt 2 has INVALID_DURATION (Phase 1). Both defects mark the group;
    // no NO_FINAL_ATTEMPT cascade appears.
    const records = [
      makeAttemptRecord({ attemptId: "op-1:1", attemptNumber: 1, final: false, retryable: true,
        outcome: "succeeded" }), // NONFINAL_SUCCEEDED_ATTEMPT
      makeAttemptRecord({ attemptId: "op-1:2", attemptNumber: 2, final: true, retryable: false,
        durationMs: -1, outcome: "succeeded" }), // INVALID_DURATION
    ];
    const report = buildOperationReport(records);
    expect(codes(report)).toEqual(["INVALID_DURATION", "NONFINAL_SUCCEEDED_ATTEMPT"]);
    expect(codes(report)).not.toContain("NO_FINAL_ATTEMPT");
  });

  it("empty reports do not share mutable arrays across calls", () => {
    const first = buildOperationReport([]);
    first.violations.push({ code: "CORRUPTED" });
    first.logicalOperations.push({ polluted: true });

    const second = buildOperationReport([]);
    expect(second.violations).toEqual([]);
    expect(second.logicalOperations).toEqual([]);
  });

  it("transactional violation reports also use fresh arrays (not shared)", () => {
    const r1 = buildOperationReport([null]); // produces INVALID_ATTEMPT_RECORD
    const beforeLen = r1.violations.length;
    r1.violations.push({ code: "EXTRA" });
    const r2 = buildOperationReport([null]);
    expect(r2.violations.length).toBe(beforeLen);
    expect(codes(r2)).toEqual(["INVALID_ATTEMPT_RECORD"]);
  });
});

// ─── Phase 1: record-shape violations (exact arrays) ─────────────────────

describe("validateAttemptRecord — Phase 1 record shape", () => {
  it("missing logicalOperationId → [MISSING_LOGICAL_OPERATION_ID]", () => {
    expect(validateAttemptRecord(makeAttemptRecord({ logicalOperationId: "" })).map((v) => v.code)).toEqual(["MISSING_LOGICAL_OPERATION_ID"]);
  });

  it("missing attemptId → [MISSING_ATTEMPT_ID]", () => {
    expect(validateAttemptRecord(makeAttemptRecord({ attemptId: "" })).map((v) => v.code)).toEqual(["MISSING_ATTEMPT_ID"]);
  });

  it("non-positive attemptNumber → [INVALID_ATTEMPT_NUMBER]", () => {
    expect(validateAttemptRecord(makeAttemptRecord({ attemptNumber: 0 })).map((v) => v.code)).toEqual(["INVALID_ATTEMPT_NUMBER"]);
    expect(validateAttemptRecord(makeAttemptRecord({ attemptNumber: -1 })).map((v) => v.code)).toEqual(["INVALID_ATTEMPT_NUMBER"]);
    expect(validateAttemptRecord(makeAttemptRecord({ attemptNumber: 1.5 })).map((v) => v.code)).toEqual(["INVALID_ATTEMPT_NUMBER"]);
  });

  it("unknown transport → [UNKNOWN_TRANSPORT]", () => {
    expect(validateAttemptRecord(makeAttemptRecord({ transport: "purple" })).map((v) => v.code)).toEqual(["UNKNOWN_TRANSPORT"]);
  });

  it("unknown http → [UNKNOWN_HTTP]", () => {
    expect(validateAttemptRecord(makeAttemptRecord({ http: "purple" })).map((v) => v.code)).toEqual(["UNKNOWN_HTTP"]);
  });

  it("unknown assertion → [UNKNOWN_ASSERTION]", () => {
    expect(validateAttemptRecord(makeAttemptRecord({ assertion: "purple" })).map((v) => v.code)).toEqual(["UNKNOWN_ASSERTION"]);
  });

  it("negative durationMs → [INVALID_DURATION]", () => {
    expect(validateAttemptRecord(makeAttemptRecord({ durationMs: -1 })).map((v) => v.code)).toEqual(["INVALID_DURATION"]);
  });

  it("non-finite durationMs → [INVALID_DURATION]", () => {
    expect(validateAttemptRecord(makeAttemptRecord({ durationMs: Infinity })).map((v) => v.code)).toEqual(["INVALID_DURATION"]);
    expect(validateAttemptRecord(makeAttemptRecord({ durationMs: NaN })).map((v) => v.code)).toEqual(["INVALID_DURATION"]);
  });

  it("non-boolean retryable → [INVALID_RETRYABLE]", () => {
    expect(validateAttemptRecord(makeAttemptRecord({ retryable: "yes" })).map((v) => v.code)).toEqual(["INVALID_RETRYABLE"]);
  });

  it("non-boolean final → [INVALID_FINAL]", () => {
    expect(validateAttemptRecord(makeAttemptRecord({ final: "yes" })).map((v) => v.code)).toEqual(["INVALID_FINAL"]);
  });

  it("non-object record → [INVALID_ATTEMPT_RECORD] (not a throw)", () => {
    expect(validateAttemptRecord(null).map((v) => v.code)).toEqual(["INVALID_ATTEMPT_RECORD"]);
    expect(validateAttemptRecord("string").map((v) => v.code)).toEqual(["INVALID_ATTEMPT_RECORD"]);
    expect(validateAttemptRecord([]).map((v) => v.code)).toEqual(["INVALID_ATTEMPT_RECORD"]);
    expect(validateAttemptRecord(null)[0].phase).toBe("phase_1_record_shape");
  });

  it("Phase 1 defect suppresses Phase 2 cascade (no SEMANTIC_* findings)", () => {
    const v = validateAttemptRecord(makeAttemptRecord({ transport: "purple" }));
    expect(v.every((x) => x.phase === "phase_1_record_shape")).toBe(true);
  });
});

// ─── Phase 2: engine-result and semantic consistency (exact arrays) ──────

describe("validateAttemptRecord — Phase 2 consistency", () => {
  it("invalid engine outcome (transport=completed but status=null) → [INVALID_ENGINE_OUTCOME]", () => {
    expect(validateAttemptRecord(makeAttemptRecord({ status: null })).map((v) => v.code)).toEqual(["INVALID_ENGINE_OUTCOME"]);
  });

  it("transport=failed but http=expected → [SEMANTIC_TRANSPORT_HTTP]", () => {
    const v = validateAttemptRecord(failedTransport({ http: "expected" }));
    expect(v.map((x) => x.code)).toEqual(["SEMANTIC_TRANSPORT_HTTP"]);
  });

  it("assertion=passed but assertionError set → [SEMANTIC_PASSED_ERROR]", () => {
    expect(validateAttemptRecord(makeAttemptRecord({ assertion: "passed", assertionError: { code: "X", message: "y" } })).map((v) => v.code)).toEqual(["SEMANTIC_PASSED_ERROR"]);
  });

  it("assertion=failed but assertionError missing → [SEMANTIC_FAILED_ERROR] (+ OUTCOME_MISMATCH if outcome not updated)", () => {
    // Self-consistent test data: assertion=failed implies outcome=failed.
    expect(validateAttemptRecord(makeAttemptRecord({ assertion: "failed", assertionError: null, outcome: "failed" })).map((v) => v.code)).toEqual(["SEMANTIC_FAILED_ERROR"]);
  });

  it("assertion=not_run but assertionError set → [SEMANTIC_NOT_RUN_ERROR]", () => {
    const v = validateAttemptRecord(makeAttemptRecord({
      transport: "completed", http: "expected", assertion: "not_run",
      assertionNotRunReason: "not_declared",
      assertionError: { code: "X", message: "y" },
    }));
    expect(v.map((x) => x.code)).toEqual(["SEMANTIC_NOT_RUN_ERROR"]);
  });

  it("transport=completed + http=not_received → [SEMANTIC_COMPLETED_HTTP]", () => {
    const v = validateAttemptRecord(makeAttemptRecord({ transport: "completed", http: "not_received", outcome: "failed" }));
    expect(v.map((x) => x.code)).toEqual(["SEMANTIC_COMPLETED_HTTP"]);
  });

  it("outcome mismatches classifications → [OUTCOME_MISMATCH]", () => {
    // Self-consistent except for outcome: http=unexpected implies failed,
    // but outcome says succeeded. assertion=not_run needs a reason; supply
    // one so SEMANTIC_NOT_RUN_REASON doesn't fire and obscure the target.
    const v = validateAttemptRecord(makeAttemptRecord({
      transport: "completed", http: "unexpected", assertion: "not_run",
      assertionNotRunReason: "status_not_applicable", outcome: "succeeded",
    }));
    expect(v.map((x) => x.code)).toEqual(["OUTCOME_MISMATCH"]);
  });

  it("succeeded attempt with final=false → [NONFINAL_SUCCEEDED_ATTEMPT]", () => {
    expect(validateAttemptRecord(makeAttemptRecord({ final: false })).map((v) => v.code)).toEqual(["NONFINAL_SUCCEEDED_ATTEMPT"]);
  });
});

// ─── Phase 4: per-logical-operation sequence violations (exact arrays) ───

describe("buildOperationReport — Phase 4 logical sequence", () => {
  it("noncontiguous attempt numbers (1, 3) → [NONCONTIGUOUS_ATTEMPT_NUMBERS]", () => {
    const records = [
      failedTransport({ attemptId: "op-1:1", attemptNumber: 1, final: false, retryable: true }),
      makeAttemptRecord({ attemptId: "op-1:3", attemptNumber: 3, final: true, retryable: false }), // gap at 2
    ];
    const report = buildOperationReport(records);
    expect(codes(report)).toEqual(["NONCONTIGUOUS_ATTEMPT_NUMBERS"]);
    expect(report.logical.total).toBe(0);
  });

  it("multiple final attempts → [MULTIPLE_FINAL_ATTEMPTS]", () => {
    const records = [
      makeAttemptRecord({ attemptId: "op-1:1", attemptNumber: 1, final: true }),
      failedTransport({ attemptId: "op-1:2", attemptNumber: 2, final: true }),
    ];
    expect(codes(buildOperationReport(records))).toEqual(["MULTIPLE_FINAL_ATTEMPTS"]);
  });

  it("no final attempt → [NO_FINAL_ATTEMPT]", () => {
    const records = [
      failedTransport({ attemptId: "op-1:1", attemptNumber: 1, final: false, retryable: true }),
    ];
    expect(codes(buildOperationReport(records))).toEqual(["NO_FINAL_ATTEMPT"]);
  });

  it("duplicate attemptNumber within one logical op → [DUPLICATE_ATTEMPT_NUMBER]", () => {
    const records = [
      failedTransport({ attemptId: "op-1:1a", attemptNumber: 1, final: false, retryable: true }),
      makeAttemptRecord({ attemptId: "op-1:1b", attemptNumber: 1, final: true }),
    ];
    expect(codes(buildOperationReport(records))).toEqual(["DUPLICATE_ATTEMPT_NUMBER"]);
  });

  it("final attempt with a later sibling → [FINAL_NOT_HIGHEST, FINAL_NOT_LAST]", () => {
    // attemptNumber 2 is final, 3 follows. Both codes apply inseparably:
    // FINAL_NOT_LAST (3 follows 2) and FINAL_NOT_HIGHEST (2 != max=3).
    const records = [
      failedTransport({ attemptId: "op-1:1", attemptNumber: 1, final: false, retryable: true }),
      makeAttemptRecord({ attemptId: "op-1:2", attemptNumber: 2, final: true, retryable: false }),
      failedTransport({ attemptId: "op-1:3", attemptNumber: 3, final: false, retryable: true }),
    ];
    expect(codes(buildOperationReport(records))).toEqual(["FINAL_NOT_HIGHEST", "FINAL_NOT_LAST"]);
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
