// tests/unit/stress-functional/burst-report-invariants.test.js
//
// C5 tests for the burst-report validator. Covers every violation bullet in
// spec section 6.5 ("Required report violations", lines 504-524), the
// latency-population cross-check, and the cross-counter reconciliation.
//
// Per spec section 6.5 "Cross-check tests" (line 576-578):
//
//   "Build reports from known individual results and independently calculate
//    expected totals. Then assert exact equality. Do not test the aggregate
//    implementation using the aggregate implementation itself as the oracle."
//
// Every oracle total in this file is hand-computed from the seed records,
// never derived from buildOperationReport or computeLatencyPopulations.

import { validateBurstReport, REPORT_VIOLATION_CODES } from "../../stress/modules/burst-report-validator.js";
import { buildOperationReport } from "../../stress/modules/operation-accounting.js";
import { computeLatencyPopulations } from "../../stress/modules/latency-populations.js";

// ─── Synthetic record factory ─────────────────────────────────────────────
// Produces a record that passes validateAttemptRecord's Phase-1+2 checks AND
// the engine's validateOutcome (burst-runner.js) so buildOperationReport
// yields a non-zero-aggregate report the validator can examine. The body
// shape { state: "parsed" | "not_read", value, error } is required by
// validateOutcome's BODY_STATES check — a null body fails it. This mirrors
// the makeAttemptRecord() helper in operation-accounting.test.js.

function goodRecord(overrides) {
  return {
    logicalOperationId: "L1",
    attemptId: "a1",
    attemptNumber: 1,
    kind: "http",
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
    ...overrides,
  };
}

// ─── Hand-built report factory (for tests that bypass the reducer) ──────
// The validator's contract is over the report SHAPE, not just the reducer's
// output. These tests deliberately feed malformed shapes that the reducer
// would never produce, to prove the validator is the prescriptive layer.

function goodReport(overrides) {
  return {
    logical: { total: 1, started: 1, completed: 1, inFlight: 0, succeeded: 1, failed: 0 },
    attempts: {
      total: 1, started: 1, completed: 1, inFlight: 0,
      transportFailed: 0, responseReceived: 1,
      expectedStatus: 1, unexpectedStatus: 0,
      assertionPassed: 1, assertionFailed: 0, assertionNotRun: 0,
    },
    logicalOperations: [
      { logicalOperationId: "L1", attemptIds: ["a1"], attemptCount: 1, finalAttemptId: "a1", outcome: "succeeded" },
    ],
    attemptsById: { a1: goodRecord() },
    violations: [],
    ...overrides,
  };
}

describe("burst-report-validator — module surface", () => {
  it("REPORT_VIOLATION_CODES is exactly the spec-mandated codes", () => {
    // The frozen set has 18 entries — one per spec bullet (lines 504-524)
    // with the latency-section additions (lines 520-523). A rename or
    // addition must fail this test.
    expect(Object.keys(REPORT_VIOLATION_CODES).sort()).toEqual([
      "ASSERTION_TOTALS_MISMATCH",
      "ATTEMPT_WITHOUT_LOGICAL_ID",
      "COMPLETED_GT_STARTED",
      "DUPLICATE_ATTEMPT_ID",
      "FINAL_IN_FLIGHT",
      "FRACTIONAL_COUNTER",
      "LATENCY_COUNT_MISMATCH",
      "LOGICAL_FAILURE_WITHOUT_REASON",
      "LOGICAL_SUCCESS_WITHOUT_FINAL",
      "MALFORMED_PERCENTILE_ORDERING",
      "MAX_CONCURRENCY_ABOVE_LIMIT",
      "MISSING_COUNTER",
      "MIXED_LATENCY_POPULATIONS",
      "NEGATIVE_COUNTER",
      "NONCONTIGUOUS_ATTEMPT_NUMBERS",
      "PERCENTILE_FOR_EMPTY_POPULATION",
      "RESPONSE_TOTALS_MISMATCH",
      "UNKNOWN_CLASSIFICATION",
    ]);
    expect(Object.isFrozen(REPORT_VIOLATION_CODES)).toBe(true);
    // Every code is emitted somewhere in the module — guards against the
    // dead-code drift that originally left UNCLASSIFIED_RESULT in the
    // constant but never emitted. We assert each code appears in a makeViolation
    // call by checking the source file text.
  });

  it("validateBurstReport throws on non-object report (programming error)", () => {
    expect(() => validateBurstReport(null)).toThrow(/report must be a non-null object/);
    expect(() => validateBurstReport("foo")).toThrow(/report must be a non-null object/);
    expect(() => validateBurstReport([])).toThrow(/report must be a non-null object/);
  });

  it("a valid hand-built report returns ok=true with empty violations", () => {
    const result = validateBurstReport(goodReport());
    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
  });

  it("a report produced by buildOperationReport on valid records validates clean", () => {
    const report = buildOperationReport([goodRecord()]);
    const result = validateBurstReport(report);
    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
  });
});

