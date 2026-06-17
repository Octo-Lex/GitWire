// src/services/policyRolloutService.js
// Policy rollout plan lifecycle management.
//
// Represents a proposed policy rollout with status, scope, approval state,
// and evidence. Does NOT automatically mutate policy or write to GitHub.
//
// State model:
//   draft → validated → review_ready → approved → promoted
//      ↘ cancelled
//   review_ready → rejected
//   promoted → rolled_back

import { db } from "../lib/db.js";
import { logger } from "../lib/logger.js";
import { redactSecrets } from "../lib/redact.js";
import { getConfigForRepo } from "./configService.js";
import { validatePolicy } from "./policyValidationService.js";

// ── Valid state transitions ──────────────────────────────────────────────────
const VALID_TRANSITIONS = {
  draft:        new Set(["validated", "cancelled"]),
  validated:    new Set(["review_ready", "cancelled"]),
  review_ready: new Set(["approved", "rejected", "cancelled"]),
  approved:     new Set(["promoted", "cancelled"]),
  promoted:     new Set(["rolled_back"]),
  rolled_back:  new Set(),   // terminal
  cancelled:    new Set(),   // terminal
  rejected:     new Set(),   // terminal
};

// ── Evidence required before approval ───────────────────────────────────────
const REQUIRED_EVIDENCE_FOR_APPROVAL = [
  "validation_result",
  "simulation_summary",
  "diff_impact_summary",
  "recommendations_summary",
];

// ── Allowed update fields per state ──────────────────────────────────────────
const REQUIRED_EVIDENCE = {
  review_ready: ["validation_result"],
  approved:     ["validation_result"],
  promoted:     ["validation_result"],
};

/**
 * Create a new rollout plan in draft state.
 *
 * @param {object} params
 * @param {string} params.repo           - repo full_name (required)
 * @param {object} params.proposed_config - proposed config object (required)
 * @param {string} params.created_by     - GitHub username (required)
 * @returns {Promise<object>} created rollout plan
 */
export async function createRolloutPlan(params = {}) {
  const { repo, proposed_config, created_by } = params;

  if (!repo) throw new Error("repo is required");
  if (!proposed_config || typeof proposed_config !== "object") {
    throw new Error("proposed_config is required (object)");
  }
  if (!created_by) throw new Error("created_by is required");

  // Resolve repo_id
  const { rows: [repoRow] } = await db.query(
    "SELECT github_id FROM repositories WHERE full_name = $1", [repo]
  );
  if (!repoRow) throw new Error(`Repository not found: ${repo}`);

  const normalizedConfig = redactSecrets(proposed_config);

  const { rows: [plan] } = await db.query(
    `INSERT INTO policy_rollout_plans (repo_id, proposed_config, normalized_config, created_by, status)
     VALUES ($1, $2, $3, $4, 'draft')
     RETURNING *`,
    [repoRow.github_id, proposed_config, normalizedConfig, created_by]
  );

  logger.info({ plan_id: plan.id, repo }, "Rollout plan created");
  return redactPlan(plan);
}

/**
 * Get a single rollout plan by ID.
 *
 * @param {number} id - plan ID
 * @returns {Promise<object|null>} rollout plan (redacted) or null
 */
export async function getRolloutPlan(id) {
  if (!id) throw new Error("id is required");

  const { rows: [plan] } = await db.query(
    "SELECT * FROM policy_rollout_plans WHERE id = $1", [id]
  );

  return plan ? redactPlan(plan) : null;
}

/**
 * List rollout plans with optional filters.
 *
 * @param {object} params
 * @param {string} [params.repo]       - filter by repo full_name
 * @param {string} [params.status]     - filter by status
 * @param {string} [params.created_by] - filter by creator
 * @param {number} [params.limit=50]   - max results
 * @param {number} [params.offset=0]   - pagination offset
 * @returns {Promise<{data: object[], total: number}>}
 */
