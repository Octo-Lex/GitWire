// src/services/triageFailureService.js
// Classification and sanitization for triage processing failures.
//
// When triage fails, this service classifies the error so the worker can:
//   - decide whether to discard (permanent) or retry (transient);
//   - store a sanitized gitwireFailure block on the BullMQ job;
//   - avoid leaking secrets, tokens, or raw provider responses.
//
// Classification contract (from the implementation plan):
//
//   failureClass: "provider_auth" | "provider_rate_limit" | "provider_unavailable"
//               | "github_auth" | "github_unavailable" | "invalid_provider_response"
//               | "persistence_failure" | "unknown"
//   retryable:    boolean
//   statusCode:   number | null
//   safeMessage:  string (sanitized)
//   failedAt:     ISO timestamp

const PERMANENT_CLASSES = new Set([
  "provider_auth",
  "github_auth",
]);

/**
 * Classify a triage processing error.
 *
 * @param {Error|object} err - the thrown error
 * @returns {{
 *   failureClass: string,
 *   retryable: boolean,
 *   statusCode: number|null,
 *   safeMessage: string,
 *   failedAt: string,
 * }}
 */
export function classifyTriageFailure(err) {
  const status = readStatus(err);
  const message = String(err?.message || err?.cause?.message || "unknown error");
  const isAuthErr = err?.name === "AuthenticationError" || /Authentication Failed/i.test(message);

  // LLM provider errors (Anthropic SDK / Z.AI gateway)
  if (status === 401 || status === 403) {
    // Distinguish provider-auth (LLM) from github-auth by error shape.
    if (isAnthropicShapedError(err) || isAuthErr) {
      return makeFailure("provider_auth", false, status, "LLM provider rejected authentication");
    }
    return makeFailure("github_auth", false, status, "GitHub rejected authentication");
  }
  if (status === 429) {
    return makeFailure("provider_rate_limit", true, status, "LLM provider rate limit reached");
  }
  if (status >= 500 && status < 600) {
    if (isAnthropicShapedError(err)) {
      return makeFailure("provider_unavailable", true, status, "LLM provider unavailable");
    }
    return makeFailure("github_unavailable", true, status, "GitHub unavailable");
  }

  // Network / timeout / reset (no status, connection-class message)
  if (status === null && isNetworkError(message)) {
    // If the error references Anthropic/baseURL host, treat as provider; else github.
    if (isAnthropicShapedError(err) || /anthropic|api\.z\.ai|baseURL|LLM/i.test(message)) {
      return makeFailure("provider_unavailable", true, null, "LLM provider network error");
    }
    return makeFailure("github_unavailable", true, null, "GitHub network error");
  }

  // Malformed LLM JSON response (JSON.parse failure on provider output)
  if (isJsonParseError(err)) {
    return makeFailure("invalid_provider_response", true, null, "LLM returned malformed JSON");
  }

  // Database / persistence failures
  if (isPersistenceError(err)) {
    return makeFailure("persistence_failure", true, status, "Database write failed");
  }

  return makeFailure("unknown", true, status, "Unclassified triage failure");
}

/**
 * Whether a classified failure is permanent (should discard, not retry).
 */
export function isPermanentFailure(classification) {
  return PERMANENT_CLASSES.has(classification.failureClass);
}

/**
 * Sanitize a failure classification for retention on the BullMQ job.
 * Strips anything that could carry a secret: stack traces, raw response bodies,
 * header values, and any token-shaped substring.
 *
 * @param {object} classification - from classifyTriageFailure
 * @param {object} [context] - optional { attempts, firstFailedAt }
 * @returns {object} the gitwireFailure block safe to store on job.data
 */
export function sanitizeForRetention(classification, context = {}) {
  const safe = scrubSecrets(classification.safeMessage);
  return {
    failureClass: classification.failureClass,
    retryable: classification.retryable,
    statusCode: classification.statusCode,
    safeMessage: safe,
    firstFailedAt: context.firstFailedAt ?? classification.failedAt,
    latestFailedAt: classification.failedAt,
    attempts: context.attempts ?? 1,
  };
}

// ── internals ────────────────────────────────────────────────────────────────

function makeFailure(failureClass, retryable, statusCode, safeMessage) {
  return {
    failureClass,
    retryable,
    statusCode,
    safeMessage,
    failedAt: new Date().toISOString(),
  };
}

function readStatus(err) {
  const v = err?.status ?? err?.statusCode ?? err?.response?.status ?? err?.cause?.status;
  if (typeof v === "number") return v;
  const parsed = parseInt(String(v), 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function isAnthropicShapedError(err) {
  if (!err) return false;
  // @anthropic-ai/sdk sets err.type === "authentication_error" / "api_error" / etc.
  // and often carries err.error (the provider JSON body).
  if (err.type && /authentication|api|permission|rate_limit/i.test(String(err.type))) return true;
  if (err.error && typeof err.error === "object" && err.error.type) return true;
  // Stack frame reference into the SDK
  if (err.stack && /@anthropic-ai\/sdk/.test(String(err.stack))) return true;
  return false;
}

function isNetworkError(message) {
  return /ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|network|timeout/i.test(message);
}

function isJsonParseError(err) {
  return err instanceof SyntaxError || /JSON|Unexpected token|Unexpected end/i.test(String(err?.message || ""));
}

function isPersistenceError(err) {
  const m = String(err?.message || "");
  return /database|relation .* does not exist|connection refused|deadlock|serialization failure|pg_|postgres/i.test(m)
    && !isAnthropicShapedError(err);
}

// Strip token-shaped substrings and any obvious secret markers from a message.
// This is defense-in-depth: classifyTriageFailure already produces generic
// messages, but sanitizeForRetention also cleans operator-supplied content.
function scrubSecrets(text) {
  if (typeof text !== "string") return "unknown";
  let out = text;
  // Redact bearer tokens, api keys, long hex/base64 runs
  out = out.replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer <redacted>");
  out = out.replace(/(?:sk-[A-Za-z0-9-]*|gho_|ghp_|ghs_|ghu_|ghr_)[A-Za-z0-9._-]{10,}/g, "<redacted>");
  out = out.replace(/[A-Za-z0-9]{40,}/g, (m) => (m.length >= 40 ? "<redacted>" : m));
  // Truncate — safe messages are short by contract
  if (out.length > 200) out = out.slice(0, 200) + "...";
  return out;
}
