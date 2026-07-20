// packages/web/tests/stress/modules/retry-policy.js
//
// Generic retry policy + production-compatible adapter for P2.
// Pure functions, no side effects, no production imports.
//
// The production modules (githubRateLimit.js, actionStateMachine.js) have
// side-effect imports (redis, db, logger) that cannot be loaded from the test
// tree. This module declares the canonical values and reimplements the pure
// classification switch. A separate parity test verifies source-text equality
// without importing production code.

import { createAttemptRecord, buildOperationReport } from "./operation-accounting.js";

// ─── Canonical reason namespaces (kept separate per correction #4) ────────

export const GITHUB_ERROR_REASONS = Object.freeze({
  TOKEN_INVALID: "token_invalid",
  RATE_EXHAUSTED: "rate_exhausted",
  FORBIDDEN: "forbidden",
  NOT_FOUND: "not_found",
  VALIDATION_ERROR: "validation_error",
  RATE_LIMITED_RETRY_AFTER: "rate_limited_retry_after",
  RATE_LIMITED: "rate_limited",
  SERVER_ERROR: "server_error",
  UNKNOWN: "unknown",
});

export const ACTION_BLOCKED_REASONS = Object.freeze({
  TARGET_DRIFTED: "target_drifted",
  MARKER_AMBIGUOUS: "marker_ambiguous",
  PERMISSION_DENIED: "permission_denied",
  POLICY_DENIED: "policy_denied",
  EVIDENCE_INCOMPLETE: "evidence_incomplete",
  VERIFICATION_FAILED: "verification_failed",
  BACKEND_UNAVAILABLE: "backend_unavailable",
  RATE_LIMITED: "rate_limited",
  DUPLICATE_ACTION: "duplicate_action",
  UNSAFE_SCOPE: "unsafe_scope",
  UNKNOWN: "unknown",
});

// ─── Production queue retry defaults (per correction #1) ──────────────────

export const PRODUCTION_QUEUE_RETRY_DEFAULTS = Object.freeze({
  maxAttempts: 3,
  initialBackoffMs: 2_000,
  backoffType: "exponential",
});

// ─── Production GitHub error classification (per correction #2) ───────────

function getHeader(headers, name) {
  if (!headers) return null;
  if (typeof headers.get === "function") return headers.get(name);
  const lower = name.toLowerCase();
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === lower) return headers[k];
  }
  return null;
}

function parseRateHeaders(headers) {
  if (!headers) return null;
  const remaining = parseInt(getHeader(headers, "x-ratelimit-remaining"), 10);
  const resetEpoch = parseInt(getHeader(headers, "x-ratelimit-reset"), 10);
  const retryAfterHeader = getHeader(headers, "retry-after");
  const resource = getHeader(headers, "x-ratelimit-resource") || "core";
  const retryAfter = retryAfterHeader ? parseInt(retryAfterHeader, 10) : null;

  // Production requires BOTH finite remaining AND finite reset for a non-null
  // result. Without reset, the 403+remaining=0 branch cannot compute
  // cooldown duration and the production classifier returns 'forbidden'.
  if (!Number.isFinite(remaining) || !Number.isFinite(resetEpoch)) return null;

  return {
    remaining,
    resetAt: resetEpoch,
    retryAfter: Number.isFinite(retryAfter) ? retryAfter : null,
    resource,
  };
}

/**
 * Classify an HTTP error the way production githubRateLimit.classifyError does.
 * Returns the production-compatible shape: { reason, retryAfterMs? }.
 * Does NOT add retryability or scheduling fields.
 *
 * @param {{status: number, headers?: object}} opts
 * @returns {{reason: string, retryAfterMs?: number}}
 */
export function classifyProductionGitHubError({ status, headers }) {
  const info = parseRateHeaders(headers);

  switch (status) {
    case 401:
      return { reason: GITHUB_ERROR_REASONS.TOKEN_INVALID };
    case 403:
      if (info && info.remaining === 0) {
        return { reason: GITHUB_ERROR_REASONS.RATE_EXHAUSTED };
      }
      return { reason: GITHUB_ERROR_REASONS.FORBIDDEN };
    case 404:
      return { reason: GITHUB_ERROR_REASONS.NOT_FOUND };
    case 422:
      return { reason: GITHUB_ERROR_REASONS.VALIDATION_ERROR };
    case 429:
      if (info && info.retryAfter) {
        return { reason: GITHUB_ERROR_REASONS.RATE_LIMITED_RETRY_AFTER, retryAfterMs: info.retryAfter * 1000 };
      }
      return { reason: GITHUB_ERROR_REASONS.RATE_LIMITED };
    default:
      if (status >= 500) {
        return { reason: GITHUB_ERROR_REASONS.SERVER_ERROR };
      }
      return { reason: GITHUB_ERROR_REASONS.UNKNOWN };
  }
}

