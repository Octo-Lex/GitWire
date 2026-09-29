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
import {
  AuthorizationMode,
  createAuthorizationOutcome,
  normalizeAuthorizationMode,
} from "./authorizationMode.js";

const POLICY_VERSION = "level1";

export { AuthorizationMode };

/**
 * The persistence-aware authorization interface used by observation seams that
 * must distinguish a recorded decision from best-effort logging failure.
 *
 * Authority-sensitive effects may provide their transaction client as
 * `queryable` and set `lockAuthorityRows`. A positive decision then takes
 * shared locks on the principal, matching assignment, role, and role-permission rows;
 * PostgreSQL holds those locks until the caller's transaction completes. This
 * serializes disable/revoke/role-retirement/permission-removal against the protected effect.
 * In lock mode authorization decisions are written through that same transaction
 * client, so protected state/allow evidence and denial evidence never require a
 * second pool checkout while the authority-holding transaction is open.
 * Assignment expiry in lock mode is evaluated against PostgreSQL wall-clock
 * time rather than transaction-start time, so time spent waiting on a caller's
 * serialization lock cannot keep an already-expired assignment authoritative.
 * Non-lock denials retain the established independent best-effort logging path.
 *
 * @param {object} opts
 * @param {object} opts.principal - AuthContext (the resolved caller)
 * @param {string} opts.permission - required permission token '<resource_type>:<action>'
 * @param {object} opts.resource - Resource descriptor
 * @param {boolean} [opts.observeMode]
 * @param {{query: Function}} [opts.queryable]
 * @param {boolean} [opts.lockAuthorityRows]
 * @returns {Promise<{decision: Readonly<AuthorizationDecision>, persisted: boolean}>}
 */
