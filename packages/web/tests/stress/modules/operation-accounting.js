// packages/web/tests/stress/modules/operation-accounting.js
//
// Pure reducer from settled attempt records to the canonical P2 accounting
// model (logical operations vs physical attempts). Independent of execution,
// scheduling, retries, and route selection. No production imports; composes
// only on the engine's exported validateOutcome for engine-result consistency.
//
// Pipeline:
//   engine execution → createAttemptRecord() → flat normalized records
//                    → buildOperationReport() → immutable deterministic report
//
// C2 records are settled by construction (no live in-flight concept). C3
// (concurrency) and C4 (retry) feed the same record shape; the reducer does
// not own their behavior.
//
// Transactional contract: buildOperationReport produces authoritative
// aggregates ONLY when the entire batch is valid. Any violation across any
// phase → zero/empty aggregates + the exact sorted deduplicated violations.
// Callers never need to catch exceptions to collect ordinary findings.

import { validateOutcome } from "../burst-runner.js";

// ─── Classification enums ─────────────────────────────────────────────────

const TRANSPORTS = new Set(["completed", "failed"]);
const HTTP_CLASSES = new Set(["expected", "unexpected", "not_received"]);
const ASSERTION_CLASSES = new Set(["passed", "failed", "not_run"]);
const OUTCOMES = new Set(["succeeded", "failed"]);

// Identity length caps so attemptId-as-object-key cannot become a memory or
// prototype-pollution vector. Identity fields must be non-empty strings.
const MAX_ID_LENGTH = 200;

// ─── Zero-counter constants (returned on any violation) ───────────────────

const ZERO_LOGICAL = Object.freeze({
  total: 0, started: 0, completed: 0, inFlight: 0, succeeded: 0, failed: 0,
});

const ZERO_ATTEMPTS = Object.freeze({
  total: 0, started: 0, completed: 0, inFlight: 0,
  transportFailed: 0, responseReceived: 0,
  expectedStatus: 0, unexpectedStatus: 0,
  assertionPassed: 0, assertionFailed: 0, assertionNotRun: 0,
});

// Fresh empty-report factory. Each call returns a new object with fresh
// empty arrays/objects so cross-call mutation of one report's violations or
// logicalOperations cannot corrupt a later empty reduction. The zero-counter
// objects themselves are frozen and safe to share.
function emptyReport() {
  return {
    logical: ZERO_LOGICAL,
    attempts: ZERO_ATTEMPTS,
    logicalOperations: [],
    attemptsById: Object.create(null),
    violations: [],
  };
}

// ─── Violation helper ─────────────────────────────────────────────────────

function violation(code, message, detail = {}) {
  const v = { code, message };
  if (detail.attemptId !== undefined) v.attemptId = detail.attemptId;
  if (detail.logicalOperationId !== undefined) v.logicalOperationId = detail.logicalOperationId;
  if (detail.attemptNumber !== undefined) v.attemptNumber = detail.attemptNumber;
  if (detail.phase !== undefined) v.phase = detail.phase;
  return v;
}

// ─── Outcome derivation ───────────────────────────────────────────────────

/**
 * Derive the attempt outcome from its classifications. Stable 3-rule order:
 *   transport !== "completed"      → "failed"
 *   http !== "expected"            → "failed"
 *   assertion === "failed"         → "failed"
 *   otherwise                      → "succeeded" (covers assertion "not_run"
 *                                    for status-only contracts where a
 *                                    received expected status IS the success)
 *
 * @param {object} record normalized attempt record
 * @returns {"succeeded"|"failed"}
 */
export function deriveAttemptOutcome(record) {
  if (!record || typeof record !== "object") return "failed";
  if (record.transport !== "completed") return "failed";
  if (record.http !== "expected") return "failed";
  if (record.assertion === "failed") return "failed";
  return "succeeded";
}

// ─── createAttemptRecord — narrow adapter from engine result ──────────────