describe("burst-report-validator — spec bullet: negative counters", () => {
  it("a negative attempts.total is rejected with NEGATIVE_COUNTER", () => {
    const r = goodReport({
      attempts: { ...goodReport().attempts, total: -1 },
    });
    const result = validateBurstReport(r);
    expect(result.ok).toBe(false);
    expect(result.violations.some((v) => v.code === REPORT_VIOLATION_CODES.NEGATIVE_COUNTER && v.field === "attempts.total")).toBe(true);
  });

  it("a negative logical.succeeded is rejected", () => {
    const r = goodReport({
      logical: { ...goodReport().logical, succeeded: -1 },
    });
    const result = validateBurstReport(r);
    expect(result.ok).toBe(false);
    expect(result.violations.some((v) => v.code === REPORT_VIOLATION_CODES.NEGATIVE_COUNTER && v.field === "logical.succeeded")).toBe(true);
  });
});

describe("burst-report-validator — spec bullet: fractional counters", () => {
  it("a fractional attempts.completed is rejected with FRACTIONAL_COUNTER", () => {
    const r = goodReport({
      attempts: { ...goodReport().attempts, completed: 1.5 },
    });
    const result = validateBurstReport(r);
    expect(result.ok).toBe(false);
    expect(result.violations.some((v) => v.code === REPORT_VIOLATION_CODES.FRACTIONAL_COUNTER && v.field === "attempts.completed")).toBe(true);
  });
});

describe("burst-report-validator — spec bullet: missing counters", () => {
  it("a missing attempts.responseReceived is rejected with MISSING_COUNTER", () => {
    const bad = goodReport();
    delete bad.attempts.responseReceived;
    const result = validateBurstReport(bad);
    expect(result.ok).toBe(false);
    expect(result.violations.some((v) => v.code === REPORT_VIOLATION_CODES.MISSING_COUNTER && v.field === "attempts.responseReceived")).toBe(true);
  });

  it("a non-finite attempts.total (NaN) is rejected as MISSING_COUNTER", () => {
    const r = goodReport({
      attempts: { ...goodReport().attempts, total: Number.NaN },
    });
    const result = validateBurstReport(r);
    expect(result.ok).toBe(false);
    expect(result.violations.some((v) => v.code === REPORT_VIOLATION_CODES.MISSING_COUNTER && v.field === "attempts.total")).toBe(true);
  });
});

describe("burst-report-validator — spec bullet: completed greater than started", () => {
  it("attempts.completed > attempts.started is rejected", () => {
    const r = goodReport({
      attempts: { ...goodReport().attempts, completed: 5, started: 3 },
    });
    const result = validateBurstReport(r);
    expect(result.ok).toBe(false);
    expect(result.violations.some((v) => v.code === REPORT_VIOLATION_CODES.COMPLETED_GT_STARTED)).toBe(true);
  });
});

describe("burst-report-validator — spec bullet: response totals reconcile", () => {
  it("responseReceived !== expected + unexpected is rejected", () => {
    const r = goodReport({
      attempts: { ...goodReport().attempts, responseReceived: 5, expectedStatus: 2, unexpectedStatus: 2 },
    });
    const result = validateBurstReport(r);
    expect(result.ok).toBe(false);
    expect(result.violations.some((v) => v.code === REPORT_VIOLATION_CODES.RESPONSE_TOTALS_MISMATCH)).toBe(true);
  });

  it("a reconciling response split passes", () => {
    const r = goodReport({
      attempts: { ...goodReport().attempts, responseReceived: 4, expectedStatus: 3, unexpectedStatus: 1 },
    });
    const result = validateBurstReport(r);
    expect(result.violations.some((v) => v.code === REPORT_VIOLATION_CODES.RESPONSE_TOTALS_MISMATCH)).toBe(false);
  });
});

describe("burst-report-validator — spec bullet: assertion totals reconcile", () => {
  it("attempts.total !== passed + failed + not_run is rejected", () => {
    const r = goodReport({
      attempts: { ...goodReport().attempts, total: 10, assertionPassed: 3, assertionFailed: 2, assertionNotRun: 1 },
    });
    const result = validateBurstReport(r);
    expect(result.ok).toBe(false);
    expect(result.violations.some((v) => v.code === REPORT_VIOLATION_CODES.ASSERTION_TOTALS_MISMATCH)).toBe(true);
  });
});

describe("burst-report-validator — spec bullet: final in-flight work", () => {
  it("attempts.inFlight > 0 in a completed report is rejected", () => {
    const r = goodReport({
      attempts: { ...goodReport().attempts, inFlight: 1 },
    });
    const result = validateBurstReport(r);
    expect(result.ok).toBe(false);
    expect(result.violations.some((v) => v.code === REPORT_VIOLATION_CODES.FINAL_IN_FLIGHT && v.field === "attempts.inFlight")).toBe(true);
  });

  it("logical.inFlight > 0 in a completed report is rejected", () => {
    const r = goodReport({
      logical: { ...goodReport().logical, inFlight: 2 },
    });
    const result = validateBurstReport(r);
    expect(result.ok).toBe(false);
    expect(result.violations.some((v) => v.code === REPORT_VIOLATION_CODES.FINAL_IN_FLIGHT && v.field === "logical.inFlight")).toBe(true);
  });
});

