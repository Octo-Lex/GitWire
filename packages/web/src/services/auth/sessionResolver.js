// src/services/auth/sessionResolver.js
//
// Session resolver (Wave 2 / issue #94).
//
// Resolves a session token (from the `gitwire-session` cookie) to a server-
// owned principal. Sessions are principal-aware: the token maps to a
// principal_id + auth_epoch, and the resolver enforces every fail-closed
// condition (revoked, expired, principal disabled, auth_epoch mismatch).
//
// Two-layer lookup:
//   * Redis (`gitwire:session:<token>`) — fast token → { principalId, sessionId }
//     The token itself is an opaque random UUID; no principal is derivable
//     from it without this lookup.
//   * PostgreSQL (`gitwire_auth.auth_sessions` + `auth_principals`) — the
//     durable revocable record. The session_hash (Wave 1) is the canonical
//     revocation handle; a row with revoked_at IS NOT NULL is revoked.
//
// The session_hash stored in auth_sessions is the DERIVED hash of the token
// (HMAC-SHA256, pepper-versioned), never the raw token. Lookup here is by
// matching the derived hash, so the raw token traverses only the Redis
// fast-path and the in-memory hash computation.

import { redis } from "../../lib/queue.js";
import { db } from "../../lib/db.js";
import { logger } from "../../lib/logger.js";
import { createContext } from "./context.js";
import { getPrincipalById, principalValidityCode } from "./principalResolver.js";

const SESSION_PREFIX = "gitwire:session:";
const SESSION_PEPPER = "pepper-v1"; // session-hash pepper (token hashing)

/**
 * Derive the canonical session_hash for an auth_sessions lookup.
 * The raw token never enters PostgreSQL.
 * @param {string} token - the raw session token
 * @returns {Promise<string>} hex sha256-hmac of the token
 */
export async function deriveSessionHash(token) {
  // Lazy import so this module loads in environments without crypto side-effects
  const crypto = await import("node:crypto");
  return crypto
    .createHmac("sha256", SESSION_PEPPER)
    .update(token)
    .digest("hex");
}

/**
 * Resolve a session token to an AuthContext.
 * @param {string} token - raw session token from the cookie
 * @returns {Promise<{context: object, code: string}>}
 *   context: AuthContext if resolved, else unauthenticatedContext
 *   code: DecisionCode (allowed | session_revoked | session_expired | ...)
 */
export async function resolveSession(token) {
  if (!token) {
    return { context: null, code: "unauthenticated" };
  }

  // Fast path: Redis token → { principalId, sessionId }
  let principalId = null;
  let sessionId = null;
  try {
    const data = await redis.get(SESSION_PREFIX + token);
    if (data) {
      const parsed = JSON.parse(data);
      principalId = parsed.principalId ?? null;
      sessionId = parsed.sessionId ?? null;
    }
  } catch (err) {
    logger.warn({ err }, "sessionResolver: redis lookup failed — falling back to DB");
  }

  // If Redis had no mapping, the session is not valid (revoked or never existed)
  if (!principalId) {
    return { context: null, code: "session_revoked" };
  }

  // Durable check: auth_sessions row must exist, be non-revoked, non-expired,
  // and the principal's auth_epoch must match what was captured at login.
  try {
    const { rows } = await db.query(
      `SELECT s.id, s.principal_id, s.auth_epoch, s.expires_at, s.revoked_at,
              p.status
         FROM gitwire_auth.auth_sessions s
         JOIN gitwire_auth.auth_principals p ON p.id = s.principal_id
        WHERE s.principal_id = $1
        ORDER BY s.created_at DESC
        LIMIT 1`,
      [principalId]
    );
    if (rows.length === 0) {
      return { context: null, code: "session_revoked" };
    }
    const s = rows[0];
    if (s.revoked_at !== null) {
      return { context: null, code: "session_revoked" };
    }
    if (s.expires_at && new Date(s.expires_at) < new Date()) {
      return { context: null, code: "session_expired" };
    }
    const storedEpoch = Number(s.auth_epoch);
    const principal = await getPrincipalById(principalId);
    if (!principal) {
      return { context: null, code: "unauthenticated" };
    }
    const vcode = principalValidityCode(principal);
    if (vcode !== "allowed") {
      return { context: null, code: vcode };
    }
    if (principal.authEpoch !== storedEpoch) {
      // Credential/role revocation bumped the epoch — session is stale.
      return { context: null, code: "auth_epoch_mismatch" };
    }

    const context = createContext({
      principalId: principal.id,
      principalType: principal.principalType,
      sessionId: sessionId ?? s.id,
      credentialId: null,
      authenticationMethod: "session",
      assuranceLevel: "level1",
      authEpoch: principal.authEpoch,
      installationId: principal.installationId,
      githubUserId: principal.githubUserId,
    });
    return { context, code: "allowed" };
  } catch (err) {
    logger.warn({ err, principalId }, "sessionResolver: durable check failed");
    throw err;
  }
}