/**
 * Build a normalized attempt record from an engine enriched result and P2
 * logical metadata. Copies ONLY declared fields, deep-copying the nested
 * body/error/assertionError so the record does not retain engine-owned
 * references that could be mutated later.
 *
 * @param {object} engineResult enriched result from runContractedOperation
 * @param {object} metadata
 * @param {string} metadata.logicalOperationId
 * @param {string} metadata.attemptId
 * @param {number} metadata.attemptNumber positive integer
 * @param {boolean} metadata.retryable
 * @param {boolean} metadata.final
 * @returns {object} normalized attempt record with computed `outcome`
 * @throws {Error} only on adapter-argument errors (missing/malformed
 *   metadata). Record-data defects are NOT thrown here — they surface as
 *   violations from buildOperationReport / validateAttemptRecord.
 */
export function createAttemptRecord(engineResult, metadata) {
  if (!engineResult || typeof engineResult !== "object") {
    throw Object.assign(new Error("createAttemptRecord: engineResult must be an object"), { code: "INVALID_ADAPTER_ARGS" });
  }
  if (!metadata || typeof metadata !== "object") {
    throw Object.assign(new Error("createAttemptRecord: metadata must be an object"), { code: "INVALID_ADAPTER_ARGS" });
  }
  for (const k of ["logicalOperationId", "attemptId"]) {
    if (typeof metadata[k] !== "string" || metadata[k].length === 0 || metadata[k].length > MAX_ID_LENGTH) {
      throw Object.assign(
        new Error(`createAttemptRecord: metadata.${k} must be a non-empty string ≤${MAX_ID_LENGTH} chars`),
        { code: "INVALID_ADAPTER_ARGS" }
      );
    }
  }
  if (!Number.isInteger(metadata.attemptNumber) || metadata.attemptNumber < 1) {
    throw Object.assign(
      new Error(`createAttemptRecord: metadata.attemptNumber must be a positive integer, got ${metadata.attemptNumber}`),
      { code: "INVALID_ADAPTER_ARGS" }
    );
  }
  if (typeof metadata.retryable !== "boolean") {
    throw Object.assign(new Error("createAttemptRecord: metadata.retryable must be boolean"), { code: "INVALID_ADAPTER_ARGS" });
  }
  if (typeof metadata.final !== "boolean") {
    throw Object.assign(new Error("createAttemptRecord: metadata.final must be boolean"), { code: "INVALID_ADAPTER_ARGS" });
  }

  const record = {
    logicalOperationId: metadata.logicalOperationId,
    attemptId: metadata.attemptId,
    attemptNumber: metadata.attemptNumber,
    kind: engineResult.kind ?? null,
    method: engineResult.method ?? null,
    transport: engineResult.transport,
    http: engineResult.http,
    assertion: engineResult.assertion,
    status: engineResult.status,
    body: engineResult.body !== undefined ? structuredClone(engineResult.body) : null,
    error: engineResult.error !== undefined && engineResult.error !== null ? structuredClone(engineResult.error) : null,
    assertionError: engineResult.assertionError !== undefined && engineResult.assertionError !== null
      ? structuredClone(engineResult.assertionError) : null,
    assertionNotRunReason: engineResult.assertionNotRunReason ?? null,
    durationMs: engineResult.durationMs,
    retryable: metadata.retryable,
    final: metadata.final,
  };
  record.outcome = deriveAttemptOutcome(record);
  return record;
}

// ─── validateAttemptRecord — Phase 1 + Phase 2 (per-record) ───────────────

/**
 * Validate a single normalized record's shape and engine-result consistency.
 * Returns an array of violations; NEVER throws for malformed record data
 * (only throws for non-object input, which is a programming error).
 *
 * Phase 1 — record shape: identity fields, classifications, durations,
 *   retryable/final booleans.
 * Phase 2 — engine-result consistency: reuse validateOutcome for the
 *   transport/status/body/error contract; semantic consistency between
 *   transport/http/assertion/assertionNotRunReason/assertionError; derived
 *   outcome matches deriveAttemptOutcome; NONFINAL_SUCCEEDED_ATTEMPT.
 *
 * @param {object} record
 * @returns {Array<{code, message, ...}>} violations (empty if valid)
 */