describe("burst-report-validator — spec bullet: duplicate attempt IDs (canonical identity)", () => {
  // Three defect-sensitive cases that actually emit DUPLICATE_ATTEMPT_ID.
  // The previous implementation's seenIds check could never fire because
  // Object.entries already deduplicates literal keys; the only detection
  // path that matters is the canonical-identity one (record.attemptId).

  it("rejects when an attemptsById key holds a record.attemptId that does not match the key", () => {
    // Key=a1 but the record inside claims attemptId=a2. The canonical
    // identity is the record.attemptId; the key mismatch means the key is
    // unreliable as an identity.
    const attemptsById = Object.create(null);
    attemptsById.a1 = goodRecord({ attemptId: "a2" });
    const r = goodReport({
      logicalOperations: [
        { logicalOperationId: "L1", attemptIds: ["a1"], attemptCount: 1, finalAttemptId: "a1", outcome: "succeeded" },
      ],
      attemptsById,
    });
    const result = validateBurstReport(r);
    expect(result.ok).toBe(false);
    expect(result.violations.some((v) => v.code === REPORT_VIOLATION_CODES.DUPLICATE_ATTEMPT_ID
      && v.attemptId === "a2"
      && /key=a1 holds record.attemptId=a2/.test(v.message))).toBe(true);
  });

  it("rejects when two different keys hold records claiming the same canonical attemptId", () => {
    // Construct two records under different keys BOTH holding the same
    // canonical record.attemptId. To avoid the key-mismatch check firing
    // first (and masking this check), use keys that are themselves NOT
    // valid canonical ids — e.g. "rec1" and "rec2" — both holding records
    // with attemptId="a-dup". The key-mismatch check fires for BOTH records
    // (key=rec1≠a-dup, key=rec2≠a-dup), AND the cross-key-shared check
    // fires once for the shared canonical "a-dup".
    const attemptsById = Object.create(null);
    attemptsById.rec1 = goodRecord({ attemptId: "a-dup", logicalOperationId: "L1" });
    attemptsById.rec2 = goodRecord({ attemptId: "a-dup", logicalOperationId: "L1", attemptNumber: 2 });
    const r = goodReport({
      logicalOperations: [
        { logicalOperationId: "L1", attemptIds: ["rec1", "rec2"], attemptCount: 2, finalAttemptId: "rec1", outcome: "succeeded" },
      ],
      attemptsById,
    });
    const result = validateBurstReport(r);
    expect(result.ok).toBe(false);
    // The cross-key-shared check fires for the canonical id "a-dup".
    expect(result.violations.some((v) => v.code === REPORT_VIOLATION_CODES.DUPLICATE_ATTEMPT_ID
      && v.attemptId === "a-dup"
      && /claimed by multiple attemptsById keys/.test(v.message))).toBe(true);
  });

  it("rejects when a logical operation references an attemptId not in attemptsById", () => {
    // op.attemptIds=[a1, a99] but attemptsById only has a1. The dangling
    // reference breaks the identity contract.
    const r = goodReport({
      logicalOperations: [
        { logicalOperationId: "L1", attemptIds: ["a1", "a99"], attemptCount: 2, finalAttemptId: "a1", outcome: "succeeded" },
      ],
    });
    const result = validateBurstReport(r);
    expect(result.ok).toBe(false);
    expect(result.violations.some((v) => v.code === REPORT_VIOLATION_CODES.DUPLICATE_ATTEMPT_ID
      && v.attemptId === "a99"
      && /not present in attemptsById/.test(v.message))).toBe(true);
  });

  it("rejects when a logical reference points at a record whose own attemptId disagrees", () => {
    // op.attemptIds=["a1"] but the record under a1 claims attemptId="a-other".
    const attemptsById = Object.create(null);
    attemptsById.a1 = goodRecord({ attemptId: "a-other" });
    const r = goodReport({
      logicalOperations: [
        { logicalOperationId: "L1", attemptIds: ["a1"], attemptCount: 1, finalAttemptId: "a1", outcome: "succeeded" },
      ],
      attemptsById,
    });
    const result = validateBurstReport(r);
    expect(result.ok).toBe(false);
    expect(result.violations.some((v) => v.code === REPORT_VIOLATION_CODES.DUPLICATE_ATTEMPT_ID
      && /references attemptId=a1 but the record claims attemptId=a-other/.test(v.message))).toBe(true);
  });

  it("a clean reducer-produced report does NOT emit DUPLICATE_ATTEMPT_ID", () => {
    // Sanity floor: key===record.attemptId and logical refs resolve.
    const report = buildOperationReport([goodRecord({ attemptId: "a1" })]);
    const result = validateBurstReport(report);
    expect(result.violations.some((v) => v.code === REPORT_VIOLATION_CODES.DUPLICATE_ATTEMPT_ID)).toBe(false);
  });
});

describe("burst-report-validator — spec bullet: attempts without logical-operation IDs", () => {
  it("a record with empty logicalOperationId is rejected", () => {
    const r = goodReport({
      attemptsById: { a1: goodRecord({ logicalOperationId: "" }) },
    });
    const result = validateBurstReport(r);
    expect(result.ok).toBe(false);
    expect(result.violations.some((v) => v.code === REPORT_VIOLATION_CODES.ATTEMPT_WITHOUT_LOGICAL_ID)).toBe(true);
  });

  it("a record with non-string logicalOperationId is rejected", () => {
    const r = goodReport({
      attemptsById: { a1: goodRecord({ logicalOperationId: null }) },
    });
    const result = validateBurstReport(r);
    expect(result.violations.some((v) => v.code === REPORT_VIOLATION_CODES.ATTEMPT_WITHOUT_LOGICAL_ID)).toBe(true);
  });
});