export async function listRolloutPlans(params = {}) {
  const { repo, status, created_by, limit = 50, offset = 0 } = params;

  const conditions = [];
  const values = [];
  let paramIdx = 1;

  if (repo) {
    conditions.push(`r.full_name = $${paramIdx++}`);
    values.push(repo);
  }
  if (status) {
    conditions.push(`p.status = $${paramIdx++}`);
    values.push(status);
  }
  if (created_by) {
    conditions.push(`p.created_by = $${paramIdx++}`);
    values.push(created_by);
  }

  const whereClause = conditions.length > 0
    ? "WHERE " + conditions.join(" AND ")
    : "";

  // Join repositories for repo full_name
  const { rows: [countRow] } = await db.query(
    `SELECT COUNT(*) as total
     FROM policy_rollout_plans p
     LEFT JOIN repositories r ON r.github_id = p.repo_id
     ${whereClause}`,
    values
  );

  const { rows } = await db.query(
    `SELECT p.*, r.full_name as repo_full_name
     FROM policy_rollout_plans p
     LEFT JOIN repositories r ON r.github_id = p.repo_id
     ${whereClause}
     ORDER BY p.created_at DESC
     LIMIT $${paramIdx++} OFFSET $${paramIdx++}`,
    [...values, Math.min(limit, 200), offset]
  );

  return {
    data: rows.map(redactPlan),
    total: parseInt(countRow.total, 10),
  };
}

/**
 * Attach evidence (validation, simulation, diff, recommendations) to a plan.
 * Only allowed in draft or validated state.
 *
 * @param {number} id - plan ID
 * @param {object} evidence - { validation_result?, simulation_summary?, diff_impact_summary?, recommendations_summary? }
 * @returns {Promise<object>} updated plan
 */
export async function attachEvidence(id, evidence = {}) {
  if (!id) throw new Error("id is required");

  const { rows: [plan] } = await db.query(
    "SELECT * FROM policy_rollout_plans WHERE id = $1", [id]
  );
  if (!plan) throw new Error(`Rollout plan not found: ${id}`);

  if (plan.status !== "draft" && plan.status !== "validated") {
    throw new Error(`Cannot attach evidence to plan in '${plan.status}' state`);
  }

  const updates = [];
  const values = [];
  let paramIdx = 1;

  const fields = [
    ["validation_result", evidence.validation_result],
    ["simulation_summary", evidence.simulation_summary],
    ["diff_impact_summary", evidence.diff_impact_summary],
    ["recommendations_summary", evidence.recommendations_summary],
  ];

  for (const [field, value] of fields) {
    if (value !== undefined) {
      updates.push(`${field} = $${paramIdx++}`);
      values.push(value);
    }
  }

  if (updates.length === 0) {
    throw new Error("No evidence fields provided");
  }

  values.push(id);

  const { rows: [updated] } = await db.query(
    `UPDATE policy_rollout_plans
     SET ${updates.join(", ")}
     WHERE id = $${paramIdx}
     RETURNING *`,
    values
  );

  logger.info({ plan_id: id }, "Evidence attached to rollout plan");
  return redactPlan(updated);
}

/**
 * Transition a rollout plan to a new status.
 *
 * Enforces valid state transitions and required evidence.
 *
 * @param {number} id - plan ID
 * @param {object} params
 * @param {string} params.status     - target status (required)
 * @param {string} [params.actor]    - GitHub username performing transition
 * @param {string} [params.review_notes] - optional notes
 * @returns {Promise<object>} updated plan
 */