export function validateAttemptRecord(record) {
  // Per the agreed transactional contract: malformed record data produces
  // structured violations; only buildOperationReport's top-level non-array
  // argument throws. A null/primitive/array record therefore surfaces as a
  // Phase-1 violation rather than throwing.
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    return [violation(
      "INVALID_ATTEMPT_RECORD",
      "attempt record must be a non-null non-array object",
      { phase: "phase_1_record_shape" }
    )];
  }

  const v = [];
  const phase1 = "phase_1_record_shape";
  const phase2 = "phase_2_engine_consistency";

  // ── Phase 1: identity fields ──
  if (typeof record.logicalOperationId !== "string" || record.logicalOperationId.length === 0) {
    v.push(violation("MISSING_LOGICAL_OPERATION_ID", "logicalOperationId must be a non-empty string", { attemptId: record.attemptId, phase: phase1 }));
  } else if (record.logicalOperationId.length > MAX_ID_LENGTH) {
    v.push(violation("INVALID_LOGICAL_OPERATION_ID", `logicalOperationId length must be ≤${MAX_ID_LENGTH}`, { attemptId: record.attemptId, logicalOperationId: record.logicalOperationId, phase: phase1 }));
  }
  if (typeof record.attemptId !== "string" || record.attemptId.length === 0) {
    v.push(violation("MISSING_ATTEMPT_ID", "attemptId must be a non-empty string", { logicalOperationId: record.logicalOperationId, phase: phase1 }));
  } else if (record.attemptId.length > MAX_ID_LENGTH) {
    v.push(violation("INVALID_ATTEMPT_ID", `attemptId length must be ≤${MAX_ID_LENGTH}`, { attemptId: record.attemptId, logicalOperationId: record.logicalOperationId, phase: phase1 }));
  }
  if (!Number.isInteger(record.attemptNumber) || record.attemptNumber < 1) {
    v.push(violation("INVALID_ATTEMPT_NUMBER", `attemptNumber must be a positive integer, got ${JSON.stringify(record.attemptNumber)}`, { attemptId: record.attemptId, logicalOperationId: record.logicalOperationId, attemptNumber: record.attemptNumber, phase: phase1 }));
  }

  // ── Phase 1: classifications ──
  if (!TRANSPORTS.has(record.transport)) {
    v.push(violation("UNKNOWN_TRANSPORT", `transport must be one of ${[...TRANSPORTS].join("|")}, got ${JSON.stringify(record.transport)}`, { attemptId: record.attemptId, logicalOperationId: record.logicalOperationId, phase: phase1 }));
  }
  if (!HTTP_CLASSES.has(record.http)) {
    v.push(violation("UNKNOWN_HTTP", `http must be one of ${[...HTTP_CLASSES].join("|")}, got ${JSON.stringify(record.http)}`, { attemptId: record.attemptId, logicalOperationId: record.logicalOperationId, phase: phase1 }));
  }
  if (!ASSERTION_CLASSES.has(record.assertion)) {
    v.push(violation("UNKNOWN_ASSERTION", `assertion must be one of ${[...ASSERTION_CLASSES].join("|")}, got ${JSON.stringify(record.assertion)}`, { attemptId: record.attemptId, logicalOperationId: record.logicalOperationId, phase: phase1 }));
  }

  // ── Phase 1: durationMs ──
  if (typeof record.durationMs !== "number" || !Number.isFinite(record.durationMs) || record.durationMs < 0) {
    v.push(violation("INVALID_DURATION", `durationMs must be a non-negative finite number, got ${JSON.stringify(record.durationMs)}`, { attemptId: record.attemptId, logicalOperationId: record.logicalOperationId, phase: phase1 }));
  }

  // ── Phase 1: retryable/final booleans ──
  if (typeof record.retryable !== "boolean") {
    v.push(violation("INVALID_RETRYABLE", `retryable must be boolean, got ${typeof record.retryable}`, { attemptId: record.attemptId, logicalOperationId: record.logicalOperationId, phase: phase1 }));
  }
  if (typeof record.final !== "boolean") {
    v.push(violation("INVALID_FINAL", `final must be boolean, got ${typeof record.final}`, { attemptId: record.attemptId, logicalOperationId: record.logicalOperationId, phase: phase1 }));
  }

  // If Phase 1 found structural defects, Phase 2 consistency checks would
  // produce cascade noise (e.g. accessing record.transport when it's a
  // symbol). Skip Phase 2 for this record.
  if (v.length > 0) return v;

  // ── Phase 2: engine-result consistency via the engine's own validator ──
  try {
    validateOutcome({
      transport: record.transport,
      status: record.status,
      body: record.body,
      error: record.error,
    });
  } catch (err) {
    v.push(violation("INVALID_ENGINE_OUTCOME", `engine outcome validation failed: ${err.message}`, { attemptId: record.attemptId, logicalOperationId: record.logicalOperationId, phase: phase2 }));
    return v; // semantic consistency would cascade
  }

  // ── Phase 2: semantic consistency ──
  if (record.transport === "failed") {
    if (record.http !== "not_received") {
      v.push(violation("SEMANTIC_TRANSPORT_HTTP", `transport=failed requires http=not_received, got ${record.http}`, { attemptId: record.attemptId, logicalOperationId: record.logicalOperationId, phase: phase2 }));
    }
    if (record.assertion !== "not_run") {
      v.push(violation("SEMANTIC_TRANSPORT_ASSERTION", `transport=failed requires assertion=not_run, got ${record.assertion}`, { attemptId: record.attemptId, logicalOperationId: record.logicalOperationId, phase: phase2 }));
    }
    if (record.assertionNotRunReason !== "transport_failed") {
      v.push(violation("SEMANTIC_TRANSPORT_REASON", `transport=failed requires assertionNotRunReason=transport_failed, got ${JSON.stringify(record.assertionNotRunReason)}`, { attemptId: record.attemptId, logicalOperationId: record.logicalOperationId, phase: phase2 }));
    }
  }
  // Converse: a completed transport MUST have received an HTTP response
  // (expected or unexpected). transport=completed + http=not_received is
  // semantically impossible and would otherwise let a record slip into the
  // aggregates where responseReceived counts it but expected+unexpected do
  // not — producing inconsistent counters with no violation.
  if (record.transport === "completed" && record.http !== "expected" && record.http !== "unexpected") {
    v.push(violation("SEMANTIC_COMPLETED_HTTP", `transport=completed requires http=expected|unexpected, got ${JSON.stringify(record.http)}`, { attemptId: record.attemptId, logicalOperationId: record.logicalOperationId, phase: phase2 }));
  }
  if (record.assertion === "passed") {
    if (record.assertionError !== null && record.assertionError !== undefined) {
      v.push(violation("SEMANTIC_PASSED_ERROR", "assertion=passed requires assertionError=null", { attemptId: record.attemptId, logicalOperationId: record.logicalOperationId, phase: phase2 }));
    }
    if (record.assertionNotRunReason !== null && record.assertionNotRunReason !== undefined) {
      v.push(violation("SEMANTIC_PASSED_REASON", "assertion=passed requires assertionNotRunReason=null", { attemptId: record.attemptId, logicalOperationId: record.logicalOperationId, phase: phase2 }));
    }
  }
  if (record.assertion === "failed") {
    if (!record.assertionError || typeof record.assertionError.code !== "string" || record.assertionError.code.length === 0 ||
        typeof record.assertionError.message !== "string" || record.assertionError.message.length === 0) {
      v.push(violation("SEMANTIC_FAILED_ERROR", "assertion=failed requires assertionError with non-empty code and message", { attemptId: record.attemptId, logicalOperationId: record.logicalOperationId, phase: phase2 }));
    }
    if (record.assertionNotRunReason !== null && record.assertionNotRunReason !== undefined) {
      v.push(violation("SEMANTIC_FAILED_REASON", "assertion=failed requires assertionNotRunReason=null", { attemptId: record.attemptId, logicalOperationId: record.logicalOperationId, phase: phase2 }));
    }
  }
  if (record.assertion === "not_run") {
    if (record.assertionError !== null && record.assertionError !== undefined) {
      v.push(violation("SEMANTIC_NOT_RUN_ERROR", "assertion=not_run requires assertionError=null", { attemptId: record.attemptId, logicalOperationId: record.logicalOperationId, phase: phase2 }));
    }
    if (typeof record.assertionNotRunReason !== "string" || record.assertionNotRunReason.length === 0) {
      v.push(violation("SEMANTIC_NOT_RUN_REASON", "assertion=not_run requires a non-empty assertionNotRunReason", { attemptId: record.attemptId, logicalOperationId: record.logicalOperationId, phase: phase2 }));
    }
  }

  // ── Phase 2: derived outcome consistency ──
  const expectedOutcome = deriveAttemptOutcome(record);
  if (!OUTCOMES.has(record.outcome)) {
    v.push(violation("INVALID_OUTCOME", `outcome must be "succeeded"|"failed", got ${JSON.stringify(record.outcome)}`, { attemptId: record.attemptId, logicalOperationId: record.logicalOperationId, phase: phase2 }));
  } else if (record.outcome !== expectedOutcome) {
    v.push(violation("OUTCOME_MISMATCH", `outcome=${JSON.stringify(record.outcome)} but classifications imply ${expectedOutcome}`, { attemptId: record.attemptId, logicalOperationId: record.logicalOperationId, phase: phase2 }));
  }

  // ── Phase 2: NONFINAL_SUCCEEDED_ATTEMPT ──
  // A succeeded attempt that is not final would mean a later attempt
  // occurred after success — an accounting or policy defect.
  if (record.outcome === "succeeded" && record.final !== true) {
    v.push(violation("NONFINAL_SUCCEEDED_ATTEMPT", "outcome=succeeded requires final=true (a later attempt after success is a defect)", { attemptId: record.attemptId, logicalOperationId: record.logicalOperationId, attemptNumber: record.attemptNumber, phase: phase2 }));
  }

  return v;
}

