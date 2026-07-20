// packages/web/tests/stress/modules/burst-report-validator.js
//
// C5 of P2: fail-closed validator for completed burst reports. Implements
// validateBurstReport(report) per spec section 6.5 ("Required report
// violations") and section 6.5 ("Latency populations"). It accepts the report
// shape produced by buildOperationReport (operation-accounting.js) plus an
// optional latency-population map (latency-populations.js) and cross-checks
// every invariant the spec enumerates.
//
// Fail-closed contract (mirrors operation-accounting.js): on ANY violation,
// the validator returns the exact sorted deduplicated violation array and a
// zeroed/empty authoritative view. Callers never need to catch exceptions to
// collect ordinary findings.
//
// Throw contract: validateBurstReport throws ONLY when its top-level argument
// is not an object (programming error), and validateBurstReportWithLatency
// throws only when its second argument is not a latency map. Record/report
// data defects produce structured violations, never throws.
//
// Determinism contract: imported by the static-gate collector; contains NO
// Date.now / performance.now / setTimeout / setInterval.

import { POPULATION_NAMES, emptyLatency } from "./latency-populations.js";

// ─── Stable violation codes ───────────────────────────────────────────────
// Each maps 1:1 to a spec line 504–524 bullet. The set is frozen and tests
// assert exact membership so a rename is caught.

export const REPORT_VIOLATION_CODES = Object.freeze({
  NEGATIVE_COUNTER: "NEGATIVE_COUNTER",
  FRACTIONAL_COUNTER: "FRACTIONAL_COUNTER",
  MISSING_COUNTER: "MISSING_COUNTER",
  UNKNOWN_CLASSIFICATION: "UNKNOWN_CLASSIFICATION",
  COMPLETED_GT_STARTED: "COMPLETED_GT_STARTED",
  RESPONSE_TOTALS_MISMATCH: "RESPONSE_TOTALS_MISMATCH",
  ASSERTION_TOTALS_MISMATCH: "ASSERTION_TOTALS_MISMATCH",
  FINAL_IN_FLIGHT: "FINAL_IN_FLIGHT",
  DUPLICATE_ATTEMPT_ID: "DUPLICATE_ATTEMPT_ID",
  ATTEMPT_WITHOUT_LOGICAL_ID: "ATTEMPT_WITHOUT_LOGICAL_ID",
  NONCONTIGUOUS_ATTEMPT_NUMBERS: "NONCONTIGUOUS_ATTEMPT_NUMBERS",
  LOGICAL_SUCCESS_WITHOUT_FINAL: "LOGICAL_SUCCESS_WITHOUT_FINAL",
  LOGICAL_FAILURE_WITHOUT_REASON: "LOGICAL_FAILURE_WITHOUT_REASON",
  LATENCY_COUNT_MISMATCH: "LATENCY_COUNT_MISMATCH",
  PERCENTILE_FOR_EMPTY_POPULATION: "PERCENTILE_FOR_EMPTY_POPULATION",
  MIXED_LATENCY_POPULATIONS: "MIXED_LATENCY_POPULATIONS",
  MALFORMED_PERCENTILE_ORDERING: "MALFORMED_PERCENTILE_ORDERING",
  MAX_CONCURRENCY_ABOVE_LIMIT: "MAX_CONCURRENCY_ABOVE_LIMIT",
});

// ─── Helpers ──────────────────────────────────────────────────────────────

function isNonNegFiniteNumber(v) {
  return typeof v === "number" && Number.isFinite(v) && v >= 0;
}

function isNonNegInteger(v) {
  return typeof v === "number" && Number.isInteger(v) && v >= 0;
}

function makeViolation(code, message, detail = {}) {
  const v = { code, message };
  // Only attach attribution fields when their types are safe (mirrors
  // operation-accounting.js violation() — never trust record-controlled
  // values to be schema-safe).
  if (typeof detail.attemptId === "string") v.attemptId = detail.attemptId;
  if (typeof detail.logicalOperationId === "string") v.logicalOperationId = detail.logicalOperationId;
  if (typeof detail.attemptNumber === "number" && Number.isFinite(detail.attemptNumber)) v.attemptNumber = detail.attemptNumber;
  if (typeof detail.phase === "string") v.phase = detail.phase;
  if (typeof detail.field === "string") v.field = detail.field;
  if (typeof detail.population === "string") v.population = detail.population;
  return v;
}