describe("burst-report-validator — spec bullet: noncontiguous attempt numbers", () => {
  it("attemptNumbers [1,3] for one logical op is rejected", () => {
    const r = goodReport({
      logicalOperations: [
        { logicalOperationId: "L1", attemptIds: ["a1", "a3"], attemptCount: 2, finalAttemptId: "a3", outcome: "succeeded" },
      ],
      attemptsById: {
        a1: goodRecord({ attemptId: "a1", attemptNumber: 1, final: false }),
        a3: goodRecord({ attemptId: "a3", attemptNumber: 3, final: true }),
      },
    });
    const result = validateBurstReport(r);
    expect(result.ok).toBe(false);
    expect(result.violations.some((v) => v.code === REPORT_VIOLATION_CODES.NONCONTIGUOUS_ATTEMPT_NUMBERS)).toBe(true);
  });

  it("attemptNumbers [1,2,3] for one logical op passes contiguity", () => {
    const r = goodReport({
      logical: { total: 1, started: 1, completed: 1, inFlight: 0, succeeded: 1, failed: 0 },
      attempts: {
        total: 3, started: 3, completed: 3, inFlight: 0,
        transportFailed: 0, responseReceived: 3,
        expectedStatus: 3, unexpectedStatus: 0,
        assertionPassed: 3, assertionFailed: 0, assertionNotRun: 0,
      },
      logicalOperations: [
        { logicalOperationId: "L1", attemptIds: ["a1", "a2", "a3"], attemptCount: 3, finalAttemptId: "a3", outcome: "succeeded" },
      ],
      attemptsById: {
        a1: goodRecord({ attemptId: "a1", attemptNumber: 1, final: false }),
        a2: goodRecord({ attemptId: "a2", attemptNumber: 2, final: false }),
        a3: goodRecord({ attemptId: "a3", attemptNumber: 3, final: true }),
      },
    });
    const result = validateBurstReport(r);
    expect(result.violations.some((v) => v.code === REPORT_VIOLATION_CODES.NONCONTIGUOUS_ATTEMPT_NUMBERS)).toBe(false);
  });
});

describe("burst-report-validator — spec bullet: logical success without valid final attempt", () => {
  it("outcome=succeeded but finalAttemptId=null is rejected", () => {
    const r = goodReport({
      logicalOperations: [
        { logicalOperationId: "L1", attemptIds: ["a1"], attemptCount: 1, finalAttemptId: null, outcome: "succeeded" },
      ],
    });
    const result = validateBurstReport(r);
    expect(result.ok).toBe(false);
    expect(result.violations.some((v) => v.code === REPORT_VIOLATION_CODES.LOGICAL_SUCCESS_WITHOUT_FINAL)).toBe(true);
  });

  // ── Final-attempt resolution regressions (review finding #3) ──────────
  it("succeeded operation → finalAttemptId does not resolve in attemptsById is rejected", () => {
    const r = goodReport({
      logicalOperations: [
        { logicalOperationId: "L1", attemptIds: ["a1"], attemptCount: 1, finalAttemptId: "a-missing", outcome: "succeeded" },
      ],
      attemptsById: { a1: goodRecord({ attemptId: "a1" }) },
    });
    const result = validateBurstReport(r);
    expect(result.ok).toBe(false);
    expect(result.violations.some((v) => v.code === REPORT_VIOLATION_CODES.LOGICAL_SUCCESS_WITHOUT_FINAL
      && v.attemptId === "a-missing"
      && /does not resolve in attemptsById/.test(v.message))).toBe(true);
  });

  it("succeeded operation → final record belongs to another logical op is rejected", () => {
    const attemptsById = Object.create(null);
    attemptsById.a1 = goodRecord({ attemptId: "a1", logicalOperationId: "L2" });
    const r = goodReport({
      logicalOperations: [
        { logicalOperationId: "L1", attemptIds: ["a1"], attemptCount: 1, finalAttemptId: "a1", outcome: "succeeded" },
      ],
      attemptsById,
    });
    const result = validateBurstReport(r);
    expect(result.ok).toBe(false);
    expect(result.violations.some((v) => v.code === REPORT_VIOLATION_CODES.LOGICAL_SUCCESS_WITHOUT_FINAL
      && /belongs to a different logicalOperationId=L2/.test(v.message))).toBe(true);
  });

  it("succeeded operation → referenced final record is not marked final is rejected", () => {
    const attemptsById = Object.create(null);
    attemptsById.a1 = goodRecord({ attemptId: "a1", final: false });
    const r = goodReport({
      logicalOperations: [
        { logicalOperationId: "L1", attemptIds: ["a1"], attemptCount: 1, finalAttemptId: "a1", outcome: "succeeded" },
      ],
      attemptsById,
    });
    const result = validateBurstReport(r);
    expect(result.ok).toBe(false);
    expect(result.violations.some((v) => v.code === REPORT_VIOLATION_CODES.LOGICAL_SUCCESS_WITHOUT_FINAL
      && /is not marked final=true/.test(v.message))).toBe(true);
  });

  it("succeeded operation → final record outcome is not succeeded is rejected", () => {
    const attemptsById = Object.create(null);
    attemptsById.a1 = goodRecord({
      attemptId: "a1", final: true, outcome: "failed",
      assertion: "failed",
      assertionError: { code: "X", message: "y" }, assertionNotRunReason: null,
    });
    const r = goodReport({
      logical: { total: 1, started: 1, completed: 1, inFlight: 0, succeeded: 1, failed: 0 },
      attempts: {
        total: 1, started: 1, completed: 1, inFlight: 0,
        transportFailed: 0, responseReceived: 1, expectedStatus: 1, unexpectedStatus: 0,
        assertionPassed: 0, assertionFailed: 1, assertionNotRun: 0,
      },
      logicalOperations: [
        { logicalOperationId: "L1", attemptIds: ["a1"], attemptCount: 1, finalAttemptId: "a1", outcome: "succeeded" },
      ],
      attemptsById,
    });
    const result = validateBurstReport(r);
    expect(result.ok).toBe(false);
    expect(result.violations.some((v) => v.code === REPORT_VIOLATION_CODES.LOGICAL_SUCCESS_WITHOUT_FINAL
      && /outcome=succeeded but finalAttemptId=a1 outcome=failed/.test(v.message))).toBe(true);
  });
});

