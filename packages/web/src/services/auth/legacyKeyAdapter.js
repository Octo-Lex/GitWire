// src/services/auth/legacyKeyAdapter.js
//
// Legacy API-key compatibility adapter (Wave 2 / issue #94).
//
// The legacy shared API key path (process.env.API_KEY / API_KEYS) remains
// available ONLY through this named adapter. It maps each accepted key to an
// explicit `legacy-key` principal + credential via the
// gitwire_auth.legacy_key_mappings table (Wave 2 migration 041).
//
// A legacy key is NOT a dashboard user and receives NO implicit fleet-wide
// authority. Its permissions come solely from its mapped principal's role
// assignments (which the operator scopes narrowly per ADR-0007).
//
// An unmapped key is rejected with `unmapped_legacy_key` — there is no
// automatic fleet default (ADR-0007/0008).
//
// Raw keys never enter SQL/logs: lookup is by derived fingerprint equality.

import { db } from "../../lib/db.js";
import { logger } from "../../lib/logger.js";
import { createContext } from "./context.js";
import { getPrincipalById, principalValidityCode } from "./principalResolver.js";
import { deriveCredentialHash } from "./credentialResolver.js";

const LEGACY_KEY_PEPPER = "pepper-v1"; // legacy-key fingerprint pepper

/**
 * Derive the canonical key_fingerprint for a presented legacy shared key.
 * Matches the value stored in legacy_key_mappings.key_fingerprint.
 * @param {string} rawKey
 * @returns {Promise<string>} hex sha256-hmac
 */
export async function deriveLegacyKeyFingerprint(rawKey) {
  const crypto = await import("node:crypto");
  return crypto
    .createHmac("sha256", LEGACY_KEY_PEPPER)
    .update(rawKey)
    .digest("hex");
}

/**
 * Resolve a presented legacy shared key to a `legacy-key` principal.
 * Returns unmapped_legacy_key if the key is not explicitly mapped.
 * @param {string} rawKey
 * @returns {Promise<{context: object|null, code: string}>}
 */
export async function resolveLegacyKey(rawKey) {
  if (!rawKey) {
    return { context: null, code: "unauthenticated" };
  }
  const fingerprint = await deriveLegacyKeyFingerprint(rawKey);

  try {
    const { rows } = await db.query(
      `SELECT m.principal_id, m.credential_id, m.retired_at,
              c.revoked_at, c.expires_at, c.audience
         FROM gitwire_auth.legacy_key_mappings m
         JOIN gitwire_auth.auth_credentials c ON c.id = m.credential_id
        WHERE m.key_fingerprint = $1
          AND m.retired_at IS NULL`,
      [fingerprint]
    );
    if (rows.length === 0) {
      // Explicit: an unmapped legacy key receives NO default authority.
      return { context: null, code: "unmapped_legacy_key" };
    }
    const m = rows[0];
    if (m.revoked_at !== null) {
      return { context: null, code: "credential_revoked" };
    }
    if (m.expires_at && new Date(m.expires_at) < new Date()) {
      return { context: null, code: "credential_expired" };
    }

    const principal = await getPrincipalById(m.principal_id);
    if (!principal) {
      return { context: null, code: "unauthenticated" };
    }
    if (principal.principalType !== "legacy-key") {
      // Defense in depth: a legacy-key mapping must point at a legacy-key principal.
      logger.error(
        { principalId: principal.id, principalType: principal.principalType },
        "legacyKeyAdapter: mapping points at non-legacy-key principal — refusing"
      );
      return { context: null, code: "authorization_error" };
    }
    const vcode = principalValidityCode(principal);
    if (vcode !== "allowed") {
      return { context: null, code: vcode };
    }

    const context = createContext({
      principalId: principal.id,
      principalType: principal.principalType,
      sessionId: null,
      credentialId: m.credential_id,
      authenticationMethod: "api_key",
      assuranceLevel: "level1",
      authEpoch: principal.authEpoch,
      installationId: principal.installationId,
      githubUserId: null,
    });
    return { context, code: "allowed" };
  } catch (err) {
    logger.warn({ err }, "legacyKeyAdapter: lookup failed");
    throw err;
  }
}