// ─── Counter-block validators ─────────────────────────────────────────────
// Each block (logical, attempts) is checked for the 4 numeric-shape
// violations: negative, fractional, missing, plus block-specific invariants.

const REQUIRED_LOGICAL_FIELDS = Object.freeze([
  "total", "started", "completed", "inFlight", "succeeded", "failed",
]);

const REQUIRED_ATTEMPTS_FIELDS = Object.freeze([
  "total", "started", "completed", "inFlight",
  "transportFailed", "responseReceived",
  "expectedStatus", "unexpectedStatus",
  "assertionPassed", "assertionFailed", "assertionNotRun",
]);

function validateLogicalBlock(logical) {
  const v = [];
  if (!logical || typeof logical !== "object") {
    v.push(makeViolation(REPORT_VIOLATION_CODES.MISSING_COUNTER, "logical block must be an object", { field: "logical" }));
    return v;
  }
  for (const f of REQUIRED_LOGICAL_FIELDS) {
    const val = logical[f];
    if (typeof val !== "number" || !Number.isFinite(val)) {
      v.push(makeViolation(REPORT_VIOLATION_CODES.MISSING_COUNTER, `logical.${f} must be a finite number`, { field: `logical.${f}` }));
      continue;
    }
    if (val < 0) {
      v.push(makeViolation(REPORT_VIOLATION_CODES.NEGATIVE_COUNTER, `logical.${f} must be non-negative, got ${val}`, { field: `logical.${f}` }));
    }
    if (!Number.isInteger(val)) {
      v.push(makeViolation(REPORT_VIOLATION_CODES.FRACTIONAL_COUNTER, `logical.${f} must be an integer, got ${val}`, { field: `logical.${f}` }));
    }
  }
  if (logical.completed > logical.started) {
    v.push(makeViolation(REPORT_VIOLATION_CODES.COMPLETED_GT_STARTED, `logical.completed (${logical.completed}) > logical.started (${logical.started})`, { field: "logical" }));
  }
  if (logical.succeeded + logical.failed > logical.total) {
    // succeeded + failed can be < total (in-flight logical ops with no
    // terminal outcome yet) but never > total. Reported under
    // RESPONSE_TOTALS_MISMATCH-equivalent for logical scope; spec bullet
    // "response totals that do not reconcile" covers the attempts block; the
    // logical equivalent uses MISSING/unknown where appropriate. This check
    // uses UNKNOWN_CLASSIFICATION as the closest fit per spec intent
    // (a logical op that is neither succeeded nor failed but is also not
    // in-flight is unclassified).
    const inFlight = logical.inFlight || 0;
    if (logical.succeeded + logical.failed + inFlight !== logical.total) {
      v.push(makeViolation(REPORT_VIOLATION_CODES.UNKNOWN_CLASSIFICATION,
        `logical total=${logical.total} not reconciled by succeeded+failed+inFlight (${logical.succeeded}+${logical.failed}+${inFlight})`,
        { field: "logical" }));
    }
  }
  return v;
}

