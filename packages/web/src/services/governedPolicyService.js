// src/services/governedPolicyService.js
// Governed Policy Authority — immutable policy versions, change-request state machine,
// and approval rules with separation of duties.
// GP-02 (issue #98) + GP-03 (issue #99).
//
// All writes go through SECURITY DEFINER functions (migrations 045 + 046).
// The service layer provides the JS API and parameter validation.
// No direct INSERT/UPDATE is used — gitwire_app has EXECUTE on the functions only.

import { db } from "../lib/db.js";
import { logger } from "../lib/logger.js";

// ════════════════════════════════════════════════════════════════════════════
// Change request lifecycle (all writes via SECURITY DEFINER functions)
// ════════════════════════════════════════════════════════════════════════════

/**
 * Create a new policy change request in draft state.
 * Calls create_policy_change_request() SECURITY DEFINER function.
 */
export async function createChangeRequest({ resourceType, resourceId, policyFamily, principalId }) {
  if (!resourceType || !resourceId || !policyFamily) {
    throw new Error("resourceType, resourceId, and policyFamily are required");
  }
  if (!principalId) {
    throw new Error("principalId is required (server-owned principal)");
  }

  const { rows: [row] } = await db.query(
    "SELECT * FROM gitwire_policy.create_policy_change_request($1, $2, $3, $4)",
    [resourceType, resourceId, policyFamily, principalId]
  );

  // Fetch the full row (function returns uuid only)
  const { rows: [fullRow] } = await db.query(
    "SELECT * FROM gitwire_policy.policy_change_requests WHERE id = $1",
    [row.create_policy_change_request]
  );

  logger.info(
    { changeRequestId: fullRow.id, resourceType, resourceId, policyFamily, principalId },
    "Governed policy change request created"
  );

  return fullRow;
}

/**
 * Create a new immutable policy version.
 * Calls create_policy_version() SECURITY DEFINER function.
 * Content hash is computed inside the DB function (recursive canonical JSON).
 */
export async function createVersion({ changeRequestId, payload, principalId }) {
  if (!changeRequestId) throw new Error("changeRequestId is required");
  if (!payload || typeof payload !== "object") throw new Error("payload must be an object");
  if (!principalId) throw new Error("principalId is required");

  const { rows: [row] } = await db.query(
    "SELECT * FROM gitwire_policy.create_policy_version($1, $2, $3)",
    [changeRequestId, JSON.stringify(payload), principalId]
  );

  const { rows: [fullRow] } = await db.query(
    "SELECT * FROM gitwire_policy.policy_versions WHERE id = $1",
    [row.create_policy_version]
  );

  logger.info(
    { versionId: fullRow.id, changeRequestId, contentHash: fullRow.content_hash, principalId },
    "Governed policy version created (frozen)"
  );

  return fullRow;
}

/**
 * Select a version as the change request's target.
 * Calls select_policy_version() SECURITY DEFINER function with CAS.
 */
export async function selectVersion({ changeRequestId, versionId, principalId }) {
  if (!changeRequestId || !versionId || !principalId) {
    throw new Error("changeRequestId, versionId, and principalId are required");
  }

  // Get current revision for CAS
  const { rows: [cr] } = await db.query(
    "SELECT state, state_revision FROM gitwire_policy.policy_change_requests WHERE id = $1",
    [changeRequestId]
  );
  if (!cr) throw new Error(`Change request not found: ${changeRequestId}`);
  if (cr.state !== "draft") {
    throw new Error(`Cannot select version in state '${cr.state}' — only 'draft'`);
  }

  const { rows: [result] } = await db.query(
    "SELECT * FROM gitwire_policy.select_policy_version($1, $2, $3, $4)",
    [changeRequestId, versionId, cr.state_revision, principalId]
  );

  logger.info({ changeRequestId, versionId, principalId }, "Version selected");
  return result;
}

/**
 * Submit a change request (draft → submitted).
 * Calls submit_policy_change_request() SECURITY DEFINER function with CAS.
 */
export async function submitChangeRequest({ changeRequestId, principalId }) {
  if (!changeRequestId || !principalId) {
    throw new Error("changeRequestId and principalId are required");
  }

  // Get current revision for CAS
  const { rows: [cr] } = await db.query(
    "SELECT state, state_revision, selected_version_id FROM gitwire_policy.policy_change_requests WHERE id = $1",
    [changeRequestId]
  );
  if (!cr) throw new Error(`Change request not found: ${changeRequestId}`);

  if (!cr.selected_version_id) {
    throw new Error("Cannot submit: no version selected");
  }
  if (cr.state !== "draft") {
    throw new Error(`Invalid transition: '${cr.state}' → 'submitted'. Allowed: submitted, withdrawn, superseded`);
  }

  const { rows: [result] } = await db.query(
    "SELECT * FROM gitwire_policy.submit_policy_change_request($1, $2, $3)",
    [changeRequestId, cr.state_revision, principalId]
  );

  logger.info({ changeRequestId, principalId }, "Change request submitted");
  return result;
}

