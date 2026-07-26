// src/services/auth/denialCodes.js
//
// Stable authorization decision + denial-code model (Wave 2 / issue #94).
//
// These codes are the authoritative stable denial categories the central
// authorize() service returns. They are frozen string constants — routes,
// tests, observe-only evidence, and external clients match on these exact
// values. Do NOT rename without a migration of every consumer.
//
// Internal database/implementation errors MUST surface as `authorization_error`
// (fail-closed), never as an implicit allow.

/**
 * Stable denial / decision codes.
 * The string values are the contract — see docs/architecture/authority.
 */
export const DecisionCode = Object.freeze({
  // Positive
  ALLOWED: "allowed",

  // Identity / authentication negatives
  UNAUTHENTICATED: "unauthenticated",
  PRINCIPAL_DISABLED: "principal_disabled",
  SESSION_REVOKED: "session_revoked",
  SESSION_EXPIRED: "session_expired",
  CREDENTIAL_REVOKED: "credential_revoked",
  CREDENTIAL_EXPIRED: "credential_expired",
  CREDENTIAL_AUDIENCE_MISMATCH: "credential_audience_mismatch",
  AUTH_EPOCH_MISMATCH: "auth_epoch_mismatch",
  UNMAPPED_LEGACY_KEY: "unmapped_legacy_key",
  CREDENTIAL_UNKNOWN: "credential_unknown",

  // Authorization negatives
  PERMISSION_MISSING: "permission_missing",
  SCOPE_MISSING: "scope_missing",
  SCOPE_MISMATCH: "scope_mismatch",
  RESOURCE_UNKNOWN: "resource_unknown",
  RESOURCE_MISSING: "resource_missing",
  ASSURANCE_INSUFFICIENT: "assurance_insufficient",
  ASSIGNMENT_REVOKED: "assignment_revoked",

  // Implementation fail-closed
  AUTHORIZATION_ERROR: "authorization_error",
});

/** True iff the code represents an allow decision. */
export function isAllowedCode(code) {
  return code === DecisionCode.ALLOWED;
}

/** True iff the code represents a deny decision (every non-allow code). */
export function isDenyCode(code) {
  return code !== DecisionCode.ALLOWED;
}

/**
 * The set of canonical codes (for validation / completeness checks).
 * Every code the authorize() service can return must appear here.
 */
export const ALL_DECISION_CODES = Object.freeze(
  Object.values(DecisionCode)
);

/**
 * The canonical denial codes required by issue #94 (the minimum stable set).
 * Used by the protected-surface / completeness check to assert the full set
 * is represented in tests and decision logging.
 */
export const REQUIRED_DENIAL_CATEGORIES = Object.freeze([
  DecisionCode.UNAUTHENTICATED,
  DecisionCode.PRINCIPAL_DISABLED,
  DecisionCode.SESSION_REVOKED,
  DecisionCode.SESSION_EXPIRED,
  DecisionCode.CREDENTIAL_REVOKED,
  DecisionCode.CREDENTIAL_EXPIRED,
  DecisionCode.CREDENTIAL_AUDIENCE_MISMATCH,
  DecisionCode.UNMAPPED_LEGACY_KEY,
  DecisionCode.PERMISSION_MISSING,
  DecisionCode.SCOPE_MISSING,
  DecisionCode.SCOPE_MISMATCH,
  DecisionCode.RESOURCE_UNKNOWN,
  DecisionCode.ASSURANCE_INSUFFICIENT,
  DecisionCode.AUTHORIZATION_ERROR,
]);