function validateAttemptsBlock(attempts) {
  const v = [];
  if (!attempts || typeof attempts !== "object") {
    v.push(makeViolation(REPORT_VIOLATION_CODES.MISSING_COUNTER, "attempts block must be an object", { field: "attempts" }));
    return v;
  }
  for (const f of REQUIRED_ATTEMPTS_FIELDS) {
    const val = attempts[f];
    if (typeof val !== "number" || !Number.isFinite(val)) {
      v.push(makeViolation(REPORT_VIOLATION_CODES.MISSING_COUNTER, `attempts.${f} must be a finite number`, { field: `attempts.${f}` }));
      continue;
    }
    if (val < 0) {
      v.push(makeViolation(REPORT_VIOLATION_CODES.NEGATIVE_COUNTER, `attempts.${f} must be non-negative, got ${val}`, { field: `attempts.${f}` }));
    }
    if (!Number.isInteger(val)) {
      v.push(makeViolation(REPORT_VIOLATION_CODES.FRACTIONAL_COUNTER, `attempts.${f} must be an integer, got ${val}`, { field: `attempts.${f}` }));
    }
  }
  // Reconciliation invariants (spec: "response totals that do not reconcile",
  // "assertion totals that do not reconcile").
  const responseReconciles =
    attempts.responseReceived === attempts.expectedStatus + attempts.unexpectedStatus;
  if (!responseReconciles) {
    v.push(makeViolation(REPORT_VIOLATION_CODES.RESPONSE_TOTALS_MISMATCH,
      `attempts.responseReceived (${attempts.responseReceived}) !== expectedStatus (${attempts.expectedStatus}) + unexpectedStatus (${attempts.unexpectedStatus})`,
      { field: "attempts" }));
  }
  const assertionReconciles =
    attempts.total === attempts.assertionPassed + attempts.assertionFailed + attempts.assertionNotRun;
  if (!assertionReconciles) {
    v.push(makeViolation(REPORT_VIOLATION_CODES.ASSERTION_TOTALS_MISMATCH,
      `attempts.total (${attempts.total}) !== assertionPassed (${attempts.assertionPassed}) + assertionFailed (${attempts.assertionFailed}) + assertionNotRun (${attempts.assertionNotRun})`,
      { field: "attempts" }));
  }
  // responseReceived + transportFailed should equal total (every attempt
  // either got a response or had a transport failure). Caught under
  // UNKNOWN_CLASSIFICATION (an attempt that is neither is unclassified).
  if (attempts.responseReceived + attempts.transportFailed !== attempts.total) {
    v.push(makeViolation(REPORT_VIOLATION_CODES.UNKNOWN_CLASSIFICATION,
      `attempts.total (${attempts.total}) !== responseReceived (${attempts.responseReceived}) + transportFailed (${attempts.transportFailed})`,
      { field: "attempts" }));
  }
  if (attempts.completed > attempts.started) {
    v.push(makeViolation(REPORT_VIOLATION_CODES.COMPLETED_GT_STARTED,
      `attempts.completed (${attempts.completed}) > attempts.started (${attempts.started})`,
      { field: "attempts" }));
  }
  return v;
}

// ─── logicalOperations[] / attemptsById validator ─────────────────────────

function validateLogicalOperationsList(logicalOperations) {
  const v = [];
  if (!Array.isArray(logicalOperations)) {
    v.push(makeViolation(REPORT_VIOLATION_CODES.MISSING_COUNTER, "logicalOperations must be an array", { field: "logicalOperations" }));
    return v;
  }
  for (const op of logicalOperations) {
    if (!op || typeof op !== "object") continue;
    if (op.outcome === "succeeded") {
      if (!op.finalAttemptId) {
        v.push(makeViolation(REPORT_VIOLATION_CODES.LOGICAL_SUCCESS_WITHOUT_FINAL,
          `logicalOperationId=${op.logicalOperationId} outcome=succeeded but finalAttemptId is null`,
          { logicalOperationId: op.logicalOperationId }));
      }
    }
    if (op.outcome === "failed") {
      // The failure reason is carried on the final attempt's error field,
      // surfaced via attemptsById. We do not have it inline here; the
      // attemptsById pass cross-checks this. Mark for the second pass by
      // recording an attribution-only violation IF the final attempt exists
      // and lacks an error. Done in validateAttemptsById.
    }
  }
  return v;
}