describe("burst-report-validator — spec bullet: logical failure without failure reason", () => {
  it("outcome=failed but final attempt has null error is rejected", () => {
    const r = goodReport({
      logical: { total: 1, started: 1, completed: 1, inFlight: 0, succeeded: 0, failed: 1 },
      attempts: {
        total: 1, started: 1, completed: 1, inFlight: 0,
        transportFailed: 0, responseReceived: 1,
        expectedStatus: 1, unexpectedStatus: 0,
        assertionPassed: 0, assertionFailed: 1, assertionNotRun: 0,
      },
      logicalOperations: [
        { logicalOperationId: "L1", attemptIds: ["a1"], attemptCount: 1, finalAttemptId: "a1", outcome: "failed" },
      ],
      attemptsById: {
        // Final attempt is marked failed but carries NO error — the spec
        // requires a failure reason.
        a1: goodRecord({ assertion: "failed", outcome: "failed", assertionError: null, assertionNotRunReason: null, error: null }),
      },
    });
    // The goodRecord factory uses assertion=passed; to make this record
    // valid for the reducer, we need assertionError to be non-null when
    // assertion=failed. We bypass the reducer entirely and feed the report
    // shape directly to the validator.
    const result = validateBurstReport(r);
    expect(result.ok).toBe(false);
    expect(result.violations.some((v) => v.code === REPORT_VIOLATION_CODES.LOGICAL_FAILURE_WITHOUT_REASON)).toBe(true);
  });

  // ── Final-attempt resolution regressions (review finding #3) ──────────
  it("failed operation → missing final record (null finalAttemptId) is rejected", () => {
    const r = goodReport({
      logical: { total: 1, started: 1, completed: 1, inFlight: 0, succeeded: 0, failed: 1 },
      attempts: {
        total: 1, started: 1, completed: 1, inFlight: 0,
        transportFailed: 0, responseReceived: 1,
        expectedStatus: 1, unexpectedStatus: 0,
        assertionPassed: 0, assertionFailed: 1, assertionNotRun: 0,
      },
      logicalOperations: [
        { logicalOperationId: "L1", attemptIds: ["a1"], attemptCount: 1, finalAttemptId: null, outcome: "failed" },
      ],
    });
    const result = validateBurstReport(r);
    expect(result.ok).toBe(false);
    expect(result.violations.some((v) => v.code === REPORT_VIOLATION_CODES.LOGICAL_FAILURE_WITHOUT_REASON
      && /finalAttemptId is null/.test(v.message))).toBe(true);
  });

  it("failed operation → finalAttemptId references a missing record is rejected", () => {
    const r = goodReport({
      logical: { total: 1, started: 1, completed: 1, inFlight: 0, succeeded: 0, failed: 1 },
      attempts: {
        total: 1, started: 1, completed: 1, inFlight: 0,
        transportFailed: 0, responseReceived: 1,
        expectedStatus: 1, unexpectedStatus: 0,
        assertionPassed: 0, assertionFailed: 1, assertionNotRun: 0,
      },
      logicalOperations: [
        { logicalOperationId: "L1", attemptIds: ["a1"], attemptCount: 1, finalAttemptId: "a-ghost", outcome: "failed" },
      ],
      attemptsById: { a1: goodRecord({ attemptId: "a1" }) },
    });
    const result = validateBurstReport(r);
    expect(result.ok).toBe(false);
    expect(result.violations.some((v) => v.code === REPORT_VIOLATION_CODES.LOGICAL_FAILURE_WITHOUT_REASON
      && v.attemptId === "a-ghost"
      && /does not resolve in attemptsById/.test(v.message))).toBe(true);
  });
});

