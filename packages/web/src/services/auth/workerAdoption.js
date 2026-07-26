// src/services/auth/workerAdoption.js
//
// Worker adoption wrapper (Wave 2 / issue #94).
//
// Every BullMQ worker and scheduler calls this at its job-processing entry
// point to resolve a trusted server-side principal and build an immutable
// auth context. The context is then passed to authorize() and to persistence
// writers (principal_id dual-write).
//
// SECURITY: the principal is resolved from:
//   - installation_id (for webhook-originated jobs) — trusted because the
//     webhook ingress verified the HMAC signature before enqueuing;
//   - a system principal display_name (for scheduled/autonomous jobs) —
//     trusted because it is a server-side constant, not from the payload.
//
// Queue payload fields CANNOT select or override principalId, principalType,
// authEpoch, or assurance. The sender/actor in the payload is retained only
// as non-authoritative compatibility metadata.

import { authorize } from "./authorize.js";
import { logDecision } from "./decisionLog.js";
import {
  resolveSystemWorkerContext,
  resolveInstallationWorkerContext,
} from "./workerContext.js";
import { logger } from "../../lib/logger.js";

/**
 * Worker adoption wrapper. Resolves a trusted principal, calls authorize()
 * (observe-only), and returns the context + legacy actor for the worker to
 * pass to persistence writers.
 *
 * @param {object} opts
 * @param {string} opts.workerId       - the worker's surface id (e.g. 'worker:triage')
 * @param {string} opts.permission     - the declared permission
 * @param {string} opts.resourceType   - the declared resource type
 * @param {object} opts.jobData        - the BullMQ job data
 * @param {string} [opts.systemPrincipalName] - for scheduled/autonomous workers
 * @param {number} [opts.installationId] - for installation-scoped workers (from trusted source)
 * @param {string} [opts.legacyActor]  - non-authoritative actor metadata from payload
 * @returns {Promise<{context: object|null, legacyActor: string, decision: object}>}
 */
export async function adoptWorker({
  workerId,
  permission,
  resourceType,
  jobData,
  systemPrincipalName,
  installationId,
  legacyActor,
}) {
  let context = null;

  // Resolve the principal from trusted server-side sources ONLY.
  if (systemPrincipalName) {
    context = await resolveSystemWorkerContext(systemPrincipalName);
  } else if (installationId || jobData?.installationId || jobData?.payload?.installation?.id) {
    const instId = installationId || jobData?.installationId || jobData?.payload?.installation?.id;
    context = await resolveInstallationWorkerContext(Number(instId));
  }

  // If no principal could be resolved, record a fail-closed decision and
  // proceed with a null context (observe-only: the worker still runs, but
  // the decision log records the gap).
  if (!context) {
    logger.warn({ workerId }, "adoptWorker: no principal resolved — recording gap");
  }

  // Build the resource descriptor from trusted job data (not from actor fields).
  // Repository IDs come from the webhook-verified payload (repository.id),
  // NOT from any client-supplied field.
  const trustedRepoId = jobData?.payload?.repository?.id || jobData?.repositoryId || null;
  const resource = {
    type: resourceType,
    installationId: context?.installationId || (installationId ? Number(installationId) : null),
    repositoryId: resourceType === "repository" ? Number(trustedRepoId) : null,
  };

  // Call authorize() once (observe-only: records decision, does not block).
  const decision = await authorize({
    principal: context,
    permission,
    resource,
  });

  const actor = legacyActor || jobData?.triggeredBy || jobData?.actor || "worker";

  return { context, legacyActor: actor, decision };
}

/**
 * Extract the principalId from a resolved worker context, for dual-write.
 * Returns null if no context was resolved (observable compatibility gap).
 * @param {object|null} context
 * @returns {string|null}
 */
export function workerPrincipalId(context) {
  return context?.principalId ?? null;
}