// ─── Phase 3: global attempt identity ─────────────────────────────────────

function validateGlobalIdentity(records) {
  const v = [];
  const phase3 = "phase_3_global_identity";
  const seenIds = new Map();
  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    // A non-object record is already flagged by Phase 1; skip it here so
    // accessing r.attemptId cannot throw on null/primitives.
    if (!r || typeof r !== "object") continue;
    if (typeof r.attemptId !== "string" || r.attemptId.length === 0) continue; // Phase 1 already flagged
    if (seenIds.has(r.attemptId)) {
      v.push(violation("DUPLICATE_ATTEMPT_ID", `attemptId must be globally unique; duplicate at input index ${i}`, { attemptId: r.attemptId, logicalOperationId: r.logicalOperationId, phase: phase3 }));
    } else {
      seenIds.set(r.attemptId, i);
    }
  }
  return v;
}

// ─── Phase 4: per-logical-operation sequence ──────────────────────────────

function validateLogicalSequences(records, groupsWithRecordDefects) {
  const v = [];
  const phase4 = "phase_4_logical_sequence";

  // Group records by logicalOperationId. Skip ENTIRE groups that contain
  // ANY record-level defect (Phase 1 or Phase 2) — otherwise a defective
  // record's omission from sequencing would generate cascade findings
  // (e.g. NO_FINAL_ATTEMPT caused only by the missing defective record).
  // The suppression set is keyed by logicalOperationId so all siblings of
  // a defective record are also suppressed for sequence checks.
  const groups = new Map();
  for (const r of records) {
    // Non-object records are already flagged by Phase 1; skip them so
    // accessing r.logicalOperationId cannot throw on null/primitives.
    if (!r || typeof r !== "object") continue;
    if (typeof r.logicalOperationId !== "string" || r.logicalOperationId.length === 0) continue;
    if (groupsWithRecordDefects.has(r.logicalOperationId)) continue;
    if (!groups.has(r.logicalOperationId)) groups.set(r.logicalOperationId, []);
    groups.get(r.logicalOperationId).push(r);
  }

  for (const [logicalOperationId, group] of groups) {
    const sorted = [...group].sort((a, b) => a.attemptNumber - b.attemptNumber);

    // Duplicate attemptNumber within one logical op.
    const seenNumbers = new Set();
    for (const r of sorted) {
      if (!Number.isInteger(r.attemptNumber) || r.attemptNumber < 1) continue;
      if (seenNumbers.has(r.attemptNumber)) {
        v.push(violation("DUPLICATE_ATTEMPT_NUMBER", `duplicate attemptNumber ${r.attemptNumber} within logical operation`, { logicalOperationId, attemptId: r.attemptId, attemptNumber: r.attemptNumber, phase: phase4 }));
      } else {
        seenNumbers.add(r.attemptNumber);
      }
    }

    // Contiguity: 1, 2, 3, ...
    const numbers = [...seenNumbers].sort((a, b) => a - b);
    for (let i = 0; i < numbers.length; i++) {
      if (numbers[i] !== i + 1) {
        v.push(violation("NONCONTIGUOUS_ATTEMPT_NUMBERS", `attemptNumbers must be contiguous starting at 1; got ${JSON.stringify(numbers)} for logical operation`, { logicalOperationId, phase: phase4 }));
        break;
      }
    }

    // Exactly one final.
    const finals = sorted.filter((r) => r.final === true);
    if (finals.length === 0) {
      v.push(violation("NO_FINAL_ATTEMPT", "logical operation has no final attempt", { logicalOperationId, phase: phase4 }));
    } else if (finals.length > 1) {
      v.push(violation("MULTIPLE_FINAL_ATTEMPTS", `logical operation has ${finals.length} final attempts; expected exactly 1`, { logicalOperationId, phase: phase4 }));
    }

    // Final must have the highest attempt number.
    if (finals.length === 1 && numbers.length > 0) {
      const finalAttempt = finals[0];
      const maxNumber = numbers[numbers.length - 1];
      if (finalAttempt.attemptNumber !== maxNumber) {
        v.push(violation("FINAL_NOT_HIGHEST", `final attempt number ${finalAttempt.attemptNumber} is not the highest (${maxNumber})`, { logicalOperationId, attemptId: finalAttempt.attemptId, phase: phase4 }));
      }
    }

    // Final must be the last attempt (no attempt follows a final).
    if (finals.length === 1) {
      const finalIdx = sorted.findIndex((r) => r === finals[0]);
      for (let i = finalIdx + 1; i < sorted.length; i++) {
        v.push(violation("FINAL_NOT_LAST", `attempt ${sorted[i].attemptNumber} follows the final attempt ${sorted[finalIdx].attemptNumber}`, { logicalOperationId, attemptId: sorted[i].attemptId, attemptNumber: sorted[i].attemptNumber, phase: phase4 }));
      }
    }
  }
  return v;
}