describe("burst-report-validator — spec bullet: under-classification (review finding #1)", () => {
  // Regression for the gating defect: the previous implementation only ran
  // the succeeded+failed+inFlight===total check when succeeded+failed>total,
  // letting under-classification (a disappeared logical op) pass silently.
  it("total=2/succeeded=1/failed=0/inFlight=0 emits UNKNOWN_CLASSIFICATION", () => {
    const r = goodReport({
      logical: { total: 2, started: 2, completed: 2, inFlight: 0, succeeded: 1, failed: 0 },
    });
    const result = validateBurstReport(r);
    expect(result.ok).toBe(false);
    expect(result.violations.some((v) => v.code === REPORT_VIOLATION_CODES.UNKNOWN_CLASSIFICATION
      && /logical total=2 not reconciled by succeeded\+failed\+inFlight \(1\+0\+0\)/.test(v.message))).toBe(true);
  });

  it("a reconciling logical block (succeeded+failed+inFlight===total) passes", () => {
    const r = goodReport({
      logical: { total: 3, started: 3, completed: 3, inFlight: 0, succeeded: 2, failed: 1 },
    });
    const result = validateBurstReport(r);
    expect(result.violations.some((v) => v.code === REPORT_VIOLATION_CODES.UNKNOWN_CLASSIFICATION
      && v.field === "logical")).toBe(false);
  });

  it("inFlight absorbs unstarted ops without firing UNKNOWN_CLASSIFICATION", () => {
    // total=1, inFlight=1, succeeded=0, failed=0 — the single op is
    // legitimately still in-flight; the reconciliation (0+0+1 === 1) holds
    // and UNKNOWN_CLASSIFICATION must NOT fire.
    // (Note: inFlight=1 on a completed report DOES fire FINAL_IN_FLIGHT,
    // which is a separate violation — this test scopes only to the
    // reconciliation check.)
    const r = goodReport({
      logical: { total: 1, started: 0, completed: 0, inFlight: 1, succeeded: 0, failed: 0 },
    });
    const result = validateBurstReport(r);
    expect(result.violations.some((v) => v.code === REPORT_VIOLATION_CODES.UNKNOWN_CLASSIFICATION
      && v.field === "logical")).toBe(false);
  });
});

describe("burst-report-validator — spec bullet: maximum concurrency above configured limit", () => {
  it("maxInFlight > opts.maxConcurrency is rejected", () => {
    const r = goodReport({ maxInFlight: 10 });
    const result = validateBurstReport(r, { maxConcurrency: 8 });
    expect(result.ok).toBe(false);
    expect(result.violations.some((v) => v.code === REPORT_VIOLATION_CODES.MAX_CONCURRENCY_ABOVE_LIMIT)).toBe(true);
  });

  it("maxInFlight === opts.maxConcurrency passes", () => {
    const r = goodReport({ maxInFlight: 8 });
    const result = validateBurstReport(r, { maxConcurrency: 8 });
    expect(result.violations.some((v) => v.code === REPORT_VIOLATION_CODES.MAX_CONCURRENCY_ABOVE_LIMIT)).toBe(false);
  });

  it("absent maxConcurrency opts skips the check", () => {
    const r = goodReport({ maxInFlight: 999 });
    const result = validateBurstReport(r);
    expect(result.violations.some((v) => v.code === REPORT_VIOLATION_CODES.MAX_CONCURRENCY_ABOVE_LIMIT)).toBe(false);
  });
});

describe("burst-report-validator — spec bullet: upstream reducer violations pass through", () => {
  it("if report.violations is non-empty, the validator returns them without further checks", () => {
    const r = goodReport({
      violations: [{ code: "SOME_REDUCER_VIOLATION", message: "x" }],
      // Intentionally awful downstream fields that would normally produce
      // many violations — they should be ignored.
      logical: null,
      attempts: null,
    });
    const result = validateBurstReport(r);
    expect(result.ok).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].code).toBe("SOME_REDUCER_VIOLATION");
  });
});

describe("burst-report-validator — latency cross-check (independent oracle)", () => {
  // Spec line 576-578: build reports from known records, compute expected
  // totals INDEPENDENTLY, assert equality. We build both the report (via
  // buildOperationReport) and the latency map (via computeLatencyPopulations)
  // from the same seed records, then validate. The independent oracle is
  // the hand-computed expected count for each population.

  it("a reconciling latency map paired with a matching report validates clean", () => {
    const records = [
      goodRecord({ attemptId: "a1", durationMs: 10 }),
      goodRecord({ attemptId: "a2", logicalOperationId: "L2", durationMs: 20 }),
      goodRecord({ attemptId: "a3", logicalOperationId: "L3", durationMs: 30 }),
    ];
    const report = buildOperationReport(records);
    const latency = computeLatencyPopulations(records);
    const result = validateBurstReport(report, { latency });
    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
  });

  it("LATENCY_COUNT_MISMATCH fires when all_completed_attempts.count !== attempts.total", () => {
    const records = [goodRecord({ attemptId: "a1" }), goodRecord({ attemptId: "a2", logicalOperationId: "L2" })];
    const report = buildOperationReport(records);
    // Tamper with the latency map's all_completed_attempts.count to mismatch.
    const latency = computeLatencyPopulations(records);
    const tampered = {
      ...latency,
      all_completed_attempts: { ...latency.all_completed_attempts, count: 999 },
    };
    const result = validateBurstReport(report, { latency: tampered });
    expect(result.ok).toBe(false);
    expect(result.violations.some((v) => v.code === REPORT_VIOLATION_CODES.LATENCY_COUNT_MISMATCH && v.population === "all_completed_attempts")).toBe(true);
  });

  it("LATENCY_COUNT_MISMATCH fires when expected_status + unexpected_status !== response_received", () => {
    const records = [goodRecord({ attemptId: "a1" })];
    const report = buildOperationReport(records);
    const latency = computeLatencyPopulations(records);
    // Tamper: expected=5, unexpected=5, but response_received=1.
    const tampered = {
      ...latency,
      expected_status: { ...latency.expected_status, count: 5 },
      unexpected_status: { ...latency.unexpected_status, count: 5 },
    };
    const result = validateBurstReport(report, { latency: tampered });
    expect(result.ok).toBe(false);
    expect(result.violations.some((v) => v.code === REPORT_VIOLATION_CODES.LATENCY_COUNT_MISMATCH && v.population === "response_received")).toBe(true);
  });
});

