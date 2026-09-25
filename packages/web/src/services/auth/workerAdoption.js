// src/services/auth/workerAdoption.js
//
// Worker adoption wrapper (Wave 2 / issue #94; W1-04 enforcement cutover).
//
// Every BullMQ worker and scheduler calls this at its job-processing entry
// point to resolve a trusted server-side principal and build an immutable
// auth context. Queue payload fields never select principal identity.
//
// W1-04 keeps the established adoption seam but changes the exact bounded
// worker set below from observe-only authorization to enforced authorization.
// A controlled denial, missing durable decision evidence, or malformed control
// outcome stops the caller before its downstream effect.

import * as authorization from "./authorize.js";
import {
  resolveSystemWorkerContext,
  resolveInstallationWorkerContext,
} from "./workerContext.js";
import * as resources from "./resourceResolver.js";
import { createAuthorityContext } from "./context.js";
import { logger } from "../../lib/logger.js";

const ENFORCED_MODE = "enforced";

export const W1_04_ENFORCED_SURFACE_IDS = Object.freeze([
  "worker:issueFix",
  "worker:phase2",
  "worker:maintainer",
  "worker:phase3",
  "scheduled:reconciliation",
]);

const W1_04_ENFORCED_SURFACE_SET = new Set(W1_04_ENFORCED_SURFACE_IDS);

export function isW104EnforcedSurface(workerId) {
  return W1_04_ENFORCED_SURFACE_SET.has(workerId);
}

export class WorkerAuthorizationError extends Error {
  constructor(reason, { workerId, decisionCode = null } = {}) {
    super(`Worker authorization blocked (${reason})`);
    this.name = "WorkerAuthorizationError";
    this.reason = reason;
    this.workerId = workerId ?? null;
    this.decisionCode = decisionCode;
  }
}

function validateControlledOutcome(outcome, workerId) {
  const valid =
    outcome &&
    outcome.decision &&
    outcome.mode === ENFORCED_MODE &&
    typeof outcome.blocked === "boolean" &&
    outcome.blocked === !outcome.decision.allowed;

  if (!valid) {
    throw new WorkerAuthorizationError("invalid_authorization_outcome", { workerId });
  }

  if (outcome.persisted !== true) {
    throw new WorkerAuthorizationError("authorization_evidence_unavailable", {
      workerId,
      decisionCode: outcome.decision.code ?? null,
    });
  }

  if (outcome.blocked) {
    throw new WorkerAuthorizationError("authorization_denied", {
      workerId,
      decisionCode: outcome.decision.code ?? null,
    });
  }

  return outcome;
}

/**
 * Worker adoption wrapper. Resolves a trusted principal and resource, binds
 * them into one immutable authority context, then evaluates authorization.
 *
 * Non-W1-04 surfaces preserve the established observe-only behavior. The exact
 * W1-04 set is evaluated through authorizeControlled(..., mode='enforced') and
 * cannot return to the worker on deny or missing decision evidence.
 *
 * @param {object} opts
 * @param {string} opts.workerId       - protected runtime surface id
 * @param {string} opts.permission     - declared permission
 * @param {string} opts.resourceType   - declared resource type
 * @param {object} [opts.jobData]      - BullMQ job data
 * @param {string} [opts.systemPrincipalName] - for scheduled/autonomous workers
 * @param {number} [opts.installationId] - trusted installation lookup key
 * @param {string} [opts.legacyActor]  - non-authoritative compatibility metadata
 * @returns {Promise<{context: object|null, resource: object, authority: object, legacyActor: string, decision: object, authorizationOutcome: object|null}>}
 */
export async function adoptWorker({
  workerId,
  permission,
  resourceType,
  jobData = {},
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

  if (!context) {
    logger.warn({ workerId }, "adoptWorker: no principal resolved — recording gap");
  }

  // Resolve resource identity from server-owned state. Queue values are lookup
  // keys only. Maintainer jobs historically carry full_name rather than repo id,
  // so W1-04 resolves that name through the repositories table before enforcing.
  let resource;
  const payloadRepoId = jobData?.payload?.repository?.id || jobData?.repositoryId || null;
  const payloadRepoFullName = jobData?.repoFullName || null;
  const trustedInstId = context?.installationId || (installationId ? Number(installationId) : null);

  if (resourceType === "repository" && trustedInstId && payloadRepoId) {
    resource = await resources.resolveRepositoryResource(trustedInstId, Number(payloadRepoId));
    if (!resource) {
      resource = { type: "repository" };
      logger.warn(
        { workerId, installationId: trustedInstId, repositoryId: payloadRepoId },
        "adoptWorker: trusted repository lookup failed — resource will fail-closed",
      );
    }
  } else if (
    resourceType === "repository" &&
    trustedInstId &&
    payloadRepoFullName &&
    typeof resources.resolveRepositoryResourceByFullName === "function"
  ) {
    resource = await resources.resolveRepositoryResourceByFullName(trustedInstId, payloadRepoFullName);
    if (!resource) {
      resource = { type: "repository" };
      logger.warn(
        { workerId, installationId: trustedInstId, repoFullName: payloadRepoFullName },
        "adoptWorker: trusted repository full-name lookup failed — resource will fail-closed",
      );
    }
  } else if (
    workerId === "worker:phase3" &&
    resourceType === "installation" &&
    !trustedInstId &&
    Object.keys(jobData || {}).length === 0
  ) {
    // Phase 3 has three explicitly fleet-wide scheduled jobs whose job data is
    // empty at the current contract. Treat only that exact shape as fleet.
    // Installation-scoped/malformed jobs with data but no installation remain
    // an incomplete installation resource and therefore fail closed.
    resource = { type: "fleet" };
  } else {
    resource = { type: resourceType, installationId: trustedInstId };
  }

  const authority = createAuthorityContext({
    principal: context,
    resource,
    surfaceId: workerId,
  });

  let decision;
  let authorizationOutcome = null;

  if (isW104EnforcedSurface(workerId)) {
    if (typeof authorization.authorizeControlled !== "function") {
      throw new WorkerAuthorizationError("authorization_control_unavailable", { workerId });
    }

    authorizationOutcome = validateControlledOutcome(
      await authorization.authorizeControlled({
        principal: authority.principal,
        permission,
        resource: authority.resource,
        mode: ENFORCED_MODE,
      }),
      workerId,
    );
    decision = authorizationOutcome.decision;
  } else {
    decision = await authorization.authorize({
      principal: context,
      permission,
      resource,
    });
  }

  const actor = legacyActor || jobData?.triggeredBy || jobData?.actor || "worker";

  return {
    context,
    resource: authority.resource,
    authority,
    legacyActor: actor,
    decision,
    authorizationOutcome,
  };
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
