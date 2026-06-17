// src/lib/redact.js
// Recursive secret redaction for audit bundle exports.
//
// Walks objects/arrays depth-first and replaces values of keys matching
// known secret patterns with "[REDACTED]".

const SECRET_KEY_PATTERNS = [
  "token",
  "secret",
  "password",
  "private_key",
  "privateKey",
  "authorization",
  "api_key",
  "apiKey",
  "pem",
  "credential",
  "credentials",
  "webhook_secret",
  "app_secret",
  "access_token",
  "refresh_token",
  "session_secret",
];

const REDACTED = "[REDACTED]";

/**
 * Check if a key name looks like it holds a secret.
 */
function isSecretKey(key) {
  const lower = String(key).toLowerCase();
  return SECRET_KEY_PATTERNS.some((p) => lower === p || lower.includes(p));
}

/**
 * Recursively redact secret-like values in an object or array.
 * Returns a deep-cloned, redacted copy (does not mutate input).
 *
 * @param {*} obj - any value
 * @param {number} [maxDepth=20] - recursion guard
 * @returns {*} redacted copy
 */
export function redactSecrets(obj, maxDepth = 20) {
  if (maxDepth <= 0) return REDACTED;

  if (obj === null || obj === undefined) return obj;
  if (typeof obj !== "object") return obj;

  if (Array.isArray(obj)) {
    return obj.map((item) => redactSecrets(item, maxDepth - 1));
  }

  const result = {};
  for (const [key, value] of Object.entries(obj)) {
    if (isSecretKey(key) && value !== null && value !== undefined) {
      result[key] = REDACTED;
    } else if (typeof value === "object" && value !== null) {
      result[key] = redactSecrets(value, maxDepth - 1);
    } else {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Truncate long string values in an object to a max length.
 * Useful for evidence blobs that may contain large payloads.
 *
 * @param {*} obj - any value
 * @param {number} [maxStrLen=10000] - max characters per string
 * @param {number} [maxDepth=20] - recursion guard
 * @returns {*} truncated copy
 */
export function truncateLongStrings(obj, maxStrLen = 10000, maxDepth = 20) {
  if (maxDepth <= 0) return obj;
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === "string") {
    return obj.length > maxStrLen ? obj.slice(0, maxStrLen) + "...[truncated]" : obj;
  }
  if (typeof obj !== "object") return obj;

  if (Array.isArray(obj)) {
    return obj.map((item) => truncateLongStrings(item, maxStrLen, maxDepth - 1));
  }

  const result = {};
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === "string") {
      result[key] = value.length > maxStrLen
        ? value.slice(0, maxStrLen) + "...[truncated]"
        : value;
    } else if (typeof value === "object" && value !== null) {
      result[key] = truncateLongStrings(value, maxStrLen, maxDepth - 1);
    } else {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Get the list of redacted field patterns (for bundle metadata).
 */
export function getRedactedFields() {
  return [...SECRET_KEY_PATTERNS];
}