function validateAttemptsById(attemptsById, logicalOperations) {
  const v = [];
  if (!attemptsById || typeof attemptsById !== "object" || Array.isArray(attemptsById)) {
    v.push(makeViolation(REPORT_VIOLATION_CODES.MISSING_COUNTER, "attemptsById must be an object", { field: "attemptsById" }));
    return v;
  }

  const seenIds = new Set();
  const byLogical = new Map(); // logicalOperationId → [{attemptNumber, ...}]

  for (const [attemptId, record] of Object.entries(attemptsById)) {
    if (seenIds.has(attemptId)) {
      // Object.entries already dedupes by key, but if a prototype-injected
      // twin appeared (shouldn't, since buildOperationReport uses
      // Object.create(null)), surface it.
      v.push(makeViolation(REPORT_VIOLATION_CODES.DUPLICATE_ATTEMPT_ID,
        `duplicate attemptId=${attemptId}`,
        { attemptId }));
      continue;
    }
    seenIds.add(attemptId);

    if (!record || typeof record !== "object") continue;

    if (typeof record.logicalOperationId !== "string" || record.logicalOperationId.length === 0) {
      v.push(makeViolation(REPORT_VIOLATION_CODES.ATTEMPT_WITHOUT_LOGICAL_ID,
        `attemptId=${attemptId} has no logicalOperationId`,
        { attemptId }));
    } else {
      if (!byLogical.has(record.logicalOperationId)) byLogical.set(record.logicalOperationId, []);
      byLogical.get(record.logicalOperationId).push(record);
    }

    // NONCONTIGUOUS_ATTEMPT_NUMBERS — handled per-logical below.
  }

  // Per-logical contiguity check: attemptNumbers must form 1..N.
  for (const [logicalOperationId, recs] of byLogical.entries()) {
    const numbers = recs
      .map((r) => r.attemptNumber)
      .filter((n) => typeof n === "number" && Number.isFinite(n))
      .sort((a, b) => a - b);
    for (let i = 0; i < numbers.length; i++) {
      if (numbers[i] !== i + 1) {
        v.push(makeViolation(REPORT_VIOLATION_CODES.NONCONTIGUOUS_ATTEMPT_NUMBERS,
          `logicalOperationId=${logicalOperationId} attemptNumbers=${JSON.stringify(numbers)} must be contiguous from 1`,
          { logicalOperationId }));
        break;
      }
    }
  }

  // LOGICAL_FAILURE_WITHOUT_REASON: for each logical op with outcome=failed,
  // the final attempt must carry a non-null failure reason. The reason can
  // live in EITHER `error` (transport failures) OR `assertionError`
  // (assertion failures). A failed logical op with neither is a defect —
  // the consumer cannot diagnose why the operation failed.
  if (Array.isArray(logicalOperations)) {
    for (const op of logicalOperations) {
      if (op && op.outcome === "failed" && op.finalAttemptId) {
        const finalRec = attemptsById[op.finalAttemptId];
        if (finalRec) {
          const hasTransportReason = finalRec.error !== null && finalRec.error !== undefined;
          const hasAssertionReason = finalRec.assertionError !== null && finalRec.assertionError !== undefined;
          if (!hasTransportReason && !hasAssertionReason) {
            v.push(makeViolation(REPORT_VIOLATION_CODES.LOGICAL_FAILURE_WITHOUT_REASON,
              `logicalOperationId=${op.logicalOperationId} outcome=failed but final attempt ${op.finalAttemptId} has no error or assertionError`,
              { logicalOperationId: op.logicalOperationId, attemptId: op.finalAttemptId }));
          }
        }
      }
    }
  }

  return v;
}

// ─── Latency-population cross-check ───────────────────────────────────────
// Spec section 6.5 "Latency populations" + "Cross-check tests". The validator
// confirms (a) every named population has a valid shape, (b) empty populations
// are null-filled not zero-filled, (c) percentile ordering is min ≤ p50 ≤
// p90 ≤ p95 ≤ p99 ≤ max, (d) per-population count reconciles with the
// attempt counters.

const REQUIRED_LATENCY_FIELDS = Object.freeze([
  "count", "min", "max", "mean", "p50", "p90", "p95", "p99",
]);

