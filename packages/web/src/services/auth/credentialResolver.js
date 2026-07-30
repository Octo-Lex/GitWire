// src/services/auth/credentialResolver.js
//
// Credential resolver (Wave 2 / issue #94).
//
// Resolves a presented credential (raw API key / service token) to a server-
// owned principal by looking up its DERIVED hash in
// gitwire_auth.auth_credentials (Wave 1). The raw secret is never stored,
// never enters SQL, logs, metrics, or proof evidence — only its derived hash
// traverses the lookup.
//
// Enforces fail-closed validity: credential revoked, expired, audience
// mismatch, principal disabled, auth_epoch consistency.

import { db } from "../../lib/db.js";
import { logger } from "../../lib/logger.js";
import { createContext } from "./context.js";
import { getPrincipalById, principalValidityCode } from "./principalResolver.js";

const CREDENTIAL_PEPPER = "pepper-v1"; // credential-hash pepper

/**
 * Derive the canonical secret_hash for a presented raw credential.
 * Used to look up auth_credentials by secret_hash equality.
 * @param {string} rawSecret
 * @returns {Promise<string>} hex sha256-hmac
 */
export async function deriveCredentialHash(rawSecret) {
  const crypto = await import("node:crypto");
  return crypto
    .createHmac("sha256", CREDENTIAL_PEPPER)
    .update(rawSecret)
    .digest("hex");
}

/**
 * Resolve a raw credential + expected audience to a principal.
 * @param {string} rawSecret - the raw presented secret
 * @param {string} expectedAudience - e.g. 'gitwire-app'
 * @returns {Promise<{context: object|null, code: string}>}
 */
export async function resolveCredential(rawSecret, expectedAudience) {
  if (!rawSecret) {
    return { context: null, code: "unauthenticated" };
  }
  const hash = await deriveCredentialHash(rawSecret);

  try {
    const { rows } = await db.query(
      `SELECT c.id AS credential_id, c.principal_id, c.audience,
              c.expires_at, c.revoked_at, c.pepper_version
         FROM gitwire_auth.auth_credentials c
        WHERE c.secret_hash = $1
          AND c.revoked_at IS NULL`,
      [hash]
    );
    if (rows.length === 0) {
      return { context: null, code: "credential_unknown" };
    }
    const c = rows[0];
    if (c.revoked_at !== null) {
      return { context: null, code: "credential_revoked" };
    }
    if (c.expires_at && new Date(c.expires_at) < new Date()) {
      return { context: null, code: "credential_expired" };
    }
    if (c.audience !== expectedAudience) {
      return { context: null, code: "credential_audience_mismatch" };
    }

    const principal = await getPrincipalById(c.principal_id);
    if (!principal) {
      return { context: null, code: "unauthenticated" };
    }
    const vcode = principalValidityCode(principal);
    if (vcode !== "allowed") {
      return { context: null, code: vcode };
    }

    const context = createContext({
      principalId: principal.id,
      principalType: principal.principalType,
      sessionId: null,
      credentialId: c.credential_id,
      authenticationMethod: "api_key",
      assuranceLevel: "level1",
      authEpoch: principal.authEpoch,
      installationId: principal.installationId,
      githubUserId: principal.githubUserId,
    });
    return { context, code: "allowed" };
  } catch (err) {
    logger.warn({ err }, "credentialResolver: lookup failed");
    throw err;
  }
}