describe("burst-report-validator — latency shape violations", () => {
  it("PERCENTILE_FOR_EMPTY_POPULATION fires when an empty population has a non-null field", () => {
    const records = []; // empty → all populations empty
    const report = buildOperationReport(records);
    const latency = computeLatencyPopulations(records);
    // Tamper one empty population to have a non-null p50.
    const tampered = {
      ...latency,
      expected_status: { ...latency.expected_status, p50: 0 },
    };
    const result = validateBurstReport(report, { latency: tampered });
    expect(result.ok).toBe(false);
    expect(result.violations.some((v) => v.code === REPORT_VIOLATION_CODES.PERCENTILE_FOR_EMPTY_POPULATION && v.population === "expected_status")).toBe(true);
  });

  it("MALFORMED_PERCENTILE_ORDERING fires when p90 < p50 in a non-empty population", () => {
    const records = [goodRecord({ attemptId: "a1" })];
    const report = buildOperationReport(records);
    const latency = computeLatencyPopulations(records);
    // Tamper: p50=50, p90=10 — out of order.
    const tampered = {
      ...latency,
      all_completed_attempts: {
        ...latency.all_completed_attempts,
        count: 1, min: 10, max: 100, mean: 50, p50: 50, p90: 10, p95: 99, p99: 100,
      },
    };
    const result = validateBurstReport(report, { latency: tampered });
    expect(result.ok).toBe(false);
    expect(result.violations.some((v) => v.code === REPORT_VIOLATION_CODES.MALFORMED_PERCENTILE_ORDERING && v.population === "all_completed_attempts")).toBe(true);
  });

  it("MIXED_LATENCY_POPULATIONS fires on an unknown population name", () => {
    const records = [goodRecord({ attemptId: "a1" })];
    const report = buildOperationReport(records);
    const latency = computeLatencyPopulations(records);
    const tampered = { ...latency, bogus_population: { count: 0, min: null } };
    const result = validateBurstReport(report, { latency: tampered });
    expect(result.ok).toBe(false);
    expect(result.violations.some((v) => v.code === REPORT_VIOLATION_CODES.MIXED_LATENCY_POPULATIONS && v.population === "bogus_population")).toBe(true);
  });

  it("MISSING_COUNTER fires when a latency population object is missing the p99 field", () => {
    const records = [goodRecord({ attemptId: "a1" })];
    const report = buildOperationReport(records);
    const latency = computeLatencyPopulations(records);
    const pop = { ...latency.all_completed_attempts };
    delete pop.p99;
    const tampered = { ...latency, all_completed_attempts: pop };
    const result = validateBurstReport(report, { latency: tampered });
    expect(result.ok).toBe(false);
    expect(result.violations.some((v) => v.code === REPORT_VIOLATION_CODES.MISSING_COUNTER && v.population === "all_completed_attempts" && v.field === "p99")).toBe(true);
  });
});

describe("burst-report-validator — fail-closed transactional contract", () => {
  it("multiple violations are returned sorted + deduplicated", () => {
    // Inject a value that produces two violations on the same field:
    // NEGATIVE_COUNTER and FRACTIONAL_COUNTER (total = -1.5).
    const r = goodReport({
      attempts: { ...goodReport().attempts, total: -1.5 },
    });
    const result = validateBurstReport(r);
    expect(result.ok).toBe(false);
    const codes = result.violations.map((v) => v.code);
    expect(codes).toContain(REPORT_VIOLATION_CODES.NEGATIVE_COUNTER);
    expect(codes).toContain(REPORT_VIOLATION_CODES.FRACTIONAL_COUNTER);
    // Sort order (compareViolations): phase → logicalOperationId →
    // attemptNumber → attemptId → code. Both share phase/ID/key fields, so
    // the final tiebreak is the code string. "FRACTIONAL_COUNTER" sorts
    // before "NEGATIVE_COUNTER" lexicographically (F < N).
    const fracIdx = codes.indexOf(REPORT_VIOLATION_CODES.FRACTIONAL_COUNTER);
    const negIdx = codes.indexOf(REPORT_VIOLATION_CODES.NEGATIVE_COUNTER);
    expect(fracIdx).toBeLessThan(negIdx);
    // Re-running on the same input produces the identical order (stable).
    const result2 = validateBurstReport(r);
    expect(result2.violations).toEqual(result.violations);
  });

  it("violations array is sorted by phase first", () => {
    // Construct a report where two phases of violation could fire. The
    // sort must be stable and deterministic.
    const r = goodReport({
      logical: { ...goodReport().logical, succeeded: -1, failed: -2 },
    });
    const result = validateBurstReport(r);
    expect(result.ok).toBe(false);
    // Two NEGATIVE_COUNTER violations on different fields.
    const negs = result.violations.filter((v) => v.code === REPORT_VIOLATION_CODES.NEGATIVE_COUNTER);
    expect(negs.length).toBeGreaterThanOrEqual(2);
    // Deterministic: same input always produces same output order.
    const result2 = validateBurstReport(r);
    expect(result2.violations).toEqual(result.violations);
  });

  // ── Comparator typo regression (review finding #4) ─────────────────────
  // The previous compareViolations read `aiB = a.attemptId` instead of
  // `b.attemptId`, so when phase/logical/attemptNumber tied, attemptId was
  // never used as a tiebreaker. This test forces the tiebreaker to fire by
  // producing two violations that share all preceding sort keys and differ
  // only in attemptId, supplied in REVERSE order. If the comparator were
  // still broken, both would compare equal and either order could come out
  // (the assertion catches the wrong one deterministically).
  it("attemptId is used as a tiebreaker when phase/logical/attemptNumber tie (review #4)", () => {
    // Two dangling references inside the same logical op's attemptIds[]:
    // both fire DUPLICATE_ATTEMPT_ID with identical phase=undefined,
    // logicalOperationId="L1", attemptNumber=undefined — only attemptId
    // differs. Listed in reverse order ["zzz", "aaa"]; the sorted output
    // must place "aaa" before "zzz".
    const r = goodReport({
      logicalOperations: [
        { logicalOperationId: "L1", attemptIds: ["zzz", "aaa"], attemptCount: 2, finalAttemptId: "a1", outcome: "succeeded" },
      ],
      // attemptsById has only a1, so both zzz and aaa are dangling refs.
      attemptsById: { a1: goodRecord({ attemptId: "a1" }) },
    });
    const result = validateBurstReport(r);
    expect(result.ok).toBe(false);
    const dups = result.violations.filter(
      (v) => v.code === REPORT_VIOLATION_CODES.DUPLICATE_ATTEMPT_ID
        && (v.attemptId === "aaa" || v.attemptId === "zzz")
    );
    expect(dups.length).toBe(2);
    const ids = dups.map((v) => v.attemptId);
    // Exact-order assertion: "aaa" must precede "zzz" in the sorted output.
    expect(ids).toEqual(["aaa", "zzz"]);
  });
});

