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
  // Reconciliation invariant (spec bullet: "unclassified results"). Every
  // logical operation must be accounted for: succeeded + failed + inFlight
  // must equal total. The previous implementation gated this check on
  // `succeeded + failed > total`, which let under-classification
  // (e.g. total=2, succeeded=1, failed=0, inFlight=0 — one op disappeared)
  // pass silently. The equality is now checked unconditionally.
  const inFlight = logical.inFlight || 0;
  if (logical.succeeded + logical.failed + inFlight !== logical.total) {
    v.push(makeViolation(REPORT_VIOLATION_CODES.UNKNOWN_CLASSIFICATION,
      `logical total=${logical.total} not reconciled by succeeded+failed+inFlight (${logical.succeeded}+${logical.failed}+${inFlight})`,
      { field: "logical" }));
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
    // outcome/terminal-classification sanity (the deeper finalAttemptId
    // resolution against attemptsById happens in validateFinalAttemptResolution,
    // which needs both structures in scope).
    if (op.outcome !== "succeeded" && op.outcome !== "failed" && op.outcome !== null && op.outcome !== undefined) {
      v.push(makeViolation(REPORT_VIOLATION_CODES.UNKNOWN_CLASSIFICATION,
        `logicalOperationId=${op.logicalOperationId} has unrecognized outcome=${op.outcome}`,
        { logicalOperationId: op.logicalOperationId }));
    }
  }
  return v;
}

// ─── Final-attempt resolution ─────────────────────────────────────────────
// For every terminal logical operation (outcome is succeeded or failed),
// resolve finalAttemptId against attemptsById and verify the reference is
// internally consistent. This is the cross-structural check the previous
// implementation deferred. Findings covered:
//
//   - LOGICAL_SUCCESS_WITHOUT_FINAL: outcome=succeeded but finalAttemptId
//     missing/null, OR the referenced record does not exist in attemptsById,
//     OR the referenced record belongs to a different logical operation,
//     OR the referenced record is not marked final,
//     OR the referenced record's outcome is not succeeded.
//   - LOGICAL_FAILURE_WITHOUT_REASON: outcome=failed and finalAttemptId
//     resolves to a record that carries neither `error` nor `assertionError`
//     (the same defect the previous narrower check caught, now strengthened
//     by first confirming the reference resolves). Also fires when
//     outcome=failed and finalAttemptId is null/missing, or the referenced
//     record does not exist, belongs to another op, is not final, or has a
//     non-failed outcome.

