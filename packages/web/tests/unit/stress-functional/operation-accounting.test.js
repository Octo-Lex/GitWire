// tests/unit/stress-functional/operation-accounting.test.js
//
// Synthetic-record invariant tests for the pure accounting reducer. These
// do NOT invoke the burst engine — they prove the reducer's transactional
// contract, phase ordering, cascade suppression, and C4-readiness (retry
// shapes, noncontiguous numbers, final-followed-by-attempt) directly.
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

function codes(report) {
  return report.violations.map((v) => v.code).sort();
}

// ─── deriveAttemptOutcome unit tests ──────────────────────────────────────

describe("deriveAttemptOutcome — 3-rule order", () => {
  it("transport=failed → failed (regardless of http)", () => {
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
    const r = makeAttemptRecord({
      transport: "failed", http: "not_received", assertion: "not_run",
      status: null, body: { state: "not_read", value: null, error: null },
      error: { category: "timeout", name: "Error", code: "ETIMEDOUT", message: "timed out" },
      assertionNotRunReason: "transport_failed",
      outcome: "failed",
    });
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
      makeAttemptRecord({ attemptId: "op-1:1", attemptNumber: 1, final: false, retryable: true,
        transport: "failed", http: "not_received", assertion: "not_run", status: null,
        body: { state: "not_read", value: null, error: null },
        error: { category: "timeout", name: "Error", code: "ETIMEDOUT", message: "timed out" },
        assertionNotRunReason: "transport_failed", outcome: "failed" }),
      makeAttemptRecord({ attemptId: "op-1:2", attemptNumber: 2, final: true, retryable: false,
        outcome: "succeeded" }),
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
    // The key C2 correction: retryable and final are independent. A final
    // failed attempt may still represent an intrinsically retryable error
    // whose retry budget was exhausted.
    const records = [
      makeAttemptRecord({ attemptId: "op-1:1", attemptNumber: 1, final: false, retryable: true,
        transport: "failed", http: "not_received", assertion: "not_run", status: null,
        body: { state: "not_read", value: null, error: null },
        error: { category: "timeout", name: "Error", code: "ETIMEDOUT", message: "timed out" },
        assertionNotRunReason: "transport_failed", outcome: "failed" }),
      makeAttemptRecord({ attemptId: "op-1:2", attemptNumber: 2, final: false, retryable: true,
        transport: "failed", http: "not_received", assertion: "not_run", status: null,
        body: { state: "not_read", value: null, error: null },
        error: { category: "timeout", name: "Error", code: "ETIMEDOUT", message: "timed out" },
        assertionNotRunReason: "transport_failed", outcome: "failed" }),
      makeAttemptRecord({ attemptId: "op-1:3", attemptNumber: 3, final: true, retryable: true, // retryable AND final
        transport: "failed", http: "not_received", assertion: "not_run", status: null,
        body: { state: "not_read", value: null, error: null },
        error: { category: "timeout", name: "Error", code: "ETIMEDOUT", message: "timed out" },
        assertionNotRunReason: "transport_failed", outcome: "failed" }),
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
    // Sorted by logicalOperationId for deterministic output.
    expect(report.logicalOperations.map((op) => op.logicalOperationId)).toEqual(["op-a", "op-b"]);
  });
});

// ─── Transactional contract ───────────────────────────────────────────────

describe("buildOperationReport — transactional: any violation → zero aggregates", () => {
  it("duplicate attemptId zeroes aggregates AND reports the violation", () => {
    const records = [
      makeAttemptRecord({ attemptId: "op-1:1", attemptNumber: 1, final: true }),
      makeAttemptRecord({ attemptId: "op-1:1", attemptNumber: 1, final: true }),
    ];
    const report = buildOperationReport(records);
    expect(report.logical.total).toBe(0);
    expect(report.attempts.total).toBe(0);
    expect(report.logicalOperations).toEqual([]);
    expect(codes(report)).toContain("DUPLICATE_ATTEMPT_ID");
  });

  it("non-array input throws (programming error, not a structured violation)", () => {
    expect(() => buildOperationReport("not an array")).toThrow(/attemptRecords must be an array/);
    expect(() => buildOperationReport(null)).toThrow(/attemptRecords must be an array/);
    expect(() => buildOperationReport({})).toThrow(/attemptRecords must be an array/);
  });
});

// ─── Phase 1: record-shape violations ─────────────────────────────────────

describe("validateAttemptRecord — Phase 1 record shape", () => {
  it("missing logicalOperationId → MISSING_LOGICAL_OPERATION_ID", () => {
    const v = validateAttemptRecord(makeAttemptRecord({ logicalOperationId: "" }));
    expect(v.map((x) => x.code)).toContain("MISSING_LOGICAL_OPERATION_ID");
  });

  it("missing attemptId → MISSING_ATTEMPT_ID", () => {
    const v = validateAttemptRecord(makeAttemptRecord({ attemptId: "" }));
    expect(v.map((x) => x.code)).toContain("MISSING_ATTEMPT_ID");
  });

  it("non-positive attemptNumber → INVALID_ATTEMPT_NUMBER", () => {
    expect(validateAttemptRecord(makeAttemptRecord({ attemptNumber: 0 })).map((v) => v.code)).toContain("INVALID_ATTEMPT_NUMBER");
    expect(validateAttemptRecord(makeAttemptRecord({ attemptNumber: -1 })).map((v) => v.code)).toContain("INVALID_ATTEMPT_NUMBER");
    expect(validateAttemptRecord(makeAttemptRecord({ attemptNumber: 1.5 })).map((v) => v.code)).toContain("INVALID_ATTEMPT_NUMBER");
  });

  it("unknown transport → UNKNOWN_TRANSPORT", () => {
    expect(validateAttemptRecord(makeAttemptRecord({ transport: "purple" })).map((v) => v.code)).toContain("UNKNOWN_TRANSPORT");
  });

  it("unknown http → UNKNOWN_HTTP", () => {
    expect(validateAttemptRecord(makeAttemptRecord({ http: "purple" })).map((v) => v.code)).toContain("UNKNOWN_HTTP");
  });

  it("unknown assertion → UNKNOWN_ASSERTION", () => {
    expect(validateAttemptRecord(makeAttemptRecord({ assertion: "purple" })).map((v) => v.code)).toContain("UNKNOWN_ASSERTION");
  });

  it("negative durationMs → INVALID_DURATION", () => {
    expect(validateAttemptRecord(makeAttemptRecord({ durationMs: -1 })).map((v) => v.code)).toContain("INVALID_DURATION");
  });

  it("non-finite durationMs → INVALID_DURATION", () => {
    expect(validateAttemptRecord(makeAttemptRecord({ durationMs: Infinity })).map((v) => v.code)).toContain("INVALID_DURATION");
    expect(validateAttemptRecord(makeAttemptRecord({ durationMs: NaN })).map((v) => v.code)).toContain("INVALID_DURATION");
  });

  it("non-boolean retryable → INVALID_RETRYABLE", () => {
    expect(validateAttemptRecord(makeAttemptRecord({ retryable: "yes" })).map((v) => v.code)).toContain("INVALID_RETRYABLE");
  });

  it("non-boolean final → INVALID_FINAL", () => {
    expect(validateAttemptRecord(makeAttemptRecord({ final: "yes" })).map((v) => v.code)).toContain("INVALID_FINAL");
  });

  it("non-object record throws INVALID_RECORD_ARG (programming error)", () => {
    expect(() => validateAttemptRecord(null)).toThrow(/record must be a non-null object/);
    expect(() => validateAttemptRecord("string")).toThrow(/record must be a non-null object/);
    expect(() => validateAttemptRecord([])).toThrow(/record must be a non-null object/);
  });

  it("Phase 1 defect suppresses Phase 2 cascade (no SEMANTIC_* findings on a record with unknown transport)", () => {
    const v = validateAttemptRecord(makeAttemptRecord({ transport: "purple" }));
    // Only Phase 1 defects; no Phase 2 SEMANTIC_TRANSPORT_* cascade.
    expect(v.every((x) => x.phase === "phase_1_record_shape")).toBe(true);
  });
});

// ─── Phase 2: engine-result and semantic consistency ──────────────────────

describe("validateAttemptRecord — Phase 2 consistency", () => {
  it("invalid engine outcome (transport=completed but status=null) → INVALID_ENGINE_OUTCOME", () => {
    const v = validateAttemptRecord(makeAttemptRecord({ status: null }));
    expect(v.map((x) => x.code)).toContain("INVALID_ENGINE_OUTCOME");
  });

  it("transport=failed but http=expected → SEMANTIC_TRANSPORT_HTTP", () => {
    const v = validateAttemptRecord(makeAttemptRecord({
      transport: "failed", http: "expected", assertion: "not_run",
      status: null, body: { state: "not_read", value: null, error: null },
      error: { category: "timeout", name: "Error", code: "ETIMEDOUT", message: "m" },
      assertionNotRunReason: "transport_failed", outcome: "failed",
    }));
    expect(v.map((x) => x.code)).toContain("SEMANTIC_TRANSPORT_HTTP");
  });

  it("assertion=passed but assertionError set → SEMANTIC_PASSED_ERROR", () => {
    const v = validateAttemptRecord(makeAttemptRecord({
      assertion: "passed", assertionError: { code: "X", message: "y" },
    }));
    expect(v.map((x) => x.code)).toContain("SEMANTIC_PASSED_ERROR");
  });

  it("assertion=failed but assertionError missing → SEMANTIC_FAILED_ERROR", () => {
    const v = validateAttemptRecord(makeAttemptRecord({
      assertion: "failed", assertionError: null,
    }));
    expect(v.map((x) => x.code)).toContain("SEMANTIC_FAILED_ERROR");
  });

  it("assertion=not_run but assertionError set → SEMANTIC_NOT_RUN_ERROR", () => {
    const v = validateAttemptRecord(makeAttemptRecord({
      transport: "completed", http: "expected", assertion: "not_run",
      assertionNotRunReason: "not_declared",
      assertionError: { code: "X", message: "y" },
    }));
    expect(v.map((x) => x.code)).toContain("SEMANTIC_NOT_RUN_ERROR");
  });

  it("outcome mismatches classifications → OUTCOME_MISMATCH", () => {
    // Classifications imply failed, but outcome says succeeded.
    const v = validateAttemptRecord(makeAttemptRecord({
      transport: "completed", http: "unexpected", assertion: "not_run", outcome: "succeeded",
    }));
    expect(v.map((x) => x.code)).toContain("OUTCOME_MISMATCH");
  });

  it("succeeded attempt with final=false → NONFINAL_SUCCEEDED_ATTEMPT", () => {
    const v = validateAttemptRecord(makeAttemptRecord({ final: false }));
    expect(v.map((x) => x.code)).toContain("NONFINAL_SUCCEEDED_ATTEMPT");
  });
});

// ─── Phase 4: per-logical-operation sequence violations ──────────────────

describe("buildOperationReport — Phase 4 logical sequence", () => {
  it("noncontiguous attempt numbers (1, 3) → NONCONTIGUOUS_ATTEMPT_NUMBERS", () => {
    const records = [
      makeAttemptRecord({ attemptId: "op-1:1", attemptNumber: 1, final: false, retryable: true,
        outcome: "failed", transport: "failed", http: "not_received", assertion: "not_run",
        status: null, body: { state: "not_read", value: null, error: null },
        error: { category: "timeout", name: "Error", code: "ETIMEDOUT", message: "m" },
        assertionNotRunReason: "transport_failed" }),
      makeAttemptRecord({ attemptId: "op-1:3", attemptNumber: 3, final: true, retryable: false }), // gap at 2
    ];
    const report = buildOperationReport(records);
    expect(codes(report)).toContain("NONCONTIGUOUS_ATTEMPT_NUMBERS");
    expect(report.logical.total).toBe(0); // transactional
  });

  it("multiple final attempts → MULTIPLE_FINAL_ATTEMPTS", () => {
    const records = [
      makeAttemptRecord({ attemptId: "op-1:1", attemptNumber: 1, final: true }),
      makeAttemptRecord({ attemptId: "op-1:2", attemptNumber: 2, final: true,
        outcome: "failed", transport: "failed", http: "not_received", assertion: "not_run",
        status: null, body: { state: "not_read", value: null, error: null },
        error: { category: "timeout", name: "Error", code: "ETIMEDOUT", message: "m" },
        assertionNotRunReason: "transport_failed" }),
    ];
    const report = buildOperationReport(records);
    expect(codes(report)).toContain("MULTIPLE_FINAL_ATTEMPTS");
  });

  it("no final attempt → NO_FINAL_ATTEMPT", () => {
    const records = [
      makeAttemptRecord({ attemptId: "op-1:1", attemptNumber: 1, final: false, retryable: true,
        outcome: "failed", transport: "failed", http: "not_received", assertion: "not_run",
        status: null, body: { state: "not_read", value: null, error: null },
        error: { category: "timeout", name: "Error", code: "ETIMEDOUT", message: "m" },
        assertionNotRunReason: "transport_failed" }),
    ];
    const report = buildOperationReport(records);
    expect(codes(report)).toContain("NO_FINAL_ATTEMPT");
  });

  it("duplicate attemptNumber within one logical op → DUPLICATE_ATTEMPT_NUMBER", () => {
    const records = [
      makeAttemptRecord({ attemptId: "op-1:1a", attemptNumber: 1, final: false, retryable: true,
        outcome: "failed", transport: "failed", http: "not_received", assertion: "not_run",
        status: null, body: { state: "not_read", value: null, error: null },
        error: { category: "timeout", name: "Error", code: "ETIMEDOUT", message: "m" },
        assertionNotRunReason: "transport_failed" }),
      makeAttemptRecord({ attemptId: "op-1:1b", attemptNumber: 1, final: true }),
    ];
    const report = buildOperationReport(records);
    expect(codes(report)).toContain("DUPLICATE_ATTEMPT_NUMBER");
  });

  it("final attempt not last (final:true followed by another) → FINAL_NOT_LAST", () => {
    // attemptNumber 2 is final, but 3 follows. (Also: 3 is succeeded but not final
    // → NONFINAL_SUCCEEDED_ATTEMPT — both surface.)
    const records = [
      makeAttemptRecord({ attemptId: "op-1:1", attemptNumber: 1, final: false, retryable: true,
        outcome: "failed", transport: "failed", http: "not_received", assertion: "not_run",
        status: null, body: { state: "not_read", value: null, error: null },
        error: { category: "timeout", name: "Error", code: "ETIMEDOUT", message: "m" },
        assertionNotRunReason: "transport_failed" }),
      makeAttemptRecord({ attemptId: "op-1:2", attemptNumber: 2, final: true, retryable: false }),
      makeAttemptRecord({ attemptId: "op-1:3", attemptNumber: 3, final: false, retryable: true,
        outcome: "failed", transport: "failed", http: "not_received", assertion: "not_run",
        status: null, body: { state: "not_read", value: null, error: null },
        error: { category: "timeout", name: "Error", code: "ETIMEDOUT", message: "m" },
        assertionNotRunReason: "transport_failed" }),
    ];
    const report = buildOperationReport(records);
    expect(codes(report)).toContain("FINAL_NOT_LAST");
  });

  it("final attempt not highest number → FINAL_NOT_HIGHEST", () => {
    // 2 is final, 3 exists (different number, also non-final-failed).
    // FINAL_NOT_LAST covers "after"; FINAL_NOT_HIGHEST covers "not max".
    const records = [
      makeAttemptRecord({ attemptId: "op-1:1", attemptNumber: 1, final: false, retryable: true,
        outcome: "failed", transport: "failed", http: "not_received", assertion: "not_run",
        status: null, body: { state: "not_read", value: null, error: null },
        error: { category: "timeout", name: "Error", code: "ETIMEDOUT", message: "m" },
        assertionNotRunReason: "transport_failed" }),
      makeAttemptRecord({ attemptId: "op-1:2", attemptNumber: 2, final: true, retryable: false }),
      makeAttemptRecord({ attemptId: "op-1:3", attemptNumber: 3, final: false, retryable: true,
        outcome: "failed", transport: "failed", http: "not_received", assertion: "not_run",
        status: null, body: { state: "not_read", value: null, error: null },
        error: { category: "timeout", name: "Error", code: "ETIMEDOUT", message: "m" },
        assertionNotRunReason: "transport_failed" }),
    ];
    const report = buildOperationReport(records);
    expect(codes(report)).toContain("FINAL_NOT_HIGHEST");
  });
});

// ─── Cascade suppression: Phase 1 defect in a group skips Phase 4 for it ──

describe("buildOperationReport — cascade suppression", () => {
  it("a record with a Phase 1 defect does NOT generate Phase 4 cascade for its group", () => {
    // op-1 has a malformed record (unknown transport). Without cascade
    // suppression, the reducer would also emit NO_FINAL_ATTEMPT (because
    // the malformed record can't be sequenced). With suppression, only the
    // Phase 1 defect is reported.
    const records = [
      makeAttemptRecord({ transport: "purple", final: true }), // Phase 1 defect
    ];
    const report = buildOperationReport(records);
    expect(codes(report)).toContain("UNKNOWN_TRANSPORT");
    expect(codes(report)).not.toContain("NO_FINAL_ATTEMPT");
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
    body.value.ok = 999; // mutate the original after adapter ran
    expect(record.body.value.ok).toBe(1); // record unaffected
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
    // The reducer builds attemptsById via Object.create(null), so the key
    // "__proto__" is treated as a plain string data key, not as a prototype
    // setter. The record is stored under that key; Object.prototype is not
    // polluted.
    const r = makeAttemptRecord({ attemptId: "__proto__", logicalOperationId: "evil", final: true });
    const report = buildOperationReport([r]);
    expect(report.violations).toEqual([]); // valid record
    expect(Object.getPrototypeOf(report.attemptsById)).toBe(null);
    // "__proto__" is a plain key on the null-proto object — the record is
    // retrievable via bracket access.
    expect(report.attemptsById["__proto__"]).toMatchObject({ attemptId: "__proto__", logicalOperationId: "evil" });
    // No global prototype pollution: a fresh plain object has no inherited
    // "polluted" property (the canary).
    expect({}.polluted).toBeUndefined();
    expect(Object.prototype.polluted).toBeUndefined();
  });
});
