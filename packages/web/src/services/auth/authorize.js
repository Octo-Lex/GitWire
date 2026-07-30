// src/services/auth/authorize.js
//
// Central authorization service (Wave 2 / issue #94).
//
// The SINGLE authoritative runtime authorization interface. Every authorization
// decision in the application converges on `authorize()`. Route-local and
// worker-local role checks are prohibited.
//
// authorize() evaluates the PostgreSQL-backed role, permission, assignment,
// principal-status, and scope state created by Wave 1. It:
//   1. validates the principal (disabled → principal_disabled);
//   2. resolves the resource to server-owned identifiers (rejects unknown);
//   3. loads the principal's active role assignments whose scope encompasses
//      the resource;
//   4. checks whether any active assignment grants the required permission;
//   5. returns a stable structured decision with a stable code.
//
// Internal errors become fail-closed authorization_error (never implicit allow).
// All decisions are recorded to auth_decision_log (observe-only evidence).

import { db } from "../../lib/db.js";
import { logger } from "../../lib/logger.js";
import { createDecision } from "./context.js";
import { DecisionCode } from "./denialCodes.js";
import { getPrincipalById, principalValidityCode } from "./principalResolver.js";
import { logDecision } from "./decisionLog.js";

const POLICY_VERSION = "level1";

/**
 * The central authorization interface.
 *
 * @param {object} opts
 * @param {object} opts.principal - AuthContext (the resolved caller)
 * @param {string} opts.permission - required permission token '<resource_type>:<action>'
 * @param {object} opts.resource - Resource descriptor
 * @returns {Promise<Readonly<AuthorizationDecision>>}
 */
export async function authorize({ principal, permission, resource }) {
  // Defensive: a null principal (unauthenticated path) short-circuits.
  if (!principal || !principal.principalId) {
    return denyAndLog(DecisionCode.UNAUTHENTICATED, principal, permission, resource, null, null);
  }

  let principalRecord;
  try {
    principalRecord = await getPrincipalById(principal.principalId);
  } catch (err) {
    return denyAndLog(DecisionCode.AUTHORIZATION_ERROR, principal, permission, resource, null, null, err);
  }
  const vcode = principalValidityCode(principalRecord);
  if (vcode !== DecisionCode.ALLOWED) {
    return denyAndLog(vcode, principal, permission, resource, null, null);
  }

  // Resource validation: server-owned identifiers are mandatory for scoped
  // resources. Request-supplied names alone never establish scope.
  if (!resource || !resource.type) {
    return denyAndLog(DecisionCode.RESOURCE_MISSING, principal, permission, resource, null, null);
  }
  if (resource.type === "repository" && (!resource.installationId || !resource.repositoryId)) {
    return denyAndLog(DecisionCode.RESOURCE_UNKNOWN, principal, permission, resource, null, null);
  }
  if (resource.type === "installation" && !resource.installationId) {
    return denyAndLog(DecisionCode.RESOURCE_UNKNOWN, principal, permission, resource, null, null);
  }

  // Load the principal's active, non-expired, non-revoked role assignments
  // whose scope encompasses the resource. Scope resolution:
  //   fleet      → encompasses everything
  //   system     → fleet-wide system resources only (not installation-scoped)
  //   installation → must match resource.installationId
  //   repository → must match resource.installationId + repositoryId
  try {
    const { rows } = await db.query(
      `SELECT apr.id AS assignment_id, apr.scope_type, apr.scope_id,
              arp.permission
         FROM gitwire_auth.auth_principal_roles apr
         JOIN gitwire_auth.auth_role_permissions arp
           ON arp.role_id = apr.role_id
        WHERE apr.principal_id = $1
          AND apr.revoked_at IS NULL
          AND (apr.expires_at IS NULL OR apr.expires_at > now())
          AND arp.permission = $2
          AND (
                apr.scope_type = 'fleet'
             OR (apr.scope_type = 'system' AND $3::text IN ('system','fleet'))
             OR (apr.scope_type = 'installation' AND apr.scope_id = $4)
             OR (apr.scope_type = 'repository'  AND apr.scope_id = $5
                 AND apr.scope_id IN (
                   SELECT github_id FROM repositories WHERE github_id = $5
                 ))
              )`,
      [
        principal.principalId,
        permission,
        resource.type,
        resource.installationId ?? null,
        resource.repositoryId ?? null,
      ]
    );

    if (rows.length === 0) {
      const scopeRows = await db.query(
        `SELECT 1 FROM gitwire_auth.auth_principal_roles apr
          JOIN gitwire_auth.auth_role_permissions arp ON arp.role_id = apr.role_id
         WHERE apr.principal_id = $1 AND arp.permission = $2
           AND apr.revoked_at IS NULL
         LIMIT 1`,
        [principal.principalId, permission]
      );
      const code = scopeRows.rows.length > 0
        ? DecisionCode.SCOPE_MISMATCH
        : DecisionCode.PERMISSION_MISSING;
      return denyAndLog(code, principal, permission, resource, null, null);
    }

    const match = rows[0];
    const decision = createDecision({
      allowed: true,
      code: DecisionCode.ALLOWED,
      principalId: principal.principalId,
      permission,
      resource,
      matchedAssignmentId: match.assignment_id,
      matchedScopeType: match.scope_type,
      policyVersion: POLICY_VERSION,
      authenticationMethod: principal.authenticationMethod,
      detail: { matchCount: rows.length },
    });
    await logDecision(decision, principal);
    return decision;
  } catch (err) {
    logger.warn({ err, principalId: principal.principalId, permission }, "authorize: evaluation failed");
    return denyAndLog(DecisionCode.AUTHORIZATION_ERROR, principal, permission, resource, null, null, err);
  }
}

async function denyAndLog(code, principal, permission, resource, assignmentId, scopeType, err) {
  const decision = createDecision({
    allowed: false,
    code,
    principalId: principal?.principalId ?? null,
    permission,
    resource,
    matchedAssignmentId: assignmentId,
    matchedScopeType: scopeType,
    policyVersion: POLICY_VERSION,
    authenticationMethod: principal?.authenticationMethod ?? null,
    detail: err ? { error: err.message } : null,
  });
  await logDecision(decision, principal);
  return decision;
}
