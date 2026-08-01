// src/services/governedPolicyService.js
// Governed Policy Authority — immutable policy versions and change-request state machine.
// GP-02 (issue #98).
//
// All writes go through SECURITY DEFINER functions (migration 045).
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