export async function transitionRolloutPlan(id, params = {}) {
  const { status: targetStatus, actor, review_notes } = params;

  if (!id) throw new Error("id is required");
  if (!targetStatus) throw new Error("status is required");

  const { rows: [plan] } = await db.query(
    "SELECT * FROM policy_rollout_plans WHERE id = $1", [id]
  );
  if (!plan) throw new Error(`Rollout plan not found: ${id}`);

  const currentStatus = plan.status;

  // Check terminal states
  if (VALID_TRANSITIONS[currentStatus].size === 0) {
    throw new Error(`Plan is in terminal state '${currentStatus}' — no further transitions allowed`);
  }

  // Check valid transition
  if (!VALID_TRANSITIONS[currentStatus].has(targetStatus)) {
    throw new Error(
      `Invalid transition: '${currentStatus}' → '${targetStatus}'. ` +
      `Valid transitions from '${currentStatus}': ${[...VALID_TRANSITIONS[currentStatus]].join(", ")}`
    );
  }

  // Check required evidence
  const required = REQUIRED_EVIDENCE[targetStatus];
  if (required) {
    for (const field of required) {
      if (!plan[field]) {
        throw new Error(
          `Cannot transition to '${targetStatus}': missing required evidence '${field}'. ` +
          `Attach evidence first.`
        );
      }
    }
  }

  // Build update
  const updates = [`status = $1`];
  const values = [targetStatus];
  let paramIdx = 2;

  // Actor metadata per target state
  if (targetStatus === "approved") {
    if (!actor) throw new Error("actor is required for approval");
    updates.push(`approved_by = $${paramIdx++}`);
    values.push(actor);
    updates.push(`approved_at = $${paramIdx++}`);
    values.push(new Date().toISOString());
    // Block generic transition to approved without going through approveRolloutPlan
    throw new Error("Approval must go through POST /api/rollouts/:id/approve — use the approval endpoint");
  } else if (targetStatus === "rejected") {
    throw new Error("Rejection must go through POST /api/rollouts/:id/reject — use the rejection endpoint");
  } else if (targetStatus === "promoted") {
    if (!actor) throw new Error("actor is required for promotion");
    updates.push(`promoted_by = $${paramIdx++}`);
    values.push(actor);
    updates.push(`promoted_at = $${paramIdx++}`);
    values.push(new Date().toISOString());

    // Snapshot current policy for rollback
    try {
      const currentConfig = await getConfigForRepo(plan.repo_id);
      updates.push(`previous_config = $${paramIdx++}`);
      values.push(redactSecrets(currentConfig));
    } catch (err) {
      logger.warn({ err: err.message, plan_id: id }, "Could not snapshot current policy for rollback");
    }
  } else if (targetStatus === "rolled_back") {
    if (!actor) throw new Error("actor is required for rollback");
    updates.push(`rolled_back_by = $${paramIdx++}`);
    values.push(actor);
    updates.push(`rolled_back_at = $${paramIdx++}`);
    values.push(new Date().toISOString());
    if (!plan.previous_config) {
      throw new Error("Cannot roll back: no previous_config snapshot available");
    }
  } else if (targetStatus === "cancelled") {
    if (!actor) throw new Error("actor is required for cancellation");
    updates.push(`cancelled_by = $${paramIdx++}`);
    values.push(actor);
    updates.push(`cancelled_at = $${paramIdx++}`);
    values.push(new Date().toISOString());
  } else if (targetStatus === "rejected") {
    // handled by rejectRolloutPlan, not generic transition
  }

  if (review_notes) {
    updates.push(`review_notes = $${paramIdx++}`);
    values.push(review_notes);
  }

  values.push(id);

  const { rows: [updated] } = await db.query(
    `UPDATE policy_rollout_plans
     SET ${updates.join(", ")}
     WHERE id = $${paramIdx}
     RETURNING *`,
    values
  );

  logger.info({ plan_id: id, from: currentStatus, to: targetStatus, actor }, "Rollout plan transitioned");
  return redactPlan(updated);
}

/**
 * Approve a rollout plan.
 *
 * Enforces: must be in review_ready, all evidence attached, proposed policy
 * valid, critical recommendations acknowledged.
 *
 * @param {number} id - plan ID
 * @param {object} params
 * @param {string} params.actor - GitHub username (required)
 * @param {string} [params.reason] - approval reason
 * @param {string[]} [params.acknowledged_recommendations] - recommendation IDs acknowledged
 * @returns {Promise<object>} updated plan
 */