export async function authorizeWithPersistence({
  principal,
  permission,
  resource,
  observeMode = true,
  queryable = db,
  lockAuthorityRows = false,
}) {
  // Defensive: a null principal (unauthenticated path) short-circuits.
  if (!principal || !principal.principalId) {
    return denyAndLog(DecisionCode.UNAUTHENTICATED, principal, permission, resource, null, null, undefined, observeMode);
  }

  // Shared authority-row locks only have the intended lifetime when the caller
  // owns an explicit transaction. Refuse the global pool wrapper in lock mode
  // rather than creating a false current-at-commit guarantee.
  if (!queryable || typeof queryable.query !== "function"
      || (lockAuthorityRows && queryable === db)) {
    return denyAndLog(
      DecisionCode.AUTHORIZATION_ERROR,
      principal,
      permission,
      resource,
      null,
      null,
      new Error(lockAuthorityRows
        ? "authority_lock_requires_transaction_queryable"
        : "authorization_queryable_invalid"),
      observeMode,
    );
  }

  let principalRecord;
  try {
    principalRecord = await getPrincipalById(principal.principalId, {
      queryable,
      lockAuthorityRows,
    });
  } catch (err) {
    return denyAndLog(DecisionCode.AUTHORIZATION_ERROR, principal, permission, resource, null, null, err, observeMode, lockAuthorityRows ? queryable : undefined);
  }
  const vcode = principalValidityCode(principalRecord);
  if (vcode !== DecisionCode.ALLOWED) {
    return denyAndLog(vcode, principal, permission, resource, null, null, undefined, observeMode, lockAuthorityRows ? queryable : undefined);
  }

  // Resource validation: server-owned identifiers are mandatory for scoped
  // resources. Request-supplied names alone never establish scope.
  if (!resource || !resource.type) {
    return denyAndLog(DecisionCode.RESOURCE_MISSING, principal, permission, resource, null, null, undefined, observeMode, lockAuthorityRows ? queryable : undefined);
  }
  if (resource.type === "repository" && (!resource.installationId || !resource.repositoryId)) {
    return denyAndLog(DecisionCode.RESOURCE_UNKNOWN, principal, permission, resource, null, null, undefined, observeMode, lockAuthorityRows ? queryable : undefined);
  }
  if (resource.type === "installation" && !resource.installationId) {
    return denyAndLog(DecisionCode.RESOURCE_UNKNOWN, principal, permission, resource, null, null, undefined, observeMode, lockAuthorityRows ? queryable : undefined);
  }

  // Load the principal's active, non-expired, non-revoked role assignments
  // whose scope encompasses the resource. Scope resolution:
  //   fleet      → encompasses everything
  //   system     → fleet-wide system resources only (not installation-scoped)
  //   installation → must match resource.installationId
  //   repository → must match resource.installationId + repositoryId
  try {
    const authorityLockClause = lockAuthorityRows ? " FOR SHARE OF apr, ar, arp" : "";
    const assignmentExpiryClock = lockAuthorityRows ? "clock_timestamp()" : "now()";
    const { rows } = await queryable.query(
      `SELECT apr.id AS assignment_id, apr.scope_type, apr.scope_id,
              arp.permission
         FROM gitwire_auth.auth_principal_roles apr
         JOIN gitwire_auth.auth_roles ar ON ar.id = apr.role_id AND ar.status = 'active'
         JOIN gitwire_auth.auth_role_permissions arp ON arp.role_id = ar.id
        WHERE apr.principal_id = $1
          AND apr.revoked_at IS NULL
          AND (apr.expires_at IS NULL OR apr.expires_at > ${assignmentExpiryClock})
          AND arp.permission = $2
          AND (
                apr.scope_type = 'fleet'
             OR (apr.scope_type = 'system' AND $3::text IN ('system','fleet'))
             OR (apr.scope_type = 'installation' AND apr.scope_id = $4)
             OR (apr.scope_type = 'repository'  AND apr.scope_id = $5
                 AND apr.scope_id IN (
                   SELECT github_id FROM repositories WHERE github_id = $5
                 ))
              )${authorityLockClause}`,
      [
        principal.principalId,
        permission,
        resource.type,
        resource.installationId ?? null,
        resource.repositoryId ?? null,
      ]
    );

    if (rows.length === 0) {
      const scopeRows = await queryable.query(
        `SELECT 1 FROM gitwire_auth.auth_principal_roles apr
          JOIN gitwire_auth.auth_roles ar ON ar.id = apr.role_id AND ar.status = 'active' JOIN gitwire_auth.auth_role_permissions arp ON arp.role_id = ar.id
         WHERE apr.principal_id = $1 AND arp.permission = $2
           AND apr.revoked_at IS NULL
           AND (apr.expires_at IS NULL OR apr.expires_at > ${assignmentExpiryClock})
         LIMIT 1`,
        [principal.principalId, permission]
      );
      const code = scopeRows.rows.length > 0
        ? DecisionCode.SCOPE_MISMATCH
        : DecisionCode.PERMISSION_MISSING;
      return denyAndLog(code, principal, permission, resource, null, null, undefined, observeMode, lockAuthorityRows ? queryable : undefined);
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
    const persisted = await logDecision(
      decision,
      principal,
      { observeMode },
      lockAuthorityRows ? queryable : db,
    );
    return { decision, persisted };
  } catch (err) {
    logger.warn({ err, principalId: principal.principalId, permission }, "authorize: evaluation failed");
    return denyAndLog(DecisionCode.AUTHORIZATION_ERROR, principal, permission, resource, null, null, err, observeMode, lockAuthorityRows ? queryable : undefined);
  }
}

async function denyAndLog(code, principal, permission, resource, assignmentId, scopeType, err, observeMode = true, queryable) {
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
  const persisted = await logDecision(decision, principal, { observeMode }, ...(queryable ? [queryable] : []));
  return { decision, persisted };
}

/**
 * W1-02 transport-neutral authorization control. The policy decision remains
 * unchanged; mode decides whether a denied decision is advisory (`observe`) or
 * requires the caller to stop before its protected effect (`enforced`).
 *
 * Invalid modes are rejected before authorization evaluation so a misspelled
 * enforcement request cannot silently become an observed decision.
 *
 * @param {object} opts
 * @param {object|null} opts.principal
 * @param {string} opts.permission
 * @param {object} opts.resource
 * @param {"observe"|"enforced"} [opts.mode]
 * @param {{query: Function}} [opts.queryable]
 * @param {boolean} [opts.lockAuthorityRows]
 * @returns {Promise<Readonly<{decision: Readonly<AuthorizationDecision>, persisted: boolean, mode: string, blocked: boolean}>>}
 */
export async function authorizeControlled({
  principal,
  permission,
  resource,
  mode = AuthorizationMode.OBSERVE,
  queryable = db,
  lockAuthorityRows = false,
}) {
  const normalizedMode = normalizeAuthorizationMode(mode);
  const result = await authorizeWithPersistence({
    principal,
    permission,
    resource,
    observeMode: normalizedMode === AuthorizationMode.OBSERVE,
    queryable,
    lockAuthorityRows,
  });
  return createAuthorizationOutcome({ ...result, mode: normalizedMode });
}

/** Preserve the established decision-only contract for all existing callers. */
export async function authorize(opts) {
  const { decision } = await authorizeWithPersistence(opts);
  return decision;
}
