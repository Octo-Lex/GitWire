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
  const retryAfterHeader = getHeader(headers, "retry-after");
  const resource = getHeader(headers, "x-ratelimit-resource") || "core";
  const retryAfter = retryAfterHeader ? parseInt(retryAfterHeader, 10) : null;
  return {
    remaining: Number.isFinite(remaining) ? remaining : null,
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

    let classification;
    try {
      classification = classifyAttempt({
        status: engineResult?.status,
        headers,
        transport: engineResult?.transport,
        http: engineResult?.http,
        assertion: engineResult?.assertion,
      });
    } catch {
      return { retryable: false, retry: false, reason: "classifier_error", attemptNumber, attemptsRemaining: 0, delayMs: null };
    }

    if (!classification || typeof classification !== "object" || typeof classification.reason !== "string") {
      return { retryable: false, retry: false, reason: "unknown_classification", attemptNumber, attemptsRemaining: 0, delayMs: null };
    }

    const retryable = classification.retryable === true;

    // Assertion failures: retry only if explicitly permitted.
    if (engineResult?.assertion === "failed" && !retryAssertionFailures) {
      return { retryable: false, retry: false, reason: "assertion_failure", attemptNumber, attemptsRemaining, delayMs: null };
    }

    // Budget exhausted.
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
      let delayMs;
      try {
        delayMs = backoffMs({ retryNumber: attemptNumber });
      } catch {
        return { retryable, retry: false, reason: "backoff_error", attemptNumber, attemptsRemaining, delayMs: null };
      }
      if (typeof delayMs !== "number" || !Number.isFinite(delayMs) || delayMs < 0 || Number.isNaN(delayMs)) {
        return { retryable, retry: false, reason: "invalid_backoff", attemptNumber, attemptsRemaining, delayMs: null };
      }
      return { retryable, retry: true, reason: classification.reason, attemptNumber, attemptsRemaining, delayMs };
    }

    return { retryable: false, retry: false, reason: classification.reason, attemptNumber, attemptsRemaining, delayMs: null };
  }

  return Object.freeze({ maxAttempts, decide, classifyAttempt, backoffMs, retryAssertionFailures });
}

// ─── Production-compatible retry classifier ───────────────────────────────

function productionClassifyAttempt({ status, headers, transport, http, assertion }) {
  if (transport === "failed") {
    return { reason: "transport_failure", retryable: true };
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

export const RETRY_DELAY_FAILED = "RETRY_DELAY_FAILED";

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
    const decision = policy.decide({ attemptNumber, engineResult, retryMetadata });
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
