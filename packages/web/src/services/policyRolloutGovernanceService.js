// W2-03 — governed rollout compatibility adapter.
//
// The rollout tables remain the compatibility/read model, while W2-01
// immutable authority is canonical for authorship, evidence, and decisions.
// Every compatibility write performed here shares the caller transaction with
// its immutable authority write so authority failure rolls the compatibility
// mutation back.

import { db } from "../lib/db.js";
import { redactSecrets } from "../lib/redact.js";
import {
  redactPlan,
  REQUIRED_EVIDENCE_FOR_APPROVAL,
} from "./policyRolloutService.js";
import {
  appendPolicyEvidenceForRollout,
  createPolicyChangeRequestForRollout,
  recordPolicyApprovalForRollout,
} from "./policyAuthorityService.js";

const EVIDENCE_FIELDS = Object.freeze([
  "validation_result",
  "simulation_summary",
  "diff_impact_summary",
  "recommendations_summary",
]);

export class PolicyRolloutGovernanceError extends Error {
  constructor(reason, detail = null) {
    super(reason);
    this.name = "PolicyRolloutGovernanceError";
    this.reason = reason;
    this.detail = detail;
  }
}

function requirePrincipal(principal) {
  if (!principal?.principalId) {
    throw new PolicyRolloutGovernanceError("authoritative_principal_required");
  }
}

function criticalRecommendationIds(summary) {
  if (!summary || !Array.isArray(summary.recommendations)) return [];
  return summary.recommendations
    .filter((item) => item?.severity === "critical")
    .map((item) => item?.id)
    .filter((id) => typeof id === "string" && id.length > 0);
}

function reviewedEvidenceSnapshot(plan) {
  return {
    validation_attached: !!plan.validation_result,
    simulation_attached: !!plan.simulation_summary,
    diff_attached: !!plan.diff_impact_summary,
    recommendations_attached: !!plan.recommendations_summary,
    recommendation_counts:
      plan.recommendations_summary?.summary || { critical: 0, warning: 0, info: 0 },
    simulation_summary: plan.simulation_summary,
    diff_summary: plan.diff_impact_summary,
  };
}

async function lockRollout(tx, rolloutPlanId) {
  const { rows: [plan] } = await tx.query(
    `SELECT *
       FROM policy_rollout_plans
      WHERE id = $1
      FOR UPDATE`,
    [rolloutPlanId],
  );
  if (!plan) {
    throw new PolicyRolloutGovernanceError("rollout_plan_not_found");
  }
  return plan;
}

/**
 * Create the compatibility rollout and immutable W2-01 policy authority in one
 * transaction. The active policy version is captured while holding a repository
 * lock that serializes against W2-02 promotion, preventing a stale/null base
 * snapshot from racing a live promotion.
 */
export async function createGovernedRolloutPlan({
  repo,
  proposedConfig,
  compatibilityActor = "unknown",
  principal,
} = {}) {
  if (!repo || typeof repo !== "string") {
    throw new PolicyRolloutGovernanceError("repo_required");
  }
  if (!proposedConfig || typeof proposedConfig !== "object" || Array.isArray(proposedConfig)) {
    throw new PolicyRolloutGovernanceError("proposed_config_required");
  }
  requirePrincipal(principal);

  return db.transaction(async (tx) => {
    const { rows: [repoRow] } = await tx.query(
      `SELECT github_id
         FROM repositories
        WHERE full_name = $1
        FOR SHARE`,
      [repo],
    );
    if (!repoRow) {
      throw new PolicyRolloutGovernanceError("repository_not_found", repo);
    }

    const { rows: [binding] } = await tx.query(
      `SELECT policy_version_id
         FROM active_policy_bindings
        WHERE repo_id = $1`,
      [repoRow.github_id],
    );
    const basePolicyVersionId = binding?.policy_version_id ?? null;
    const normalizedConfig = redactSecrets(proposedConfig);

    const { rows: [plan] } = await tx.query(
      `INSERT INTO policy_rollout_plans (
         repo_id, proposed_config, normalized_config, created_by, status
       ) VALUES ($1, $2, $3, $4, 'draft')
       RETURNING *`,
      [repoRow.github_id, proposedConfig, normalizedConfig, compatibilityActor],
    );

    await createPolicyChangeRequestForRollout({
      rolloutPlanId: plan.id,
      principal,
      basePolicyVersionId,
    }, tx);

    return redactPlan(plan);
  });
}

/**
 * Mirror rollout evidence and append the immutable W2-01 evidence records in
 * the same transaction. Evidence payloads are re-read from the locked rollout
 * by W2-01 rather than accepted as authority from this adapter.
 */
