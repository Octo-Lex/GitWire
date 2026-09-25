// Observe-only route adoption helper (Wave 2 / issue #94).
// Records authoritative decisions without blocking legacy-authorized requests.
// Wave 5 replaces this seam with blocking enforcement.

import { authorize } from "./authorize.js";
import { logDecision } from "./decisionLog.js";
import { logger } from "../../lib/logger.js";

const RESOURCE_IDENTITY_FIELDS = Object.freeze([
  "type",
  "installationId",
  "repositoryId",
  "organization",
  "repository",
  "resourceId",
]);

function sameResourceIdentity(a, b) {
  return RESOURCE_IDENTITY_FIELDS.every((field) => (a?.[field] ?? null) === (b?.[field] ?? null));
}

/**
 * Observe authorization without blocking. Reuse a persisted declaration
 * decision only when permission and normalized resource identity match.
 */
export async function observeAuthorize(req, { permission, resource, legacyActor }) {
  const declarationDecision = req._wave2DeclarationDecision;
  if (
    req._wave2DeclarationObserved &&
    declarationDecision &&
    declarationDecision.permission === permission &&
    sameResourceIdentity(declarationDecision.resource, resource)
  ) {
    return { allowed: declarationDecision.allowed, code: declarationDecision.code };
  }

  const principal = req.auth || null;

  // Mark this request as explicitly observed so any downstream observer does
  // not record it again. routeAuthObserver normally runs before route handlers;
  // this remains for explicitly adopted paths invoked in other compositions.
  req._wave2Observed = true;

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
