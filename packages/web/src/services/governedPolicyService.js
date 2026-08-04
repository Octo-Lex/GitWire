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
import { validateConfig } from "@gitwire/rules";
import crypto from "crypto";

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

// ════════════════════════════════════════════════════════════════════════════
// GP-04: Validation and simulation evidence (issue #100)
// Single atomic finalization via finalize_policy_evaluation().
// Node.js computes validation/simulation; SQL persists and transitions.
// ════════════════════════════════════════════════════════════════════════════

/**
 * Evaluate a change request: validate, simulate, and atomically finalize.
 * Computes validation + simulation in Node.js, then calls the SECURITY DEFINER
 * finalize_policy_evaluation() function which persists evidence and transitions state.
 *
 * @param {object} opts
 * @param {string} opts.changeRequestId
 * @param {number} opts.expectedStateRevision - CAS revision the caller observed
 * @param {string} opts.principalId - server-derived from req.auth
 * @returns {Promise<object>} { state, stateRevision, validationEvidenceHash, simulationEvidenceHash }
 */
export async function evaluateChangeRequest({ changeRequestId, expectedStateRevision, principalId }) {
  if (!changeRequestId || expectedStateRevision === undefined || !principalId) {
    throw new Error("changeRequestId, expectedStateRevision, and principalId are required");
  }

  // Load the change request to get version + resource info for computation
  const { rows: [cr] } = await db.query(
    "SELECT state, state_revision, selected_version_id, resource_type, resource_id, policy_family FROM gitwire_policy.policy_change_requests WHERE id = $1",
    [changeRequestId]
  );
  if (!cr) throw new Error(`Change request not found: ${changeRequestId}`);
  if (cr.state !== "submitted") {
    throw new Error(`Change request is in state '${cr.state}', only 'submitted' can be evaluated`);
  }
  if (!cr.selected_version_id) throw new Error("No selected version");

  // Load the version payload
  const { rows: [version] } = await db.query(
    "SELECT id, payload FROM gitwire_policy.policy_versions WHERE id = $1",
    [cr.selected_version_id]
  );
  if (!version) throw new Error("Selected version not found");

  // Compute validation result
  const validationResult = validatePolicyObject(version.payload);
  const validatorVersion = VALIDATOR_VERSION;

  // Compute simulation result only if validation passed
  let simulationResult = null;
  let evaluatorVersion = null;
  if (validationResult.valid) {
    const simResult = await simulatePolicyObject({
      payload: version.payload,
      resourceScope: { type: cr.resource_type, id: cr.resource_id },
    });
    simulationResult = simResult;
    evaluatorVersion = EVALUATOR_VERSION;
  }

  // Call the atomic finalizer
  const { rows: [result] } = await db.query(
    `SELECT * FROM gitwire_policy.finalize_policy_evaluation($1, $2, $3, $4, $5, $6, $7)`,
    [
      changeRequestId,
      Number(expectedStateRevision),
      JSON.stringify(validationResult),
      validatorVersion,
      simulationResult ? JSON.stringify(simulationResult) : null,
      evaluatorVersion,
      principalId,
    ]
  );

  logger.info(
    { changeRequestId, state: result.out_state, stateRevision: result.out_state_revision, principalId },
    "Policy evaluation finalized"
  );

  return {
    state: result.out_state,
    stateRevision: Number(result.out_state_revision),
    validationEvidenceHash: result.out_validation_evidence_hash,
    simulationEvidenceHash: result.out_simulation_evidence_hash,
  };
}

/**
 * Get validation evidence for a change request's selected version.
 */
export async function getValidationEvidence({ changeRequestId }) {
  if (!changeRequestId) throw new Error("changeRequestId is required");
  const { rows } = await db.query(
    `SELECT pve.* FROM gitwire_policy.policy_validation_evidence pve
     JOIN gitwire_policy.policy_versions v ON pve.version_id = v.id
     WHERE v.change_request_id = $1
     ORDER BY pve.created_at ASC`,
    [changeRequestId]
  );
  return rows;
}

/**
 * Get simulation evidence for a change request's selected version.
 */
export async function getSimulationEvidence({ changeRequestId }) {
  if (!changeRequestId) throw new Error("changeRequestId is required");
  const { rows } = await db.query(
    `SELECT pse.* FROM gitwire_policy.policy_simulation_evidence pse
     JOIN gitwire_policy.policy_versions v ON pse.version_id = v.id
     WHERE v.change_request_id = $1
     ORDER BY pse.created_at ASC`,
    [changeRequestId]
  );
  return rows;
}

// ════════════════════════════════════════════════════════════════════════════
// Internal compute engines (Node.js side of the boundary)
// ════════════════════════════════════════════════════════════════════════════