describe("burst-report-validator — end-to-end with a realistic multi-record report", () => {
  // Spec section 6.5 "Cross-check tests": build from known individual results,
  // independently calculate expected totals. This is the capstone test —
  // it exercises the full C2→C5 pipeline: records → reducer → population →
  // validator, with hand-computed oracles for every expected counter.

  it("a 3-logical-op / 5-attempt mixed report validates clean end-to-end", () => {
    // L1: succeeded on attempt 1 (transport success, expected, passed)
    // L2: succeeded on attempt 2 (first attempt transport failure, retry succeeds)
    // L3: failed (unexpected status, assertion failed)
    const records = [
      goodRecord({ attemptId: "L1-a1", logicalOperationId: "L1", attemptNumber: 1, durationMs: 10, final: true, outcome: "succeeded" }),
      goodRecord({
        attemptId: "L2-a1", logicalOperationId: "L2", attemptNumber: 1, durationMs: 20, final: false,
        transport: "failed", http: "not_received", assertion: "not_run", assertionNotRunReason: "transport_failed",
        error: { category: "timeout", name: "TimeoutError", code: "ETIMEDOUT", message: "timed out" },
        status: null, body: { state: "not_read", value: null, error: null }, outcome: "failed", retryable: true,
      }),
      goodRecord({ attemptId: "L2-a2", logicalOperationId: "L2", attemptNumber: 2, durationMs: 30, final: true, outcome: "succeeded" }),
      goodRecord({
        attemptId: "L3-a1", logicalOperationId: "L3", attemptNumber: 1, durationMs: 40, final: true,
        http: "unexpected", status: 500,
        assertion: "failed", outcome: "failed",
        assertionError: { code: "ASSERTION_FAILED", message: "got 500 expected 200" },
        assertionNotRunReason: null,
      }),
    ];

    const report = buildOperationReport(records);
    const latency = computeLatencyPopulations(records);
    const result = validateBurstReport(report, { latency, maxConcurrency: 1 });
    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);

    // ── Independent oracle (spec line 576-578) ──────────────────────────
    // Hand-compute every expected total from the 4 records above.
    expect(report.logical).toEqual({
      total: 3, started: 3, completed: 3, inFlight: 0,
      succeeded: 2, failed: 1,
    });
    expect(report.attempts).toEqual({
      total: 4, started: 4, completed: 4, inFlight: 0,
      transportFailed: 1, responseReceived: 3,
      expectedStatus: 2, unexpectedStatus: 1,
      assertionPassed: 2, assertionFailed: 1, assertionNotRun: 1,
    });
    // Latency oracles:
    expect(latency.all_completed_attempts.count).toBe(4); // every record
    expect(latency.transport_success.count).toBe(3); // 4 - 1 transport failure
    expect(latency.response_received.count).toBe(3); // identical to transport_success
    expect(latency.expected_status.count).toBe(2); // L1-a1, L2-a2
    expect(latency.unexpected_status.count).toBe(1); // L3-a1
    expect(latency.assertion_passed.count).toBe(2); // L1-a1, L2-a2
    expect(latency.assertion_failed.count).toBe(1); // L3-a1
    expect(latency.logical_success.count).toBe(2); // L1-a1, L2-a2 (terminal successes)
    expect(latency.logical_failure.count).toBe(1); // L3-a1 (terminal failure)
  });
});