// ════════════════════════════════════════════════════════════════════════════
// Read-only helpers (use SELECT, no function needed)
// ════════════════════════════════════════════════════════════════════════════

export async function getChangeRequest({ changeRequestId }) {
  const { rows: [row] } = await db.query(
    "SELECT * FROM gitwire_policy.policy_change_requests WHERE id = $1",
    [changeRequestId]
  );
  return row || null;
}

export async function listChangeRequests({ resourceType, resourceId, state, limit, offset } = {}) {
  const conditions = [];
  const params = [];
  let paramIdx = 1;

  if (resourceType) { params.push(resourceType); conditions.push(`resource_type = $${paramIdx++}`); }
  if (resourceId) { params.push(resourceId); conditions.push(`resource_id = $${paramIdx++}`); }
  if (state) { params.push(state); conditions.push(`state = $${paramIdx++}`); }

  const where = conditions.length ? "WHERE " + conditions.join(" AND ") : "";
  const lim = Math.min(limit || 50, 200);
  const off = offset || 0;

  const { rows } = await db.query(
    `SELECT * FROM gitwire_policy.policy_change_requests ${where} ORDER BY created_at DESC LIMIT $${paramIdx++} OFFSET $${paramIdx++}`,
    [...params, lim, off]
  );
  return rows;
}

export async function getVersions({ changeRequestId }) {
  const { rows } = await db.query(
    "SELECT * FROM gitwire_policy.policy_versions WHERE change_request_id = $1 ORDER BY created_at ASC",
    [changeRequestId]
  );
  return rows;
}

export async function getTransitionEvents({ changeRequestId }) {
  const { rows } = await db.query(
    "SELECT * FROM gitwire_policy.policy_transition_events WHERE change_request_id = $1 ORDER BY occurred_at ASC",
    [changeRequestId]
  );
  return rows;
}

// ════════════════════════════════════════════════════════════════════════════
// GP-03: Approval rules, approvals, expiry, and separation of duties
// All writes via SECURITY DEFINER functions (migration 046).
// ════════════════════════════════════════════════════════════════════════════

/**
 * Create an immutable approval rule.
 * Calls create_policy_approval_rule() SECURITY DEFINER function.
 * Hash computed inside DB. rule_revision serialized via advisory lock.
 */
export async function createApprovalRule({ ruleVersion, policyFamily, resourceScopeType, resourceScopeId, riskClassification, requiredCount, requiredRoles, principalId, approvalTtlSeconds }) {
  if (!ruleVersion || !policyFamily || !resourceScopeType || !resourceScopeId || !riskClassification || !requiredCount || !requiredRoles || !principalId) {
    throw new Error("All required parameters must be provided");
  }

  const { rows: [row] } = await db.query(
    "SELECT gitwire_policy.create_policy_approval_rule($1, $2, $3, $4, $5, $6, $7, $8, $9) as id",
    [ruleVersion, policyFamily, resourceScopeType, resourceScopeId, riskClassification, requiredCount, JSON.stringify(requiredRoles), principalId, approvalTtlSeconds ?? null]
  );

  const { rows: [fullRow] } = await db.query(
    "SELECT * FROM gitwire_policy.policy_approval_rules WHERE id = $1",
    [row.id]
  );

  logger.info({ ruleId: fullRow.id, policyFamily, riskClassification, principalId }, "Approval rule created");
  return fullRow;
}

/**
 * Record an approval for a change request.
 * Calls record_policy_approval() SECURITY DEFINER function.
 * Server derives all authority fields from trusted state.
 */
export async function recordApproval({ changeRequestId, approvalRuleId, principalId }) {
  if (!changeRequestId || !approvalRuleId || !principalId) {
    throw new Error("changeRequestId, approvalRuleId, and principalId are required");
  }

  const { rows: [row] } = await db.query(
    "SELECT gitwire_policy.record_policy_approval($1, $2, $3) as id",
    [changeRequestId, approvalRuleId, principalId]
  );

  const { rows: [fullRow] } = await db.query(
    "SELECT * FROM gitwire_policy.policy_approvals WHERE id = $1",
    [row.id]
  );

  logger.info({ approvalId: fullRow.id, changeRequestId, approvalRuleId, principalId }, "Approval recorded");
  return fullRow;
}

