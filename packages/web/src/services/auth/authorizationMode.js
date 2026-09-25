// src/services/auth/authorizationMode.js
//
// W1-02: canonical observe/enforce semantics for the central authorization
// service. Transport-specific blocking remains the responsibility of the
// caller until the W1-03/W1-04 cutovers consume the `blocked` outcome.

export const AuthorizationMode = Object.freeze({
  OBSERVE: "observe",
  ENFORCED: "enforced",
});

const VALID_MODES = new Set(Object.values(AuthorizationMode));

/**
 * Normalize an authorization mode. Omitted mode preserves the existing
 * observe-only behavior. Unknown values are rejected rather than silently
 * downgrading an intended enforcement boundary.
 *
 * @param {string|undefined|null} mode
 * @returns {"observe"|"enforced"}
 */
export function normalizeAuthorizationMode(mode = AuthorizationMode.OBSERVE) {
  const candidate = mode ?? AuthorizationMode.OBSERVE;
  if (!VALID_MODES.has(candidate)) {
    throw new TypeError(`Unknown authorization mode: ${candidate}`);
  }
  return candidate;
}

/**
 * Build the immutable, transport-neutral result consumed by later cutovers.
 * `decision.allowed` remains policy truth; `blocked` expresses whether the
 * selected mode requires the caller to stop the protected operation.
 *
 * @param {object} value
 * @param {object} value.decision
 * @param {boolean} value.persisted
 * @param {string} value.mode
 * @returns {Readonly<{decision: object, persisted: boolean, mode: string, blocked: boolean}>}
 */
export function createAuthorizationOutcome({ decision, persisted, mode }) {
  const normalizedMode = normalizeAuthorizationMode(mode);
  if (!decision || typeof decision.allowed !== "boolean") {
    throw new TypeError("Authorization outcome requires a boolean decision.allowed");
  }

  return Object.freeze({
    decision,
    persisted: !!persisted,
    mode: normalizedMode,
    blocked: normalizedMode === AuthorizationMode.ENFORCED && !decision.allowed,
  });
}