function validateLatencyMap(latency, attempts) {
  const v = [];
  if (!latency || typeof latency !== "object") return v; // optional

  // Unknown population names? Spec enumerates exactly 9.
  for (const name of Object.keys(latency)) {
    if (!POPULATION_NAMES.includes(name)) {
      v.push(makeViolation(REPORT_VIOLATION_CODES.MIXED_LATENCY_POPULATIONS,
        `unknown latency population name=${name}`,
        { population: name }));
    }
  }

  // Per spec line 530: keep these populations separate. The cross-check tests
  // cover "mixed populations" as a structural invariant: a record that is
  // counted in transport_success must not also appear in transport_failed's
  // sample set. That is a property of computeLatencyPopulations, not of the
  // map shape; the structural check here is the count reconciliation.

  // expected_status + unexpected_status should equal response_received count.
  // Spec bullet: "latency sample count mismatches" — populations derived from
  // the same record set must have reconciling counts.
  const expCount = latency.expected_status?.count;
  const unexpCount = latency.unexpected_status?.count;
  const respCount = latency.response_received?.count;
  if (typeof expCount === "number" && typeof unexpCount === "number" && typeof respCount === "number") {
    if (expCount + unexpCount !== respCount) {
      v.push(makeViolation(REPORT_VIOLATION_CODES.LATENCY_COUNT_MISMATCH,
        `expected_status.count (${expCount}) + unexpected_status.count (${unexpCount}) !== response_received.count (${respCount})`,
        { population: "response_received" }));
    }
  }

  // Per-population shape + ordering.
  for (const name of POPULATION_NAMES) {
    const pop = latency[name];
    if (!pop || typeof pop !== "object") {
      v.push(makeViolation(REPORT_VIOLATION_CODES.MISSING_COUNTER,
        `latency.${name} must be an object`,
        { population: name }));
      continue;
    }
    for (const f of REQUIRED_LATENCY_FIELDS) {
      if (!(f in pop)) {
        v.push(makeViolation(REPORT_VIOLATION_CODES.MISSING_COUNTER,
          `latency.${name}.${f} missing`,
          { population: name, field: f }));
      }
    }
    const count = pop.count;
    if (typeof count !== "number" || !Number.isInteger(count) || count < 0) {
      v.push(makeViolation(REPORT_VIOLATION_CODES.MISSING_COUNTER,
        `latency.${name}.count must be a non-negative integer`,
        { population: name }));
      continue;
    }

    if (count === 0) {
      // PERCENTILE_FOR_EMPTY_POPULATION: empty populations must use the
      // explicit null-filled shape (spec line 557).
      for (const f of ["min", "max", "mean", "p50", "p90", "p95", "p99"]) {
        if (pop[f] !== null) {
          v.push(makeViolation(REPORT_VIOLATION_CODES.PERCENTILE_FOR_EMPTY_POPULATION,
            `latency.${name}.${f} must be null for empty population, got ${pop[f]}`,
            { population: name, field: f }));
        }
      }
    } else {
      // MALFORMED_PERCENTILE_ORDERING: min ≤ p50 ≤ p90 ≤ p95 ≤ p99 ≤ max.
      // mean is unrestricted in position (skew can push it above p99).
      const order = ["min", "p50", "p90", "p95", "p99", "max"];
      let prev = null;
      let prevName = null;
      for (const f of order) {
        const val = pop[f];
        if (typeof val !== "number" || !Number.isFinite(val)) {
          v.push(makeViolation(REPORT_VIOLATION_CODES.MALFORMED_PERCENTILE_ORDERING,
            `latency.${name}.${f} must be a finite number for non-empty population, got ${val}`,
            { population: name, field: f }));
          break;
        }
        if (prev !== null && val < prev) {
          v.push(makeViolation(REPORT_VIOLATION_CODES.MALFORMED_PERCENTILE_ORDERING,
            `latency.${name}.${f} (${val}) < ${prevName} (${prev})`,
            { population: name, field: f }));
          break;
        }
        prev = val;
        prevName = f;
      }
    }
  }

  return v;
}

// ─── Cross-counter reconciliation (latency ↔ attempts) ────────────────────