// ─── Phase 5: aggregate derivation ─────────────────────────────────────────

function deriveAggregates(records) {
  const attempts = {
    total: records.length, started: records.length, completed: records.length, inFlight: 0,
    transportFailed: 0, responseReceived: 0,
    expectedStatus: 0, unexpectedStatus: 0,
    assertionPassed: 0, assertionFailed: 0, assertionNotRun: 0,
  };

  for (const r of records) {
    if (r.transport === "failed") {
      attempts.transportFailed += 1;
    } else {
      attempts.responseReceived += 1;
      if (r.http === "expected") attempts.expectedStatus += 1;
      else if (r.http === "unexpected") attempts.unexpectedStatus += 1;
    }
    if (r.assertion === "passed") attempts.assertionPassed += 1;
    else if (r.assertion === "failed") attempts.assertionFailed += 1;
    else if (r.assertion === "not_run") attempts.assertionNotRun += 1;
  }

  const groups = new Map();
  for (const r of records) {
    if (!groups.has(r.logicalOperationId)) groups.set(r.logicalOperationId, []);
    groups.get(r.logicalOperationId).push(r);
  }

  // logicalOperations: sorted by logicalOperationId; each entry's attemptIds
  // sorted by attemptNumber for deterministic output.
  const logicalOperations = [...groups.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([logicalOperationId, group]) => {
      const sorted = [...group].sort((a, b) => a.attemptNumber - b.attemptNumber);
      const finalAttempt = sorted.find((r) => r.final === true) || sorted[sorted.length - 1];
      return {
        logicalOperationId,
        attemptIds: sorted.map((r) => r.attemptId),
        attemptCount: sorted.length,
        finalAttemptId: finalAttempt ? finalAttempt.attemptId : null,
        outcome: finalAttempt ? finalAttempt.outcome : null,
      };
    });

  const logical = {
    total: logicalOperations.length,
    started: logicalOperations.length,
    completed: logicalOperations.length,
    inFlight: 0,
    succeeded: logicalOperations.filter((op) => op.outcome === "succeeded").length,
    failed: logicalOperations.filter((op) => op.outcome === "failed").length,
  };

  // attemptsById: null-prototype object, inserted in canonical order
  // (logicalOperationId-sorted, then attemptNumber-sorted) to block __proto__
  // injection via attemptId and to give deterministic key ordering.
  const attemptsById = Object.create(null);
  const byId = new Map(records.map((r) => [r.attemptId, r]));
  for (const op of logicalOperations) {
    for (const attemptId of op.attemptIds) {
      const r = byId.get(attemptId);
      if (r) attemptsById[attemptId] = structuredClone(r);
    }
  }

  return { logical, attempts, logicalOperations, attemptsById };
}