/**
 * Revoke an approval. CAS on lifecycle revision.
 * Caller supplies the revision they observed — stale values map to 409.
 */
export async function revokeApproval({ approvalId, expectedLifecycleRevision, principalId, reason }) {
  if (!approvalId || expectedLifecycleRevision === undefined || !principalId || !reason) {
    throw new Error("approvalId, expectedLifecycleRevision, principalId, and reason are required");
  }

  await db.query(
    "SELECT gitwire_policy.revoke_policy_approval($1, $2, $3, $4)",
    [approvalId, expectedLifecycleRevision, principalId, reason]
  );

  logger.info({ approvalId, principalId, reason }, "Approval revoked");
  return { revoked: true, approvalId };
}

/**
 * Expire an approval past its TTL. CAS on lifecycle revision.
 * Caller supplies the revision they observed — stale values map to 409.
 */
export async function expireApproval({ approvalId, expectedLifecycleRevision, principalId }) {
  if (!approvalId || expectedLifecycleRevision === undefined || !principalId) {
    throw new Error("approvalId, expectedLifecycleRevision, and principalId are required");
  }

  await db.query(
    "SELECT gitwire_policy.expire_policy_approval($1, $2, $3)",
    [approvalId, expectedLifecycleRevision, principalId]
  );

  logger.info({ approvalId, principalId }, "Approval expired");
  return { expired: true, approvalId };
}

/**
 * Evaluate approval sufficiency for a change request.
 * Advisory read-only evaluation via SECURITY DEFINER function.
 */
export async function evaluateApprovals({ changeRequestId }) {
  if (!changeRequestId) throw new Error("changeRequestId is required");

  const { rows: [row] } = await db.query(
    "SELECT gitwire_policy.evaluate_approval_sufficiency($1) as result",
    [changeRequestId]
  );

  return row.result;
}

/**
 * Approve a change request (awaiting_approval → approved).
 * Atomic sufficiency evaluation + CAS transition.
 * Caller supplies expectedStateRevision — stale values map to 409.
 */
export async function approveChangeRequest({ changeRequestId, expectedStateRevision, principalId }) {
  if (!changeRequestId || expectedStateRevision === undefined || !principalId) {
    throw new Error("changeRequestId, expectedStateRevision, and principalId are required");
  }

  const { rows: [result] } = await db.query(
    "SELECT * FROM gitwire_policy.approve_policy_change_request($1, $2, $3)",
    [changeRequestId, expectedStateRevision, principalId]
  );

  logger.info({ changeRequestId, principalId, state: result.state }, "Change request approved");
  return result;
}

// ── Read helpers for GP-03 ────────────────────────────────────────────────

export async function getApprovalRules({ resourceScopeType, resourceScopeId, policyFamily } = {}) {
  const conditions = [];
  const params = [];
  let idx = 1;
  if (resourceScopeType) { params.push(resourceScopeType); conditions.push("resource_scope_type = $" + idx++); }
  if (resourceScopeId) { params.push(resourceScopeId); conditions.push("resource_scope_id = $" + idx++); }
  if (policyFamily) { params.push(policyFamily); conditions.push("policy_family = $" + idx++); }
  const where = conditions.length ? "WHERE " + conditions.join(" AND ") : "";
  const { rows } = await db.query(
    "SELECT * FROM gitwire_policy.policy_approval_rules " + where + " ORDER BY rule_revision DESC",
    params
  );
  return rows;
}

export async function getApprovals({ changeRequestId }) {
  if (!changeRequestId) throw new Error("changeRequestId is required");
  const { rows } = await db.query(
    `SELECT pa.*,
       (SELECT pal.to_status FROM gitwire_policy.policy_approval_lifecycle pal
        WHERE pal.approval_id = pa.id
          AND pal.lifecycle_revision = (SELECT max(lifecycle_revision) FROM gitwire_policy.policy_approval_lifecycle WHERE approval_id = pa.id)
       ) as latest_status,
       (SELECT max(lifecycle_revision) FROM gitwire_policy.policy_approval_lifecycle WHERE approval_id = pa.id) as latest_revision
     FROM gitwire_policy.policy_approvals pa
     JOIN gitwire_policy.policy_versions v ON pa.version_id = v.id
     WHERE v.change_request_id = $1
     ORDER BY pa.created_at ASC`,
    [changeRequestId]
  );
  return rows;
}