export async function approveRolloutPlan(id, params = {}) {
  const { actor, reason, acknowledged_recommendations = [] } = params;

  if (!id) throw new Error("id is required");
  if (!actor) throw new Error("actor is required for approval");

  const { rows: [plan] } = await db.query(
    "SELECT * FROM policy_rollout_plans WHERE id = $1", [id]
  );
  if (!plan) throw new Error(`Rollout plan not found: ${id}`);

  // Check state
  if (plan.status !== "review_ready") {
    throw new Error(`Cannot approve plan in '${plan.status}' state — must be 'review_ready'`);
  }

  // Check all evidence attached
  const missingEvidence = REQUIRED_EVIDENCE_FOR_APPROVAL.filter(f => !plan[f]);
  if (missingEvidence.length > 0) {
    throw new Error(
      `Cannot approve: missing required evidence: ${missingEvidence.join(", ")}. ` +
      `Attach all evidence before requesting approval.`
    );
  }

  // Check proposed policy is valid
  const validation = plan.validation_result;
  if (validation && validation.valid === false) {
    throw new Error("Cannot approve: proposed policy validation failed");
  }

  // Check critical recommendations acknowledged
  const recSummary = plan.recommendations_summary;
  const criticalRecs = getCriticalRecommendations(recSummary);
  const unacknowledged = criticalRecs.filter(rId => !acknowledged_recommendations.includes(rId));
  if (unacknowledged.length > 0) {
    throw new Error(
      `Cannot approve: ${unacknowledged.length} critical recommendation(s) not acknowledged: ${unacknowledged.join(", ")}. ` +
      `All critical recommendations must be explicitly acknowledged before approval.`
    );
  }

  // Build reviewed_evidence snapshot for audit
  const reviewedEvidence = {
    validation_attached: !!plan.validation_result,
    simulation_attached: !!plan.simulation_summary,
    diff_attached: !!plan.diff_impact_summary,
    recommendations_attached: !!plan.recommendations_summary,
    recommendation_counts: recSummary?.summary || { critical: 0, warning: 0, info: 0 },
    simulation_summary: plan.simulation_summary,
    diff_summary: plan.diff_impact_summary,
  };

  const { rows: [updated] } = await db.query(
    `UPDATE policy_rollout_plans
     SET status = 'approved',
         approved_by = $1,
         approved_at = $2,
         approval_reason = $3,
         acknowledged_recommendations = $4,
         reviewed_evidence = $5
     WHERE id = $6
     RETURNING *`,
    [actor, new Date().toISOString(), reason || null, acknowledged_recommendations, reviewedEvidence, id]
  );

  logger.info({ plan_id: id, actor, reason: !!reason }, "Rollout plan approved");
  return redactPlan(updated);
}

/**
 * Reject a rollout plan.
 *
 * Records rejection actor, timestamp, and reason. Transitions to rejected (terminal).
 *
 * @param {number} id - plan ID
 * @param {object} params
 * @param {string} params.actor - GitHub username (required)
 * @param {string} [params.reason] - rejection reason
 * @returns {Promise<object>} updated plan
 */
export async function rejectRolloutPlan(id, params = {}) {
  const { actor, reason } = params;

  if (!id) throw new Error("id is required");
  if (!actor) throw new Error("actor is required for rejection");

  const { rows: [plan] } = await db.query(
    "SELECT * FROM policy_rollout_plans WHERE id = $1", [id]
  );
  if (!plan) throw new Error(`Rollout plan not found: ${id}`);

  if (plan.status !== "review_ready") {
    throw new Error(`Cannot reject plan in '${plan.status}' state — must be 'review_ready'`);
  }

  const { rows: [updated] } = await db.query(
    `UPDATE policy_rollout_plans
     SET status = 'rejected',
         rejected_by = $1,
         rejected_at = $2,
         rejection_reason = $3
     WHERE id = $4
     RETURNING *`,
    [actor, new Date().toISOString(), reason || null, id]
  );

  logger.info({ plan_id: id, actor, reason: !!reason }, "Rollout plan rejected");
  return redactPlan(updated);
}

/**
 * Extract critical recommendation IDs from recommendations summary.
 */
function getCriticalRecommendations(recSummary) {
  if (!recSummary || !recSummary.recommendations) return [];
  return recSummary.recommendations
    .filter(r => r.severity === "critical")
    .map(r => r.id);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Redact secret-like values from a plan object.
 * Applies to all JSONB fields that may contain config.
 */
function redactPlan(plan) {
  if (!plan) return null;

  const redacted = { ...plan };

  const jsonbFields = [
    "proposed_config",
    "normalized_config",
    "validation_result",
    "simulation_summary",
    "diff_impact_summary",
    "recommendations_summary",
    "previous_config",
    "acknowledged_recommendations",
    "reviewed_evidence",
  ];

  for (const field of jsonbFields) {
    if (redacted[field] && typeof redacted[field] === "object") {
      redacted[field] = redactSecrets(redacted[field]);
    }
  }

  return redacted;
}

// Export for testing
export { VALID_TRANSITIONS, REQUIRED_EVIDENCE, REQUIRED_EVIDENCE_FOR_APPROVAL, redactPlan };