function crossCheckLatencyCounters(latency, attempts) {
  const v = [];
  if (!latency || !attempts) return v;

  // all_completed_attempts.count should equal attempts.total
  const aca = latency.all_completed_attempts?.count;
  if (typeof aca === "number" && typeof attempts.total === "number" && aca !== attempts.total) {
    v.push(makeViolation(REPORT_VIOLATION_CODES.LATENCY_COUNT_MISMATCH,
      `all_completed_attempts.count (${aca}) !== attempts.total (${attempts.total})`,
      { population: "all_completed_attempts" }));
  }

  const checks = [
    ["transport_success", "transportFailed", "completed"], // tsucc count = total - transportFailed
    ["expected_status", "expectedStatus"],
    ["unexpected_status", "unexpectedStatus"],
    ["assertion_passed", "assertionPassed"],
    ["assertion_failed", "assertionFailed"],
  ];
  // transport_success count = attempts.total - attempts.transportFailed
  // (every completed attempt is a transport_success; failures are not)
  const tsucc = latency.transport_success?.count;
  if (typeof tsucc === "number"
      && typeof attempts.total === "number"
      && typeof attempts.transportFailed === "number"
      && tsucc !== attempts.total - attempts.transportFailed) {
    v.push(makeViolation(REPORT_VIOLATION_CODES.LATENCY_COUNT_MISMATCH,
      `transport_success.count (${tsucc}) !== attempts.total - attempts.transportFailed (${attempts.total} - ${attempts.transportFailed})`,
      { population: "transport_success" }));
  }
  const expectedPop = latency.expected_status?.count;
  if (typeof expectedPop === "number" && typeof attempts.expectedStatus === "number"
      && expectedPop !== attempts.expectedStatus) {
    v.push(makeViolation(REPORT_VIOLATION_CODES.LATENCY_COUNT_MISMATCH,
      `expected_status.count (${expectedPop}) !== attempts.expectedStatus (${attempts.expectedStatus})`,
      { population: "expected_status" }));
  }
  const unexpectedPop = latency.unexpected_status?.count;
  if (typeof unexpectedPop === "number" && typeof attempts.unexpectedStatus === "number"
      && unexpectedPop !== attempts.unexpectedStatus) {
    v.push(makeViolation(REPORT_VIOLATION_CODES.LATENCY_COUNT_MISMATCH,
      `unexpected_status.count (${unexpectedPop}) !== attempts.unexpectedStatus (${attempts.unexpectedStatus})`,
      { population: "unexpected_status" }));
  }
  const ap = latency.assertion_passed?.count;
  if (typeof ap === "number" && typeof attempts.assertionPassed === "number"
      && ap !== attempts.assertionPassed) {
    v.push(makeViolation(REPORT_VIOLATION_CODES.LATENCY_COUNT_MISMATCH,
      `assertion_passed.count (${ap}) !== attempts.assertionPassed (${attempts.assertionPassed})`,
      { population: "assertion_passed" }));
  }
  const af = latency.assertion_failed?.count;
  if (typeof af === "number" && typeof attempts.assertionFailed === "number"
      && af !== attempts.assertionFailed) {
    v.push(makeViolation(REPORT_VIOLATION_CODES.LATENCY_COUNT_MISMATCH,
      `assertion_failed.count (${af}) !== attempts.assertionFailed (${attempts.assertionFailed})`,
      { population: "assertion_failed" }));
  }
  // logical_success.count + logical_failure.count should equal logical.total
  // (every logical op ends in exactly one terminal final attempt). Use the
  // logical block via attempts if present; skip otherwise.
  return v;
}

// ─── Sort + dedup (mirrors operation-accounting.js) ───────────────────────

function compareViolations(a, b) {
  const phaseA = a.phase || "";
  const phaseB = b.phase || "";
  if (phaseA !== phaseB) return phaseA < phaseB ? -1 : 1;
  const loA = a.logicalOperationId || "";
  const loB = b.logicalOperationId || "";
  if (loA !== loB) return loA < loB ? -1 : 1;
  const anA = a.attemptNumber ?? -1;
  const anB = b.attemptNumber ?? -1;
  if (anA !== anB) return anA - anB;
  const aiA = a.attemptId || "";
  const aiB = a.attemptId || "";
  if (aiA !== aiB) return aiA < aiB ? -1 : 1;
  if (a.code !== b.code) return a.code < b.code ? -1 : 1;
  return 0;
}