export async function attachGovernedEvidence({
  rolloutPlanId,
  evidence = {},
  principal,
} = {}) {
  if (!rolloutPlanId) {
    throw new PolicyRolloutGovernanceError("rollout_plan_id_required");
  }
  requirePrincipal(principal);

  return db.transaction(async (tx) => {
    const plan = await lockRollout(tx, rolloutPlanId);
    if (plan.status !== "draft" && plan.status !== "validated") {
      throw new PolicyRolloutGovernanceError(
        "rollout_state_disallows_evidence",
        plan.status,
      );
    }

    const updates = [];
    const values = [];
    const evidenceTypes = [];
    for (const field of EVIDENCE_FIELDS) {
      if (evidence[field] === undefined) continue;
      values.push(evidence[field]);
      updates.push(`${field} = $${values.length}`);
      evidenceTypes.push(field);
    }
    if (updates.length === 0) {
      throw new PolicyRolloutGovernanceError("evidence_fields_required");
    }

    values.push(rolloutPlanId);
    const { rows: [updated] } = await tx.query(
      `UPDATE policy_rollout_plans
          SET ${updates.join(", ")}
        WHERE id = $${values.length}
        RETURNING *`,
      values,
    );

    await appendPolicyEvidenceForRollout({
      rolloutPlanId,
      principal,
      evidenceTypes,
    }, tx);

    return redactPlan(updated);
  });
}

/**
 * Record immutable approval authority first while the locked compatibility row
 * is still review_ready, then mirror the approved state in the same transaction.
 */
export async function approveGovernedRollout({
  rolloutPlanId,
  principal,
  compatibilityActor = "unknown",
  reason = null,
  acknowledgedRecommendations = [],
  expiresAt = null,
} = {}) {
  if (!rolloutPlanId) {
    throw new PolicyRolloutGovernanceError("rollout_plan_id_required");
  }
  requirePrincipal(principal);
  if (!Array.isArray(acknowledgedRecommendations)) {
    throw new PolicyRolloutGovernanceError("acknowledged_recommendations_must_be_array");
  }

  return db.transaction(async (tx) => {
    const plan = await lockRollout(tx, rolloutPlanId);
    if (plan.status !== "review_ready") {
      throw new PolicyRolloutGovernanceError(
        "rollout_state_disallows_approval",
        plan.status,
      );
    }

    const missingEvidence = REQUIRED_EVIDENCE_FOR_APPROVAL.filter((field) => !plan[field]);
    if (missingEvidence.length > 0) {
      throw new PolicyRolloutGovernanceError("approval_evidence_incomplete", missingEvidence);
    }
    if (plan.validation_result?.valid !== true) {
      throw new PolicyRolloutGovernanceError("approval_validation_failed_or_missing");
    }

    const acknowledged = new Set(acknowledgedRecommendations);
    const missingCritical = criticalRecommendationIds(plan.recommendations_summary)
      .filter((id) => !acknowledged.has(id));
    if (missingCritical.length > 0) {
      throw new PolicyRolloutGovernanceError(
        "critical_recommendations_unacknowledged",
        missingCritical,
      );
    }

    await recordPolicyApprovalForRollout({
      rolloutPlanId,
      principal,
      decision: "approved",
      reason,
      acknowledgedRecommendations,
      expiresAt,
    }, tx);

    const { rows: [updated] } = await tx.query(
      `UPDATE policy_rollout_plans
          SET status = 'approved',
              approved_by = $1,
              approved_at = clock_timestamp(),
              approval_reason = $2,
              acknowledged_recommendations = $3,
              reviewed_evidence = $4
        WHERE id = $5
        RETURNING *`,
      [
        compatibilityActor,
        reason,
        acknowledgedRecommendations,
        reviewedEvidenceSnapshot(plan),
        rolloutPlanId,
      ],
    );

    return redactPlan(updated);
  });
}

/**
 * Record immutable rejection authority and mirror the compatibility state in
 * one transaction. Rejection is terminal in the compatibility workflow.
 */
export async function rejectGovernedRollout({
  rolloutPlanId,
  principal,
  compatibilityActor = "unknown",
  reason = null,
} = {}) {
  if (!rolloutPlanId) {
    throw new PolicyRolloutGovernanceError("rollout_plan_id_required");
  }
  requirePrincipal(principal);

  return db.transaction(async (tx) => {
    const plan = await lockRollout(tx, rolloutPlanId);
    if (plan.status !== "review_ready") {
      throw new PolicyRolloutGovernanceError(
        "rollout_state_disallows_rejection",
        plan.status,
      );
    }

    await recordPolicyApprovalForRollout({
      rolloutPlanId,
      principal,
      decision: "rejected",
      reason,
    }, tx);

    const { rows: [updated] } = await tx.query(
      `UPDATE policy_rollout_plans
          SET status = 'rejected',
              rejected_by = $1,
              rejected_at = clock_timestamp(),
              rejection_reason = $2
        WHERE id = $3
        RETURNING *`,
      [compatibilityActor, reason, rolloutPlanId],
    );

    return redactPlan(updated);
  });
}
