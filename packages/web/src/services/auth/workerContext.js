// src/services/auth/workerContext.js
//
// Worker/job auth context factory (Wave 2 / issue #94).
//
// Builds immutable server-derived auth contexts for background execution paths
// (workers, schedulers, webhook handlers, Telegram-triggered actions).
//
// SECURITY: worker contexts are NEVER derived from queue payloads, request
// headers, usernames, or free-form actor strings. The principal is resolved
// server-side based on the worker's trusted role (system principal, service
// principal, or installation principal from the signature-verified webhook).
//
// For human-triggered background actions (e.g. a webhook comment command), the
// principal is the INSTALLATION principal (the GitHub App acting on behalf of
// the installation), NOT the comment author. The comment author is retained
// as non-authoritative display metadata.

import { createContext } from "./context.js";
import { getSystemPrincipal, getInstallationPrincipal } from "./principalResolver.js";
import { logger } from "../../lib/logger.js";

// Cache of resolved system principals by display name (avoid repeated DB lookups).
const _systemCache = new Map();

/**
 * Resolve a system principal for a trusted autonomous task (scheduler,
 * reconciliation, maintenance). The display_name identifies which system
 * principal (e.g. 'system:scheduler', 'system:migration').
 *
 * @param {string} displayName
 * @returns {Promise<object|null>} AuthContext, or null if the system principal
 *   does not exist (the caller should handle this — typically by creating it
 *   on first use or logging a configuration warning).
 */
export async function resolveSystemWorkerContext(displayName) {
  if (!displayName) return null;

  let principal = _systemCache.get(displayName);
  if (!principal) {
    principal = await getSystemPrincipal(displayName);
    if (principal) {
      _systemCache.set(displayName, principal);
    }
  }

  if (!principal) {
    logger.warn({ displayName }, "workerContext: system principal not found");
    return null;
  }

  return createContext({
    principalId: principal.id,
    principalType: principal.principalType,
    sessionId: null,
    credentialId: null,
    authenticationMethod: "system",
    assuranceLevel: "level1",
    authEpoch: principal.authEpoch,
    installationId: null,
    githubUserId: null,
  });
}

/**
 * Resolve an installation principal for webhook-driven execution. The
 * installation_id comes from the signature-verified webhook payload (trusted),
 * NOT from a request body or queue field.
 *
 * @param {number} installationId - from the HMAC-verified webhook payload
 * @returns {Promise<object|null>} AuthContext, or null if the installation
 *   principal does not exist yet.
 */
export async function resolveInstallationWorkerContext(installationId) {
  if (!installationId) return null;

  const principal = await getInstallationPrincipal(installationId);
  if (!principal) {
    logger.warn({ installationId }, "workerContext: installation principal not found");
    return null;
  }

  return createContext({
    principalId: principal.id,
    principalType: principal.principalType,
    sessionId: null,
    credentialId: null,
    authenticationMethod: "webhook_hmac",
    assuranceLevel: "level1",
    authEpoch: principal.authEpoch,
    installationId: principal.installationId,
    githubUserId: null,
  });
}

/**
 * Build a worker auth context for a webhook-originated job. The installation
 * principal is resolved from the trusted installation_id; the sender/login
 * from the payload is retained ONLY as non-authoritative metadata (returned
 * separately, never as part of the auth context).
 *
 * @param {object} jobData - the BullMQ job payload
 * @param {string} [senderLogin] - the webhook sender's login (metadata only)
 * @returns {Promise<{context: object|null, legacyActor: string}>}
 */
export async function resolveWebhookWorkerContext(jobData, senderLogin) {
  const installationId = jobData?.installationId || jobData?.payload?.installation?.id;
  const context = await resolveInstallationWorkerContext(installationId);
  // The sender login is explicitly non-authoritative — it's compatibility
  // metadata for audit display, never used for authorization.
  return {
    context,
    legacyActor: senderLogin || "webhook",
  };
}

/**
 * Clear the system principal cache (for testing).
 */
export function _clearCache() {
  _systemCache.clear();
}
