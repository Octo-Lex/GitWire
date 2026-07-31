// src/services/governedPolicyService.js
// Governed Policy Authority — immutable policy versions and change-request state machine.
// GP-02 (issue #98).
//
// Provides:
//   createChangeRequest({ resourceType, resourceId, policyFamily, principalId })
//   createVersion({ changeRequestId, payload, principalId })
//   selectVersion({ changeRequestId, versionId, principalId })
//   submitChangeRequest({ changeRequestId, principalId })
//   transitionChangeRequest({ changeRequestId, toState, principalId, detail })
//   getChangeRequest({ changeRequestId })
//   listChangeRequests({ resourceType, resourceId, state, limit, offset })
//   getVersions({ changeRequestId })
//
// State machine:
//   draft → submitted → validating → awaiting_approval → approved → promoted
//      ↘ rejected, withdrawn, superseded, expired
//
// All transitions use CAS (state_revision) to prevent races.
// All writes go through the canonical INSERT/UPDATE paths granted in migration 045.
// Author identity is always server-owned (principalId from adoptWorker/authorize).

import { db } from "../lib/db.js";
import { logger } from "../lib/logger.js";
import crypto from "crypto";

// ════════════════════════════════════════════════════════════════════════════
// Valid state transitions
// ════════════════════════════════════════════════════════════════════════════

const VALID_TRANSITIONS = {
  draft:            new Set(["submitted", "withdrawn", "superseded"]),
  submitted:        new Set(["validating", "draft", "withdrawn"]),
  validating:       new Set(["awaiting_approval", "draft", "rejected"]),
  awaiting_approval: new Set(["approved", "rejected", "withdrawn", "superseded"]),
  approved:         new Set(["promoted", "withdrawn"]),
  promoted:         new Set([]),   // terminal
  rejected:         new Set([]),   // terminal
  withdrawn:        new Set([]),   // terminal
  superseded:       new Set([]),   // terminal
  expired:          new Set([]),   // terminal
};

const TERMINAL_STATES = new Set(["promoted", "rejected", "withdrawn", "superseded", "expired"]);

/**
 * Compute the canonical content hash of a policy payload.
 * Uses deterministic JSON serialization (sorted keys) + sha256.
 * @param {object} payload
 * @returns {string} sha256:<64hex>
 */
function computeContentHash(payload) {
  const canonical = JSON.stringify(payload, Object.keys(payload).sort());
  const hash = crypto.createHash("sha256").update(canonical).digest("hex");
  return "sha256:" + hash;
}

// ════════════════════════════════════════════════════════════════════════════
// Change request lifecycle
// ════════════════════════════════════════════════════════════════════════════

/**
 * Create a new policy change request in draft state.
 * @param {object} params
 * @param {string} params.resourceType - 'fleet' | 'organization' | 'repository'
 * @param {string} params.resourceId - normalized resource identifier
 * @param {string} params.policyFamily - policy family name
 * @param {string} params.principalId - server-owned author principal UUID
 * @returns {Promise<object>} the created change request row
 */
export async function createChangeRequest({ resourceType, resourceId, policyFamily, principalId }) {
  if (!resourceType || !resourceId || !policyFamily) {
    throw new Error("resourceType, resourceId, and policyFamily are required");
  }
  if (!principalId) {
    throw new Error("principalId is required (server-owned principal)");
  }
  if (!["fleet", "organization", "repository"].includes(resourceType)) {
    throw new Error("resourceType must be fleet, organization, or repository");
  }
  if (resourceType === "fleet" && resourceId !== "fleet") {
    throw new Error("fleet resource must use resourceId='fleet'");
  }
  if (resourceType !== "fleet" && resourceId === "fleet") {
    throw new Error("non-fleet resource must not use resourceId='fleet'");
  }

  const { rows: [row] } = await db.query(
    `INSERT INTO gitwire_policy.policy_change_requests
       (resource_type, resource_id, policy_family, author_principal_id)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [resourceType, resourceId, policyFamily, principalId]
  );

  // Record the initial transition event
  await db.query(
    `INSERT INTO gitwire_policy.policy_transition_events
       (change_request_id, event_type, from_state, to_state, actor_principal_id, detail)
     VALUES ($1, 'create', NULL, 'draft', $2, '{}'::jsonb)`,
    [row.id, principalId]
  );

  logger.info(
    { changeRequestId: row.id, resourceType, resourceId, policyFamily, principalId },
    "Governed policy change request created"
  );

  return row;
}

/**
 * Create a new immutable policy version for a change request.
 * The version is frozen at creation time — its content_hash is computed
 * from the payload and stored immutably.
 * @param {object} params
 * @param {string} params.changeRequestId
 * @param {object} params.payload - policy configuration object
 * @param {string} params.principalId - server-owned author principal UUID
 * @returns {Promise<object>} the created version row
 */
export async function createVersion({ changeRequestId, payload, principalId }) {
  if (!changeRequestId) throw new Error("changeRequestId is required");
  if (!payload || typeof payload !== "object") throw new Error("payload must be an object");
  if (!principalId) throw new Error("principalId is required");

  // Verify the change request exists and is in draft state
  const { rows: [cr] } = await db.query(
    "SELECT id, state FROM gitwire_policy.policy_change_requests WHERE id = $1",
    [changeRequestId]
  );
  if (!cr) throw new Error(`Change request not found: ${changeRequestId}`);
  if (cr.state !== "draft") {
    throw new Error(`Cannot create version for change request in state '${cr.state}' — only 'draft' accepts new versions`);
  }

  const contentHash = computeContentHash(payload);

  const { rows: [row] } = await db.query(
    `INSERT INTO gitwire_policy.policy_versions
       (change_request_id, payload, content_hash, author_principal_id)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [changeRequestId, JSON.stringify(payload), contentHash, principalId]
  );

  logger.info(
    { versionId: row.id, changeRequestId, contentHash, principalId },
    "Governed policy version created (frozen)"
  );

  return row;
}

