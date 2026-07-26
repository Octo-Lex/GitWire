// src/services/auth/bootstrapService.js
//
// First-administrator bootstrap runtime (Wave 2 / issue #94).
//
// Backs the first-bootstrap endpoint with Wave 1's complete_bootstrap()
// SECURITY DEFINER function. Requirements (issue #94 "Binding bootstrap
// decisions"):
//   * expose first bootstrap only while bootstrap state is 'enabled';
//   * create the admin principal + credential + fleet assignment atomically
//     through complete_bootstrap();
//   * derive credential hashes OUTSIDE PostgreSQL (only derived hashes enter
//     database functions);
//   * never log raw administrator or bootstrap secrets;
//   * reject repeated bootstrap after successful completion;
//   * provide NO API route for recovery re-enable (operator-only DB INSERT);
//   * do not create or consume a production recovery marker in dev/proof.

import { db } from "../../lib/db.js";
import { logger } from "../../lib/logger.js";

const ADMIN_PEPPER = "pepper-v1"; // admin-credential hash pepper (derived outside PG)

/**
 * Derive the admin credential hash OUTSIDE PostgreSQL.
 * The raw admin secret never enters SQL, logs, or proof evidence.
 * @param {string} rawSecret
 * @returns {Promise<string>} hex sha256-hmac
 */
export async function deriveAdminSecretHash(rawSecret) {
  const crypto = await import("node:crypto");
  return crypto.createHmac("sha256", ADMIN_PEPPER).update(rawSecret).digest("hex");
}

/**
 * Read the current bootstrap state. Returns { state, bootstrapCount }.
 * @returns {Promise<{state: string, bootstrapCount: number}>}
 */
export async function getBootstrapState() {
  const { rows } = await db.query(
    `SELECT state, bootstrap_count FROM gitwire_auth.auth_bootstrap_state WHERE id = 1`
  );
  if (rows.length === 0) {
    return { state: "unknown", bootstrapCount: 0 };
  }
  return {
    state: rows[0].state,
    bootstrapCount: Number(rows[0].bootstrap_count),
  };
}

/**
 * Execute first bootstrap. Calls complete_bootstrap() with DERIVED hashes only.
 *
 * @param {object} opts
 * @param {string} opts.adminDisplayName
 * @param {string} opts.credentialLookupId
 * @param {string} opts.rawAdminSecret       - the raw admin secret (hashed here, never sent raw to PG)
 * @param {string} opts.adminAudience
 * @param {string} opts.adminDisplayPrefix
 * @returns {Promise<{ok: true, principalId: string}>} on success
 * @throws if bootstrap is disabled (repeated bootstrap rejected)
 */
export async function executeFirstBootstrap({
  adminDisplayName,
  credentialLookupId,
  rawAdminSecret,
  adminAudience = "gitwire-app",
  adminDisplayPrefix = "gw_pat_",
}) {
  if (!adminDisplayName || !credentialLookupId || !rawAdminSecret) {
    throw new Error("executeFirstBootstrap: adminDisplayName, credentialLookupId, rawAdminSecret are required");
  }

  // Derive the admin credential hash OUTSIDE PostgreSQL.
  const adminSecretHash = await deriveAdminSecretHash(rawAdminSecret);

  // complete_bootstrap() is the Wave 1 SECURITY DEFINER function that
  // atomically creates the principal + credential + fleet assignment and
  // disables bootstrap. For the FIRST bootstrap (bootstrap_count = 0), no
  // recovery marker is required; the recovery-hash parameters are unused
  // (passed as a placeholder derived hash that will not match any marker).
  // The function enforces state='enabled' and increments bootstrap_count.
  try {
    const { rows } = await db.query(
      `SELECT gitwire_auth.complete_bootstrap(
         $1, $2, $3, $4, $5, $6, $7, $8) AS principal_id`,
      [
        adminDisplayName,
        credentialLookupId,
        adminSecretHash,         // p_admin_secret_hash (derived)
        1,                       // p_admin_pepper_version
        adminAudience,           // p_admin_audience
        adminDisplayPrefix,      // p_admin_display_prefix
        "unused-recovery-hash",  // p_consumer_secret_hash (unused for first bootstrap)
        1,                       // p_recovery_pepper_version
      ]
    );
    const principalId = rows[0]?.principal_id;
    if (!principalId) {
      throw new Error("executeFirstBootstrap: complete_bootstrap returned no principal id");
    }
    logger.info({ principalId }, "first bootstrap succeeded");
    return { ok: true, principalId };
  } catch (err) {
    // Map PG exceptions to clear messages without leaking secrets.
    const msg = err.message || String(err);
    if (/bootstrap is not enabled/.test(msg)) {
      const e = new Error("bootstrap is disabled — repeated bootstrap rejected");
      e.cause = "bootstrap_disabled";
      throw e;
    }
    if (/canonical admin role not found/.test(msg)) {
      const e = new Error("canonical admin role missing — migration 040 not applied");
      e.cause = "admin_role_missing";
      throw e;
    }
    logger.warn({ err: msg }, "executeFirstBootstrap: complete_bootstrap failed");
    throw err;
  }
}
