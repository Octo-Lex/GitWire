// src/services/auth/observeAdopt.js
//
// Observe-only route adoption helper (Wave 2 / issue #94).
//
// Provides the `observeAuthorize` helper that routes call to compute + record
// an authoritative authorization decision WITHOUT blocking the existing
// legacy-authorized path. The decision (and any disagreement with legacy
// behavior) is recorded to auth_decision_log; the route proceeds regardless.
//
// This is the Wave 2 observe-only adoption seam. Wave 5 (enforcement cutover)
// will replace `observeAuthorize` with `enforceAuthorize` that blocks on deny.
//
// Usage in a route:
//   await observeAuthorize(req, {
//     permission: 'repository:github:act',
//     resource: { type: 'repository', installationId, repositoryId, organization, repository },
//     legacyActor,  // the legacy actor string (compatibility metadata)
//   });
//   // ... existing route logic proceeds unchanged ...

import { authorize } from "./authorize.js";
import { logDecision } from "./decisionLog.js";
import { logger } from "../../lib/logger.js";

/**
 * Compute + record an observe-only authorization decision. Does NOT block.
 *
 * @param {object} req - Express request (must have req.auth from authContext)
 * @param {object} opts
 * @param {string} opts.permission - the route's declared permission
 * @param {object} opts.resource - the resolved resource descriptor
 * @param {string} [opts.legacyActor] - the legacy actor string (for disagreement detection)
 * @returns {Promise<{allowed: boolean, code: string}>} the decision (for routes that want to inspect it)
 */
export async function observeAuthorize(req, { permission, resource, legacyActor }) {
  const principal = req.auth || null;

  try {
    const decision = await authorize({ principal, permission, resource });

    // Detect disagreement: legacy path would have allowed (the request reached
    // here through apiKeyAuth), but the authoritative decision denied.
    const legacyExpected = true; // observe-only: legacy path allowed the request
    const disagreement = legacyExpected && !decision.allowed;

    if (disagreement) {
      // Re-log with the disagreement flag + legacy context for review.
      await logDecision(decision, principal, { legacyExpected, disagreement });
      logger.info(
        {
          permission,
          code: decision.code,
          principalId: principal?.principalId ?? null,
          legacyActor: legacyActor ?? null,
          resource: resource?.type,
        },
        "observe-only: authoritative decision disagrees with legacy behavior"
      );
    }

    return { allowed: decision.allowed, code: decision.code };
  } catch (err) {
    // Fail-closed for the decision record, but observe-only does not block.
    logger.warn({ err, permission }, "observeAuthorize: error (observe-only, non-blocking)");
    return { allowed: false, code: "authorization_error" };
  }
}

/**
 * Extract the authoritative principal id from req.auth, falling back to null.
 * Use this in routes to populate principal_id on dual-write records.
 * @param {object} req
 * @returns {string|null}
 */
export function authoritativePrincipalId(req) {
  return req.auth?.principalId ?? null;
}

/**
 * Resolve the legacy actor string for compatibility metadata.
 * In Wave 2, the legacy actor (x-actor-login / req.body.actor) is retained
 * as non-authoritative display metadata. The principal_id is authoritative.
 *
 * @param {object} req
 * @param {string} [bodyActorField='actor'] - the body field name for the actor
 * @returns {string} the legacy actor string (or 'unknown')
 */
export function legacyActorString(req, bodyActorField = "actor") {
  return (
    req.headers["x-actor-login"] ||
    req.body?.[bodyActorField] ||
    req.body?.created_by ||
    "unknown"
  );
}