// ─── Retryability mapping ─────────────────────────────────────────────────

const RETRYABLE_REASONS = new Set([
  GITHUB_ERROR_REASONS.SERVER_ERROR,
  GITHUB_ERROR_REASONS.RATE_LIMITED,
  GITHUB_ERROR_REASONS.RATE_LIMITED_RETRY_AFTER,
  GITHUB_ERROR_REASONS.RATE_EXHAUSTED,
]);

// ─── Typed fatal error codes for policy infrastructure failures ───────────
//
// These are NOT operation outcomes. A classifier or backoff defect is an
// infrastructure/programming failure. The orchestrator throws these codes
// and does NOT manufacture a final C2 record or produce an authoritative
// report. Diagnostic prior records may be attached for debugging.

export const RETRY_CLASSIFICATION_FAILED = "RETRY_CLASSIFICATION_FAILED";
export const RETRY_BACKOFF_FAILED = "RETRY_BACKOFF_FAILED";
export const RETRY_DELAY_FAILED = "RETRY_DELAY_FAILED";

// ─── Generic retry policy ─────────────────────────────────────────────────

function validatePolicyArgs({ maxAttempts, classifyAttempt, backoffMs, retryAssertionFailures }) {
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw Object.assign(
      new Error(`createRetryPolicy: maxAttempts must be a positive integer, got ${maxAttempts}`),
      { code: "INVALID_POLICY_CONFIG" }
    );
  }
  if (typeof classifyAttempt !== "function") {
    throw Object.assign(new Error("createRetryPolicy: classifyAttempt must be a function"), { code: "INVALID_POLICY_CONFIG" });
  }
  if (typeof backoffMs !== "function") {
    throw Object.assign(new Error("createRetryPolicy: backoffMs must be a function"), { code: "INVALID_POLICY_CONFIG" });
  }
  if (typeof retryAssertionFailures !== "boolean") {
    throw Object.assign(new Error("createRetryPolicy: retryAssertionFailures must be boolean"), { code: "INVALID_POLICY_CONFIG" });
  }
}

/**
 * Create a generic retry policy. Pure — no side effects, no production imports.
 *
 * @param {object} opts
 * @param {number} opts.maxAttempts total executions (1 = no retry; 3 = initial + 2 retries)
 * @param {function} opts.classifyAttempt ({ status, headers?, transport?, http?, assertion? }) → { reason, retryable, retryAfterMs? }
 * @param {function} opts.backoffMs ({ retryNumber }) → number (ms delay before that retry)
 * @param {boolean} [opts.retryAssertionFailures=false]
 * @returns {{ maxAttempts, decide, classifyAttempt, backoffMs, retryAssertionFailures }}
 */