// ─── Violation sort comparator + dedup ────────────────────────────────────

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
  for (const v of violations) {
    const key = `${v.phase || ""}|${v.logicalOperationId || ""}|${v.attemptNumber ?? ""}|${v.attemptId || ""}|${v.code}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(v);
  }
  return out;
}

// ─── buildOperationReport — transactional two-pass reducer ────────────────

/**
 * Reduce a list of normalized attempt records to the canonical P2 accounting
 * report. Transactional: if ANY violation is found across all phases, the
 * returned aggregates are zero/empty and `violations` carries the exact,
 * sorted, deduplicated findings. Only a fully valid batch produces
 * authoritative counters, logicalOperations, and attemptsById.
 *
 * @param {Array} attemptRecords normalized records (createAttemptRecord output or synthetic)
 * @returns {object} report with { logical, attempts, logicalOperations, attemptsById, violations }
 * @throws {Error} only when attemptRecords is not an array (programming error)
 */
export function buildOperationReport(attemptRecords) {
  if (!Array.isArray(attemptRecords)) {
    throw Object.assign(new Error("buildOperationReport: attemptRecords must be an array"), { code: "INVALID_REPORT_ARG" });
  }

  if (attemptRecords.length === 0) {
    return emptyReport();
  }

  // ── Pass 1: per-record validation (Phases 1 + 2) ──
  // Track logical-operation IDs that contain ANY record-level defect so the
  // whole group can be skipped in Phase 4 sequence validation (otherwise a
  // defective record's omission would cascade into NO_FINAL_ATTEMPT etc.).
  const groupsWithRecordDefects = new Set();
  let allRecordViolations = [];
  for (const r of attemptRecords) {
    const recordViolations = validateAttemptRecord(r);
    if (recordViolations.length > 0) {
      // Mark the group for suppression if the record has a usable
      // logicalOperationId. Records with unusable identity never enter
      // grouping anyway, so no suppression is needed for them.
      const lid = r && typeof r === "object" && typeof r.logicalOperationId === "string"
        ? r.logicalOperationId : null;
      if (lid && lid.length > 0 && lid.length <= MAX_ID_LENGTH) {
        groupsWithRecordDefects.add(lid);
      }
      allRecordViolations = allRecordViolations.concat(recordViolations);
    }
  }

  // ── Pass 2: global identity (Phase 3) ──
  const identityViolations = validateGlobalIdentity(attemptRecords);

  // ── Pass 2: per-logical-operation sequences (Phase 4) ──
  const sequenceViolations = validateLogicalSequences(attemptRecords, groupsWithRecordDefects);

  const violations = dedupViolations(
    [...allRecordViolations, ...identityViolations, ...sequenceViolations].sort(compareViolations)
  );

  // Transactional: any violation → zero/empty aggregates + exact violations.
  if (violations.length > 0) {
    return {
      logical: ZERO_LOGICAL,
      attempts: ZERO_ATTEMPTS,
      logicalOperations: [],
      attemptsById: Object.create(null),
      violations,
    };
  }

  // ── Phase 5: aggregate derivation ──
  const { logical, attempts, logicalOperations, attemptsById } = deriveAggregates(attemptRecords);

  return { logical, attempts, logicalOperations, attemptsById, violations: [] };
}