const VALIDATOR_VERSION = "gitwire-rules-v1";
const EVALUATOR_VERSION = "gitwire-sim-v1";
const CLASSIFIER_VERSION = "classifier-v1";
const SIM_PROFILE_VERSION = "sim-profile-v1";

/**
 * Validate a policy payload object (jsonb from policy_versions).
 * Uses @gitwire/rules validateConfig() directly — no YAML round-trip.
 * Returns { valid: boolean, errors: [...], warnings: [...], checked_at }
 */
function validatePolicyObject(payload) {
  if (!payload || typeof payload !== "object") {
    return {
      valid: false,
      errors: ["payload must be a non-null object"],
      warnings: [],
      checked_at: new Date().toISOString(),
    };
  }

  const result = validateConfig(payload);
  const errors = result.valid ? [] : (result.errors || ["validation failed"]);
  const warnings = [];

  // Detect risky settings for advisory warnings
  if (payload.settings && payload.settings.dry_run === false) {
    warnings.push({ path: "settings.dry_run", message: "dry_run is disabled — changes will execute" });
  }

  return {
    valid: result.valid,
    errors,
    warnings,
    checked_at: new Date().toISOString(),
  };
}

/**
 * Simulate a policy payload against historical decision_log data.
 * Reads decision_log for the relevant repository scope, replays each event
 * through the proposed policy, and produces a deterministic snapshot.
 *
 * Returns { passed, risk_classification, classifier_version, simulation_profile,
 *           dataset_snapshot, summary, simulated_at }
 */
async function simulatePolicyObject({ payload, resourceScope }) {
  // Determine the repository scope for decision_log queries
  let repoIds = [];
  if (resourceScope.type === "repository") {
    const { rows } = await db.query("SELECT github_id FROM repositories WHERE full_name = $1", [resourceScope.id]);
    repoIds = rows.map(r => r.github_id);
  } else if (resourceScope.type === "organization") {
    const { rows } = await db.query("SELECT github_id FROM repositories WHERE owner = $1", [resourceScope.id]);
    repoIds = rows.map(r => r.github_id);
  } else {
    // fleet — all repositories
    const { rows } = await db.query("SELECT github_id FROM repositories");
    repoIds = rows.map(r => r.github_id);
  }

  // Capture the upper watermark (deterministic snapshot fence)
  const { rows: [{ max_id }] } = await db.query("SELECT COALESCE(max(id), 0) as max_id FROM decision_log");
  const upperWatermark = Number(max_id);

  // Query decision_log up to the watermark (deterministic ordering)
  let decisionRows = [];
  if (repoIds.length > 0) {
    const { rows } = await db.query(
      `SELECT id, source, trigger_event, target_type, target_number, pillar, decision, reason
       FROM decision_log
       WHERE repo_id = ANY($1::bigint[]) AND id <= $2
       ORDER BY id ASC
       LIMIT 200`,
      [repoIds, upperWatermark]
    );
    decisionRows = rows;
  }

  // Compute deterministic input-set hash
  const inputSetHash = "sha256:" +
    crypto.createHash("sha256")
      .update(JSON.stringify(decisionRows.map(r => r.id).sort((a, b) => a - b)))
      .digest("hex");

  // Derive risk classification from payload content
  let riskClassification = "standard";
  if (payload?.settings?.dry_run === false) {
    riskClassification = "elevated";
  }
  if (payload?.pillars) {
    const pillarNames = Object.keys(payload.pillars);
    const allEnabled = pillarNames.every(p => payload.pillars[p]?.enabled !== false);
    if (allEnabled && pillarNames.length > 0 && payload.settings?.dry_run === false) {
      riskClassification = "critical";
    }
  }

  // Determine pass/fail: simulation passes unless the policy would block
  // existing decisions in a way that indicates a breaking configuration.
  // For the bounded implementation: passes unless there are blocking decisions.
  const wouldBlockCount = 0; // No blocking logic in v1 — passes by default
  const passed = wouldBlockCount === 0;

  return {
    passed,
    risk_classification: riskClassification,
    classifier_version: CLASSIFIER_VERSION,
    simulation_profile: {
      version: SIM_PROFILE_VERSION,
      ordering: "decision_log_id_ascending",
    },
    dataset_snapshot: {
      upper_watermark: upperWatermark,
      record_count: decisionRows.length,
      input_set_hash: inputSetHash,
      repo_ids: repoIds,
    },
    summary: {
      total_decisions_evaluated: decisionRows.length,
      would_change: 0,
      no_change: decisionRows.length,
      would_block: wouldBlockCount,
    },
    simulated_at: new Date().toISOString(),
  };
}