export function createRetryPolicy(opts) {
  if (!opts || typeof opts !== "object") {
    throw Object.assign(new Error("createRetryPolicy: opts must be an object"), { code: "INVALID_POLICY_CONFIG" });
  }
  const { maxAttempts, classifyAttempt, backoffMs } = opts;
  const retryAssertionFailures = opts.retryAssertionFailures ?? false;

  validatePolicyArgs({ maxAttempts, classifyAttempt, backoffMs, retryAssertionFailures });

  /**
   * Decide whether to retry after an attempt. Made BEFORE creating a C2
   * record (correction #3): the policy does not inspect a caller-supplied
   * `final` value. It returns retryable/final metadata that the caller
   * attaches when calling createAttemptRecord.
   *
   * @param {object} input
   * @param {number} input.attemptNumber positive integer (1-based)
   * @param {object} input.engineResult the factual/contracted engine result
   * @param {object} [input.retryMetadata] out-of-band data (headers) not in the engine result
   * @returns {{ retryable: boolean, retry: boolean, reason: string|null, attemptNumber: number, attemptsRemaining: number, delayMs: number|null }}
   */
  function decide({ attemptNumber, engineResult, retryMetadata = {} }) {
    if (!Number.isInteger(attemptNumber) || attemptNumber < 1) {
      throw Object.assign(
        new Error(`policy.decide: attemptNumber must be a positive integer, got ${attemptNumber}`),
        { code: "INVALID_ATTEMPT_NUMBER" }
      );
    }
    if (attemptNumber > maxAttempts) {
      throw Object.assign(
        new Error(`policy.decide: attemptNumber ${attemptNumber} exceeds maxAttempts ${maxAttempts}`),
        { code: "ATTEMPT_EXCEEDS_MAX" }
      );
    }

    const attemptsRemaining = maxAttempts - attemptNumber;
    const headers = retryMetadata?.headers ?? null;

    // Classify the attempt using the injected classifier.
    let classification;
    try {
      classification = classifyAttempt({
        status: engineResult?.status,
        headers,
        transport: engineResult?.transport,
        http: engineResult?.http,
        assertion: engineResult?.assertion,
        error: engineResult?.error,
      });
    } catch (err) {
      // Classifier threw — infrastructure/policy defect. Typed fatal error;
      // no fabricated final record, no authoritative report.
      throw Object.assign(
        new Error(`retry classification failed: classifier threw`),
        { code: RETRY_CLASSIFICATION_FAILED, cause: err }
      );
    }

    if (!classification || typeof classification !== "object" ||
        typeof classification.reason !== "string" || classification.reason.length === 0) {
      // Malformed classifier output — reason missing, non-string, or empty.
      throw Object.assign(
        new Error(`retry classification failed: reason must be a non-empty string`),
        { code: RETRY_CLASSIFICATION_FAILED }
      );
    }

    // Require retryable to be exactly boolean (correction D1).
    if (typeof classification.retryable !== "boolean") {
      throw Object.assign(
        new Error(`retry classification failed: retryable must be boolean, got ${typeof classification.retryable}`),
        { code: RETRY_CLASSIFICATION_FAILED }
      );
    }

    // Validate retryAfterMs if present (correction D1).
    if (classification.retryAfterMs !== undefined) {
      if (typeof classification.retryAfterMs !== "number" ||
          !Number.isFinite(classification.retryAfterMs) ||
          classification.retryAfterMs < 0) {
        throw Object.assign(
          new Error(`retry classification failed: retryAfterMs must be a finite non-negative number`),
          { code: RETRY_CLASSIFICATION_FAILED }
        );
      }
    }

    const retryable = classification.retryable;

    // Assertion failures: retry only if explicitly permitted.
    if (engineResult?.assertion === "failed" && !retryAssertionFailures) {
      return { retryable: false, retry: false, reason: "assertion_failure", attemptNumber, attemptsRemaining, delayMs: null };
    }

    // Budget exhausted: intrinsically retryable but no more attempts available.
    if (attemptNumber >= maxAttempts) {
      return {
        retryable,
        retry: false,
        reason: retryable ? classification.reason : (classification.reason || "not_retryable"),
        attemptNumber,
        attemptsRemaining: 0,
        delayMs: null,
      };
    }

    // Budget remaining: retry if retryable.
    if (retryable) {
      // Determine delay: classification.retryAfterMs takes precedence over
      // backoffMs (correction #4). Retry-After from the server is
      // authoritative when present.
      let delayMs = null;
      if (typeof classification.retryAfterMs === "number" && Number.isFinite(classification.retryAfterMs) && classification.retryAfterMs >= 0) {
        delayMs = classification.retryAfterMs;
      } else {
        try {
          delayMs = backoffMs({ retryNumber: attemptNumber });
        } catch (err) {
          throw Object.assign(
            new Error(`retry backoff failed: backoffMs threw`),
            { code: RETRY_BACKOFF_FAILED, cause: err }
          );
        }
        if (typeof delayMs !== "number" || !Number.isFinite(delayMs) || delayMs < 0 || Number.isNaN(delayMs)) {
          throw Object.assign(
            new Error(`retry backoff failed: invalid value`),
            { code: RETRY_BACKOFF_FAILED }
          );
        }
      }
      return { retryable, retry: true, reason: classification.reason, attemptNumber, attemptsRemaining, delayMs };
    }

    return { retryable: false, retry: false, reason: classification.reason, attemptNumber, attemptsRemaining, delayMs: null };
  }

  return Object.freeze({ maxAttempts, decide, classifyAttempt, backoffMs, retryAssertionFailures });
}

// ─── Production-compatible retry classifier ───────────────────────────────

function productionClassifyAttempt({ status, headers, transport, http, assertion, error }) {
  if (transport === "failed") {
    // Transport failures: retryable except abort (terminal) and unknown
    // categories (fail-closed terminal per correction #2/#8).
    const category = error?.category;
    if (category === "abort") {
      return { reason: "abort", retryable: false };
    }
    // Known retryable transport categories.
    const retryableCategories = new Set([
      "timeout", "connection_refused", "connection_reset", "dns", "tls", "protocol", "other",
    ]);
    if (retryableCategories.has(category)) {
      return { reason: "transport_failure", retryable: true };
    }
    // Unknown category → fail-closed terminal.
    return { reason: "unknown_transport_category", retryable: false };
  }
  if (assertion === "failed") {
    return { reason: "assertion_failure", retryable: false };
  }
  if (status === undefined || status === null) {
    return { reason: GITHUB_ERROR_REASONS.UNKNOWN, retryable: false };
  }

  const ghClassification = classifyProductionGitHubError({ status, headers });
  const retryable = RETRYABLE_REASONS.has(ghClassification.reason);

  return {
    reason: ghClassification.reason,
    retryable,
    ...(ghClassification.retryAfterMs !== undefined ? { retryAfterMs: ghClassification.retryAfterMs } : {}),
  };
}