function validateFinalAttemptResolution(logicalOperations, attemptsById) {
  const v = [];
  if (!Array.isArray(logicalOperations)) return v;
  if (!attemptsById || typeof attemptsById !== "object") return v;

  for (const op of logicalOperations) {
    if (!op || typeof op !== "object") continue;
    if (op.outcome !== "succeeded" && op.outcome !== "failed") continue;

    const lid = typeof op.logicalOperationId === "string" ? op.logicalOperationId : null;
    const fid = op.finalAttemptId;

    // Missing/null finalAttemptId on a terminal op.
    if (fid === null || fid === undefined || (typeof fid === "string" && fid.length === 0)) {
      if (op.outcome === "succeeded") {
        v.push(makeViolation(REPORT_VIOLATION_CODES.LOGICAL_SUCCESS_WITHOUT_FINAL,
          `logicalOperationId=${lid} outcome=succeeded but finalAttemptId is null`,
          { logicalOperationId: lid }));
      } else {
        v.push(makeViolation(REPORT_VIOLATION_CODES.LOGICAL_FAILURE_WITHOUT_REASON,
          `logicalOperationId=${lid} outcome=failed but finalAttemptId is null (no final record to carry the reason)`,
          { logicalOperationId: lid }));
      }
      continue;
    }
    // Non-string finalAttemptId is itself a shape defect. Classify by the
    // logical outcome so the violation code matches what the consumer needs
    // to fix: succeeded ops missing their final → LOGICAL_SUCCESS_WITHOUT_FINAL;
    // failed ops missing their final → LOGICAL_FAILURE_WITHOUT_REASON.
    if (typeof fid !== "string") {
      const code = op.outcome === "failed"
        ? REPORT_VIOLATION_CODES.LOGICAL_FAILURE_WITHOUT_REASON
        : REPORT_VIOLATION_CODES.LOGICAL_SUCCESS_WITHOUT_FINAL;
      v.push(makeViolation(code,
        `logicalOperationId=${lid} finalAttemptId must be a string, got ${typeof fid}`,
        { logicalOperationId: lid }));
      continue;
    }

    const finalRec = attemptsById[fid];
    if (!finalRec || typeof finalRec !== "object") {
      // finalAttemptId references a record that does not exist.
      const code = op.outcome === "succeeded"
        ? REPORT_VIOLATION_CODES.LOGICAL_SUCCESS_WITHOUT_FINAL
        : REPORT_VIOLATION_CODES.LOGICAL_FAILURE_WITHOUT_REASON;
      v.push(makeViolation(code,
        `logicalOperationId=${lid} finalAttemptId=${fid} does not resolve in attemptsById`,
        { logicalOperationId: lid, attemptId: fid }));
      continue;
    }

    // The resolved record must belong to this logical operation.
    if (typeof finalRec.logicalOperationId === "string" && lid !== null && finalRec.logicalOperationId !== lid) {
      const code = op.outcome === "succeeded"
        ? REPORT_VIOLATION_CODES.LOGICAL_SUCCESS_WITHOUT_FINAL
        : REPORT_VIOLATION_CODES.LOGICAL_FAILURE_WITHOUT_REASON;
      v.push(makeViolation(code,
        `logicalOperationId=${lid} finalAttemptId=${fid} belongs to a different logicalOperationId=${finalRec.logicalOperationId}`,
        { logicalOperationId: lid, attemptId: fid }));
      continue;
    }

    // The resolved record must be marked final.
    if (finalRec.final !== true) {
      const code = op.outcome === "succeeded"
        ? REPORT_VIOLATION_CODES.LOGICAL_SUCCESS_WITHOUT_FINAL
        : REPORT_VIOLATION_CODES.LOGICAL_FAILURE_WITHOUT_REASON;
      v.push(makeViolation(code,
        `logicalOperationId=${lid} finalAttemptId=${fid} is not marked final=true`,
        { logicalOperationId: lid, attemptId: fid }));
      continue;
    }

    // Outcome compatibility: succeeded logical op → succeeded final record;
    // failed logical op → failed final record. A mismatch is an accounting
    // defect (the reducer would never produce this, but the validator is
    // prescriptive over shape, not reducer-clean input).
    if (op.outcome === "succeeded" && finalRec.outcome !== "succeeded") {
      v.push(makeViolation(REPORT_VIOLATION_CODES.LOGICAL_SUCCESS_WITHOUT_FINAL,
        `logicalOperationId=${lid} outcome=succeeded but finalAttemptId=${fid} outcome=${finalRec.outcome}`,
        { logicalOperationId: lid, attemptId: fid }));
      continue;
    }
    if (op.outcome === "failed" && finalRec.outcome !== "failed") {
      v.push(makeViolation(REPORT_VIOLATION_CODES.LOGICAL_FAILURE_WITHOUT_REASON,
        `logicalOperationId=${lid} outcome=failed but finalAttemptId=${fid} outcome=${finalRec.outcome}`,
        { logicalOperationId: lid, attemptId: fid }));
      continue;
    }

    // Failure-reason presence (failed ops only). The reason can live in
    // EITHER `error` (transport failures) OR `assertionError` (assertion
    // failures). A failed final attempt with neither is a defect.
    if (op.outcome === "failed") {
      const hasTransportReason = finalRec.error !== null && finalRec.error !== undefined;
      const hasAssertionReason = finalRec.assertionError !== null && finalRec.assertionError !== undefined;
      if (!hasTransportReason && !hasAssertionReason) {
        v.push(makeViolation(REPORT_VIOLATION_CODES.LOGICAL_FAILURE_WITHOUT_REASON,
          `logicalOperationId=${lid} outcome=failed but final attempt ${fid} has no error or assertionError`,
          { logicalOperationId: lid, attemptId: fid }));
      }
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

  const byLogical = new Map(); // logicalOperationId → [{attemptNumber, ...}]
  // attemptId → list of attemptsById keys that claim it. Under the reducer's
  // contract each key matches its record.attemptId exactly once, so any value
  // length > 1 indicates a duplicate identity defect.
  const attemptIdClaimants = Object.create(null);

  for (const [key, record] of Object.entries(attemptsById)) {
    if (!record || typeof record !== "object") continue;

    // Canonical identity check #1: each attemptsById key must equal the
    // record.attemptId it holds. The reducer always produces this invariant
    // (key === record.attemptId); a mismatch indicates a hand-built or
    // tampered report. Detected as DUPLICATE_ATTEMPT_ID because the canonical
    // identity is the record.attemptId — a key/record mismatch means the
    // key is not a reliable identity and the canonical identity is being
    // shared or shadowed.
    const canonicalId = typeof record.attemptId === "string" ? record.attemptId : null;
    if (canonicalId === null) {
      // record.attemptId missing or non-string — record shape defect, but
      // also an identity defect (no canonical claim). Surface under
      // ATTEMPT_WITHOUT_LOGICAL_ID's sibling: there is no ATTEMPT_WITHOUT_ID
      // code in the spec, so use DUPLICATE_ATTEMPT_ID with a clear message.
      v.push(makeViolation(REPORT_VIOLATION_CODES.DUPLICATE_ATTEMPT_ID,
        `attemptsById key=${key} holds a record with no valid attemptId (got ${typeof record.attemptId})`,
        { attemptId: key }));
    } else if (canonicalId !== key) {
      v.push(makeViolation(REPORT_VIOLATION_CODES.DUPLICATE_ATTEMPT_ID,
        `attemptsById key=${key} holds record.attemptId=${canonicalId} (key must match record.attemptId)`,
        { attemptId: canonicalId }));
    }

    // Track claimants of each canonical attemptId for the cross-key shared-
    // identity check below.
    if (canonicalId !== null) {
      if (!attemptIdClaimants[canonicalId]) attemptIdClaimants[canonicalId] = [];
      attemptIdClaimants[canonicalId].push(key);
    }

    if (typeof record.logicalOperationId !== "string" || record.logicalOperationId.length === 0) {
      v.push(makeViolation(REPORT_VIOLATION_CODES.ATTEMPT_WITHOUT_LOGICAL_ID,
        `attemptId=${canonicalId || key} has no logicalOperationId`,
        { attemptId: canonicalId || key }));
    } else {
      if (!byLogical.has(record.logicalOperationId)) byLogical.set(record.logicalOperationId, []);
      byLogical.get(record.logicalOperationId).push(record);
    }
  }

  // Canonical identity check #2: two records under different keys must not
  // share one record.attemptId. Object.entries dedupes literal keys, so the
  // only way this fires is two different keys holding records that both
  // claim the same canonical attemptId (a real identity collision the old
  // seenIds check could not detect).
  for (const [canonicalId, claimants] of Object.entries(attemptIdClaimants)) {
    if (claimants.length > 1) {
      v.push(makeViolation(REPORT_VIOLATION_CODES.DUPLICATE_ATTEMPT_ID,
        `record.attemptId=${canonicalId} is claimed by multiple attemptsById keys=${JSON.stringify(claimants)}`,
        { attemptId: canonicalId }));
    }
  }

  // Canonical identity check #3: logical-operation attempt references must
  // resolve consistently AND be unique within the op AND belong to the op.
  // For each attemptId listed in a logical op's attemptIds[]:
  //   - reject repeated references within the same op (DUPLICATE_ATTEMPT_ID)
  //   - require the referenced record to exist (DUPLICATE_ATTEMPT_ID)
  //   - require record.attemptId === refId (DUPLICATE_ATTEMPT_ID)
  //   - require record.logicalOperationId === op.logicalOperationId
  //     (DUPLICATE_ATTEMPT_ID — an attempt owned by another logical op is
  //     an identity theft, not just a misclassification)
  if (Array.isArray(logicalOperations)) {
    for (const op of logicalOperations) {
      if (!op || typeof op !== "object" || !Array.isArray(op.attemptIds)) continue;
      const seenInThisOp = new Set();
      for (const refId of op.attemptIds) {
        if (typeof refId !== "string") continue;
        // Per-op uniqueness: the same attemptId may not appear twice in one
        // logical operation's attemptIds[].
        if (seenInThisOp.has(refId)) {
          v.push(makeViolation(REPORT_VIOLATION_CODES.DUPLICATE_ATTEMPT_ID,
            `logicalOperationId=${op.logicalOperationId} lists attemptId=${refId} more than once in attemptIds[]`,
            { attemptId: refId, logicalOperationId: op.logicalOperationId }));
          // Don't re-check the duplicate's record fields — the duplicate
          // itself is the defect; we already reported the record's identity
          // on its first occurrence.
          continue;
        }
        seenInThisOp.add(refId);

        const rec = attemptsById[refId];
        if (!rec || typeof rec !== "object") {
          v.push(makeViolation(REPORT_VIOLATION_CODES.DUPLICATE_ATTEMPT_ID,
            `logicalOperationId=${op.logicalOperationId} references attemptId=${refId} not present in attemptsById`,
            { attemptId: refId, logicalOperationId: op.logicalOperationId }));
          continue;
        }
        if (typeof rec.attemptId === "string" && rec.attemptId !== refId) {
          v.push(makeViolation(REPORT_VIOLATION_CODES.DUPLICATE_ATTEMPT_ID,
            `logicalOperationId=${op.logicalOperationId} references attemptId=${refId} but the record claims attemptId=${rec.attemptId}`,
            { attemptId: refId, logicalOperationId: op.logicalOperationId }));
          // Don't also fire the cross-logical check on a record whose own
          // identity is already inconsistent — the message above is the
          // actionable defect.
          continue;
        }
        // Cross-logical ownership: the referenced record must belong to THIS
        // logical operation. An attempt owned by another op (whether final
        // or non-final) is identity theft — the op is claiming work it did
        // not do.
        if (typeof rec.logicalOperationId === "string"
            && typeof op.logicalOperationId === "string"
            && rec.logicalOperationId !== op.logicalOperationId) {
          v.push(makeViolation(REPORT_VIOLATION_CODES.DUPLICATE_ATTEMPT_ID,
            `logicalOperationId=${op.logicalOperationId} references attemptId=${refId} but the record belongs to logicalOperationId=${rec.logicalOperationId}`,
            { attemptId: refId, logicalOperationId: op.logicalOperationId }));
        }
      }
    }
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

  // LOGICAL_FAILURE_WITHOUT_REASON and full final-attempt resolution are
  // handled by validateFinalAttemptResolution (called by the entry point
  // with both logicalOperations and attemptsById in scope).

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
      // Non-empty population: percentile sequence must be a chain of finite
      // numbers in non-decreasing order (MALFORMED_PERCENTILE_ORDERING).
      // min ≤ p50 ≤ p90 ≤ p95 ≤ p99 ≤ max. mean is unrestricted in
      // position (skew can push it above p99) BUT must still be a finite
      // number — a null or NaN mean in a non-empty population is a
      // computing/reducer defect.
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
      // mean must be a finite number for non-empty populations. It can lie
      // outside the [min, max] sequence? No — for a finite sample of finite
      // values, the arithmetic mean is always within [min, max]. A mean
      // outside that range is a reducer/computation defect. The check below
      // verifies finiteness first (catches null/NaN), then range.
      const meanVal = pop.mean;
      const minVal = pop.min;
      const maxVal = pop.max;
      if (typeof meanVal !== "number" || !Number.isFinite(meanVal)) {
        v.push(makeViolation(REPORT_VIOLATION_CODES.MALFORMED_PERCENTILE_ORDERING,
          `latency.${name}.mean must be a finite number for non-empty population, got ${meanVal}`,
          { population: name, field: "mean" }));
      } else if (typeof minVal === "number" && typeof maxVal === "number"
                 && Number.isFinite(minVal) && Number.isFinite(maxVal)
                 && (meanVal < minVal || meanVal > maxVal)) {
        v.push(makeViolation(REPORT_VIOLATION_CODES.MALFORMED_PERCENTILE_ORDERING,
          `latency.${name}.mean (${meanVal}) must be within [min (${minVal}), max (${maxVal})] for non-empty population`,
          { population: name, field: "mean" }));
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
  const aiB = b.attemptId || "";
  if (aiA !== aiB) return aiA < aiB ? -1 : 1;
  if (a.code !== b.code) return a.code < b.code ? -1 : 1;
  return 0;
}

function dedupViolations(violations) {
  const seen = new Set();
  const out = [];
  for (const vlt of violations) {
    // Dedup key includes the message because multiple distinct defects can
    // share every structured field (e.g. two different DUPLICATE_ATTEMPT_ID
    // subcategories on the same attemptId: key-mismatch vs cross-key-shared
    // vs dangling-logical-ref). Without the message in the key, the second
    // distinct defect would be silently dropped.
    const key = `${vlt.phase || ""}|${vlt.logicalOperationId || ""}|${vlt.attemptNumber ?? ""}|${vlt.attemptId || ""}|${vlt.code}|${vlt.field || ""}|${vlt.population || ""}|${vlt.message || ""}`;
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
  violations.push(...validateFinalAttemptResolution(report.logicalOperations, report.attemptsById));

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
