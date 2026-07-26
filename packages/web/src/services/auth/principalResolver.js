// src/services/auth/principalResolver.js
//
// Principal resolver (Wave 2 / issue #94).
//
// Loads a principal from gitwire_auth.auth_principals and reports its validity
// state. Every transport resolver (session, credential, legacy-key, service,
// installation, system) converges on this module to resolve the final principal
// record and to check the fail-closed validity conditions.
//
// Raw secrets never enter this module. Credential lookups happen by derived
// hash (see credentialResolver / legacyKeyAdapter).

import { db } from "../../lib/db.js";
import { logger } from "../../lib/logger.js";

/**
 * @typedef {Object} PrincipalRecord
 * @property {string} id
 * @property {string} principalType
 * @property {string} displayName
 * @property {string} status              - 'active' | 'disabled'
 * @property {number} authEpoch
 * @property {number|null} githubUserId
 * @property {number|null} installationId
 */

/**
 * Load a principal by id. Returns null if not found.
 * @param {string} principalId - UUID
 * @returns {Promise<PrincipalRecord|null>}
 */
export async function getPrincipalById(principalId) {
  if (!principalId) return null;
  try {
    const { rows } = await db.query(
      `SELECT id, principal_type, display_name, status, auth_epoch,
              github_user_id, installation_id
         FROM gitwire_auth.auth_principals
        WHERE id = $1`,
      [principalId]
    );
    if (rows.length === 0) return null;
    const r = rows[0];
    return {
      id: r.id,
      principalType: r.principal_type,
      displayName: r.display_name,
      status: r.status,
      authEpoch: Number(r.auth_epoch),
      githubUserId: r.github_user_id !== null ? Number(r.github_user_id) : null,
      installationId: r.installation_id !== null ? Number(r.installation_id) : null,
    };
  } catch (err) {
    logger.warn({ err, principalId }, "principalResolver: load failed");
    throw err;
  }
}

/**
 * Resolve a principal for an installation (webhook path). The installation
 * principal is looked up by installation_id; if none exists, null is returned
 * (the caller decides whether to create-on-first-see or deny).
 * @param {number} installationId
 * @returns {Promise<PrincipalRecord|null>}
 */
export async function getInstallationPrincipal(installationId) {
  if (!installationId) return null;
  try {
    const { rows } = await db.query(
      `SELECT id, principal_type, display_name, status, auth_epoch,
              github_user_id, installation_id
         FROM gitwire_auth.auth_principals
        WHERE principal_type = 'installation' AND installation_id = $1`,
      [installationId]
    );
    if (rows.length === 0) return null;
    const r = rows[0];
    return {
      id: r.id,
      principalType: r.principal_type,
      displayName: r.display_name,
      status: r.status,
      authEpoch: Number(r.auth_epoch),
      githubUserId: null,
      installationId: Number(r.installation_id),
    };
  } catch (err) {
    logger.warn({ err, installationId }, "principalResolver: installation load failed");
    throw err;
  }
}

/**
 * Resolve the canonical system principal for trusted autonomous tasks
 * (migration runner, schedulers). There is exactly one system principal per
 * display_name; if missing, null is returned.
 * @param {string} displayName - e.g. 'system:scheduler', 'system:migration'
 * @returns {Promise<PrincipalRecord|null>}
 */
export async function getSystemPrincipal(displayName) {
  if (!displayName) return null;
  try {
    const { rows } = await db.query(
      `SELECT id, principal_type, display_name, status, auth_epoch,
              github_user_id, installation_id
         FROM gitwire_auth.auth_principals
        WHERE principal_type = 'system' AND display_name = $1`,
      [displayName]
    );
    if (rows.length === 0) return null;
    const r = rows[0];
    return {
      id: r.id,
      principalType: r.principal_type,
      displayName: r.display_name,
      status: r.status,
      authEpoch: Number(r.auth_epoch),
      githubUserId: null,
      installationId: null,
    };
  } catch (err) {
    logger.warn({ err, displayName }, "principalResolver: system load failed");
    throw err;
  }
}

/**
 * Check the fail-closed validity conditions for a resolved principal.
 * Returns a DecisionCode: ALLOWED if the principal is usable, otherwise the
 * specific denial code.
 * @param {PrincipalRecord|null} principal
 * @returns {string} a DecisionCode value
 */
export function principalValidityCode(principal) {
  if (!principal) return "unauthenticated";
  if (principal.status !== "active") return "principal_disabled";
  return "allowed";
}