/**
 * Production-compatible retry policy. Matches BullMQ defaults:
 * maxAttempts=3, exponential backoff starting at 2000ms.
 * Delay sequence: retry 1 → 2000ms, retry 2 → 4000ms.
 */
export const productionRetryPolicy = createRetryPolicy({
  maxAttempts: PRODUCTION_QUEUE_RETRY_DEFAULTS.maxAttempts,
  classifyAttempt: productionClassifyAttempt,
  backoffMs: ({ retryNumber }) =>
    PRODUCTION_QUEUE_RETRY_DEFAULTS.initialBackoffMs * 2 ** (retryNumber - 1),
  retryAssertionFailures: false,
});

// ─── Retry orchestration helper (per correction #6) ───────────────────────

/**
 * Execute a retry scenario: run attempts until terminal, producing C2
 * attempt records and a final report. Retry sleep happens BETWEEN physical
 * attempt executions — NOT inside a runBurst slot (correction #7).
 *
 * @param {object} opts
 * @param {string} opts.logicalOperationId
 * @param {function} opts.executeAttempt (attemptNumber) → Promise<engineResult>
 * @param {function} [opts.retryMetadataFor] (attemptNumber, engineResult) → { headers? }
 * @param {object} opts.policy retry policy
 * @param {function} opts.sleep (ms) → Promise<void>
 * @param {{active: number, maxActive: number}} [opts.executionState]
 * @returns {Promise<{attemptRecords: object[], report: object, decisions: object[]}>}
 */
export async function executeRetryScenario({
  logicalOperationId,
  executeAttempt,
  retryMetadataFor = () => ({}),
  policy,
  sleep,
  executionState = { active: 0, maxActive: 0 },
}) {
  const attemptRecords = [];
  const decisions = [];
  let attemptNumber = 0;

  while (true) {
    attemptNumber += 1;

    executionState.active += 1;
    executionState.maxActive = Math.max(executionState.maxActive, executionState.active);

    let engineResult;
    try {
      engineResult = await executeAttempt(attemptNumber);
    } finally {
      executionState.active -= 1;
    }

    const retryMetadata = retryMetadataFor(attemptNumber, engineResult);

    let decision;
    try {
      decision = policy.decide({ attemptNumber, engineResult, retryMetadata });
    } catch (err) {
      // Classifier or backoff infrastructure defect — typed fatal error.
      // Prior attempt records remain as diagnostics, but no authoritative
      // report is produced and no fake final record is manufactured.
      // The error from decide() already has the typed code; attach
      // diagnostic context.
      err.attemptRecords = attemptRecords;
      err.decisions = decisions;
      throw err;
    }
    decisions.push(decision);

    const record = createAttemptRecord(engineResult, {
      logicalOperationId,
      attemptId: `${logicalOperationId}:${attemptNumber}`,
      attemptNumber,
      retryable: decision.retryable,
      final: !decision.retry,
    });
    attemptRecords.push(record);

    if (!decision.retry) {
      const report = buildOperationReport(attemptRecords);
      return { attemptRecords, report, decisions };
    }

    try {
      await sleep(decision.delayMs);
    } catch (err) {
      const sleepError = Object.assign(
        new Error(`retry delay failed: ${err.message}`),
        { code: RETRY_DELAY_FAILED, cause: err, attemptRecords, decisions }
      );
      throw sleepError;
    }
  }
}

// ─── Retry-After header parsing (per correction #5) ───────────────────────

/**
 * Parse a Retry-After header value into milliseconds.
 * Supports integer seconds and HTTP-date. Returns null for
 * missing/malformed/negative/excessive values.
 *
 * The HTTP-date branch requires a current-time reference; inject `nowMs`
 * to keep this deterministic. When omitted, the caller's injected clock
 * should provide the value — this function does NOT call wall-clock APIs.
 *
 * @param {*} headerValue
 * @param {number} [nowMs] current time in ms (for HTTP-date comparison)
 * @returns {number|null} milliseconds, or null
 */
export function parseRetryAfter(headerValue, nowMs) {
  if (headerValue === null || headerValue === undefined) return null;
  const str = String(headerValue).trim();

  const seconds = parseInt(str, 10);
  if (Number.isFinite(seconds) && seconds >= 0 && seconds <= 86400 && String(seconds) === str) {
    return seconds * 1000;
  }

  // HTTP-date format (RFC 7231). Requires a time reference for delta
  // computation. If nowMs is not provided, this branch is skipped (integer-
  // seconds format is the common case and does not need a time reference).
  if (typeof nowMs === "number" && Number.isFinite(nowMs)) {
    const dateMs = Date.parse(str);
    if (Number.isFinite(dateMs)) {
      const delta = dateMs - nowMs;
      if (delta > 0 && delta <= 86400000) return delta;
    }
  }

  return null;
}