/**
 * Select a version as the change request's target for promotion.
 * @param {object} params
 * @param {string} params.changeRequestId
 * @param {string} params.versionId - must belong to this change request
 * @param {string} params.principalId
 * @returns {Promise<object>} updated change request row
 */
export async function selectVersion({ changeRequestId, versionId, principalId }) {
  if (!changeRequestId || !versionId || !principalId) {
    throw new Error("changeRequestId, versionId, and principalId are required");
  }

  // Verify change request is in draft
  const { rows: [cr] } = await db.query(
    "SELECT id, state, state_revision FROM gitwire_policy.policy_change_requests WHERE id = $1",
    [changeRequestId]
  );
  if (!cr) throw new Error(`Change request not found: ${changeRequestId}`);
  if (cr.state !== "draft") {
    throw new Error(`Cannot select version in state '${cr.state}' — only 'draft'`);
  }

  // Verify version belongs to this change request (composite FK enforces this too)
  const { rows: [v] } = await db.query(
    "SELECT id FROM gitwire_policy.policy_versions WHERE id = $1 AND change_request_id = $2",
    [versionId, changeRequestId]
  );
  if (!v) throw new Error(`Version ${versionId} does not belong to change request ${changeRequestId}`);

  // CAS update: set selected_version_id
  const result = await casTransition(
    changeRequestId,
    cr.state,
    cr.state_revision,
    cr.state,  // stay in draft
    { selected_version_id: versionId }
  );

  await recordTransition(changeRequestId, cr.state, cr.state, "select_version", principalId, { versionId });

  return result;
}

/**
 * Submit a change request (draft → submitted).
 * Requires a selected version.
 * @param {object} params
 * @param {string} params.changeRequestId
 * @param {string} params.principalId
 * @returns {Promise<object>} updated change request row
 */
export async function submitChangeRequest({ changeRequestId, principalId }) {
  if (!changeRequestId || !principalId) {
    throw new Error("changeRequestId and principalId are required");
  }

  const { rows: [cr] } = await db.query(
    "SELECT id, state, state_revision, selected_version_id FROM gitwire_policy.policy_change_requests WHERE id = $1",
    [changeRequestId]
  );
  if (!cr) throw new Error(`Change request not found: ${changeRequestId}`);

  if (!cr.selected_version_id) {
    throw new Error("Cannot submit: no version selected");
  }

  assertValidTransition(cr.state, "submitted");

  const result = await casTransition(
    changeRequestId,
    cr.state,
    cr.state_revision,
    "submitted",
    { submitted_at: new Date().toISOString() }
  );

  await recordTransition(changeRequestId, cr.state, "submitted", "submit", principalId);

  return result;
}

/**
 * Generic state transition with CAS protection.
 * @param {object} params
 * @param {string} params.changeRequestId
 * @param {string} params.toState - target state
 * @param {string} params.principalId - actor principal
 * @param {object} [params.detail] - additional detail for the transition event
 * @returns {Promise<object>} updated change request row
 */