function dedupViolations(violations) {
  const seen = new Set();
  const out = [];
  for (const vlt of violations) {
    const key = `${vlt.phase || ""}|${vlt.logicalOperationId || ""}|${vlt.attemptNumber ?? ""}|${vlt.attemptId || ""}|${vlt.code}|${vlt.field || ""}|${vlt.population || ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(vlt);
  }
  return out;
}

// ─── Public API ───────────────────────────────────────────────────────────

/**
 * Validate a completed burst report (operation-accounting.js output shape).
 * Optionally cross-check against a latency map (latency-populations.js output)
 * and a configured-concurrency ceiling.
 *
 * @param {object} report   { logical, attempts, logicalOperations, attemptsById, violations }
 * @param {object} [opts]   { latency, maxConcurrency }
 * @returns {object} { ok, violations } — ok is true iff violations is empty.
 * @throws {Error} if report is not a non-null object (programming error)
 */
export function validateBurstReport(report, opts = {}) {
  if (!report || typeof report !== "object" || Array.isArray(report)) {
    throw Object.assign(
      new Error("validateBurstReport: report must be a non-null object"),
      { code: "INVALID_VALIDATOR_ARG" }
    );
  }

  const violations = [];

  // If the upstream reducer already found violations, they take precedence —
  // a report with reducer violations has zero/empty aggregates by contract,
  // so cross-checks against zero values would be noise. Surface the upstream
  // violations and skip downstream checks.
  if (Array.isArray(report.violations) && report.violations.length > 0) {
    return { ok: false, violations: dedupViolations([...report.violations].sort(compareViolations)) };
  }

  violations.push(...validateLogicalBlock(report.logical));
  violations.push(...validateAttemptsBlock(report.attempts));
  violations.push(...validateLogicalOperationsList(report.logicalOperations));
  violations.push(...validateAttemptsById(report.attemptsById, report.logicalOperations));

  // FINAL_IN_FLIGHT: no attempt may be in-flight in a completed report.
  // The reducer always sets inFlight=0, but if a hand-built report claims
  // otherwise, that is the spec's "final in-flight work" violation.
  const attemptsInFlight = report.attempts?.inFlight;
  if (typeof attemptsInFlight === "number" && attemptsInFlight > 0) {
    violations.push(makeViolation(REPORT_VIOLATION_CODES.FINAL_IN_FLIGHT,
      `attempts.inFlight=${attemptsInFlight} (completed report must have zero in-flight)`,
      { field: "attempts.inFlight" }));
  }
  const logicalInFlight = report.logical?.inFlight;
  if (typeof logicalInFlight === "number" && logicalInFlight > 0) {
    violations.push(makeViolation(REPORT_VIOLATION_CODES.FINAL_IN_FLIGHT,
      `logical.inFlight=${logicalInFlight} (completed report must have zero in-flight)`,
      { field: "logical.inFlight" }));
  }

  // MAX_CONCURRENCY_ABOVE_LIMIT: optional configured ceiling.
  const maxConcurrency = opts.maxConcurrency;
  if (typeof maxConcurrency === "number" && Number.isFinite(maxConcurrency) && maxConcurrency > 0) {
    const observed = report.maxInFlight ?? report.max_in_flight;
    if (typeof observed === "number" && Number.isFinite(observed) && observed > maxConcurrency) {
      violations.push(makeViolation(REPORT_VIOLATION_CODES.MAX_CONCURRENCY_ABOVE_LIMIT,
        `maxInFlight=${observed} > configured maxConcurrency=${maxConcurrency}`,
        { field: "maxInFlight" }));
    }
  }

  // Latency cross-check (optional).
  if (opts.latency && typeof opts.latency === "object") {
    violations.push(...validateLatencyMap(opts.latency, report.attempts));
    violations.push(...crossCheckLatencyCounters(opts.latency, report.attempts));
    // logical_success / logical_failure reconcile against logical block.
    if (report.logical) {
      const lsucc = opts.latency.logical_success?.count;
      const lfail = opts.latency.logical_failure?.count;
      if (typeof lsucc === "number" && typeof lfail === "number") {
        if (lsucc + lfail !== (report.logical.total || 0)) {
          violations.push(makeViolation(REPORT_VIOLATION_CODES.LATENCY_COUNT_MISMATCH,
            `logical_success.count (${lsucc}) + logical_failure.count (${lfail}) !== logical.total (${report.logical.total || 0})`,
            { population: "logical_success" }));
        }
        if (lsucc !== (report.logical.succeeded || 0)) {
          violations.push(makeViolation(REPORT_VIOLATION_CODES.LATENCY_COUNT_MISMATCH,
            `logical_success.count (${lsucc}) !== logical.succeeded (${report.logical.succeeded || 0})`,
            { population: "logical_success" }));
        }
        if (lfail !== (report.logical.failed || 0)) {
          violations.push(makeViolation(REPORT_VIOLATION_CODES.LATENCY_COUNT_MISMATCH,
            `logical_failure.count (${lfail}) !== logical.failed (${report.logical.failed || 0})`,
            { population: "logical_failure" }));
        }
      }
    }
  }

  const sorted = dedupViolations(violations.sort(compareViolations));
  return { ok: sorted.length === 0, violations: sorted };
}