export async function transitionChangeRequest({ changeRequestId, toState, principalId, detail }) {
  if (!changeRequestId || !toState || !principalId) {
    throw new Error("changeRequestId, toState, and principalId are required");
  }

  const { rows: [cr] } = await db.query(
    "SELECT id, state, state_revision FROM gitwire_policy.policy_change_requests WHERE id = $1",
    [changeRequestId]
  );
  if (!cr) throw new Error(`Change request not found: ${changeRequestId}`);

  assertValidTransition(cr.state, toState);

  const result = await casTransition(
    changeRequestId,
    cr.state,
    cr.state_revision,
    toState,
    {}
  );

  await recordTransition(changeRequestId, cr.state, toState, "transition", principalId, detail || {});

  return result;
}

/**
 * Get a single change request by ID.
 */
export async function getChangeRequest({ changeRequestId }) {
  const { rows: [row] } = await db.query(
    "SELECT * FROM gitwire_policy.policy_change_requests WHERE id = $1",
    [changeRequestId]
  );
  return row || null;
}

/**
 * List change requests with optional filters.
 */
export async function listChangeRequests({ resourceType, resourceId, state, limit, offset } = {}) {
  const conditions = [];
  const params = [];
  let paramIdx = 1;

  if (resourceType) {
    params.push(resourceType);
    conditions.push(`resource_type = $${paramIdx++}`);
  }
  if (resourceId) {
    params.push(resourceId);
    conditions.push(`resource_id = $${paramIdx++}`);
  }
  if (state) {
    params.push(state);
    conditions.push(`state = $${paramIdx++}`);
  }

  const where = conditions.length ? "WHERE " + conditions.join(" AND ") : "";
  const lim = Math.min(limit || 50, 200);
  const off = offset || 0;

  const { rows } = await db.query(
    `SELECT * FROM gitwire_policy.policy_change_requests
     ${where}
     ORDER BY created_at DESC
     LIMIT $${paramIdx++} OFFSET $${paramIdx++}`,
    [...params, lim, off]
  );

  return rows;
}

/**
 * List all versions for a change request.
 */
export async function getVersions({ changeRequestId }) {
  const { rows } = await db.query(
    "SELECT * FROM gitwire_policy.policy_versions WHERE change_request_id = $1 ORDER BY created_at ASC",
    [changeRequestId]
  );
  return rows;
}

/**
 * Get all transition events for a change request (audit trail).
 */
export async function getTransitionEvents({ changeRequestId }) {
  const { rows } = await db.query(
    "SELECT * FROM gitwire_policy.policy_transition_events WHERE change_request_id = $1 ORDER BY occurred_at ASC",
    [changeRequestId]
  );
  return rows;
}

// ════════════════════════════════════════════════════════════════════════════
// Internal helpers
// ════════════════════════════════════════════════════════════════════════════

function assertValidTransition(fromState, toState) {
  const allowed = VALID_TRANSITIONS[fromState];
  if (!allowed) {
    throw new Error(`Cannot transition from terminal state '${fromState}'`);
  }
  if (!allowed.has(toState)) {
    throw new Error(`Invalid transition: '${fromState}' → '${toState}'. Allowed: ${[...allowed].join(", ")}`);
  }
}

async function casTransition(changeRequestId, expectedState, expectedRevision, newState, extraFields) {
  const setClauses = ["state = $1", "state_revision = state_revision + 1", "updated_at = now()"];
  const params = [newState];
  let paramIdx = 2;

  for (const [key, value] of Object.entries(extraFields)) {
    setClauses.push(`${key} = $${paramIdx++}`);
    params.push(value);
  }

  // CAS condition: state = expected AND state_revision = expected
  params.push(changeRequestId, expectedState, expectedRevision);

  const { rows, rowCount } = await db.query(
    `UPDATE gitwire_policy.policy_change_requests
     SET ${setClauses.join(", ")}
     WHERE id = $${paramIdx++}
       AND state = $${paramIdx++}
       AND state_revision = $${paramIdx++}
     RETURNING *`,
    params
  );

  if (rowCount === 0) {
    throw new Error(
      `CAS transition failed: change request ${changeRequestId} ` +
      `expected state='${expectedState}' revision=${expectedRevision} — ` +
      `another transition may have occurred concurrently`
    );
  }

  return rows[0];
}

async function recordTransition(changeRequestId, fromState, toState, eventType, principalId, detail) {
  await db.query(
    `INSERT INTO gitwire_policy.policy_transition_events
       (change_request_id, event_type, from_state, to_state, actor_principal_id, detail)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [changeRequestId, eventType, fromState, toState, principalId, JSON.stringify(detail || {})]
  );
}
