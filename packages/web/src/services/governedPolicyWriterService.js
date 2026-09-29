// W2-03 — governed compatibility writers for the rollout lifecycle.
//
// Compatibility rollout rows remain the public workflow surface, but authority
// is created only through W2-01 immutable records using server-owned principals.
// Every compatibility mutation and its immutable authority write share one DB
// transaction so an authority failure rolls the compatibility write back.

import { db } from "../lib/db.js";
import { logger } from "../lib/logger.js";
import { redactSecrets } from "../lib/redact.js";
import { authorizeControlled } from "./auth/authorize.js";
import {
  POLICY_EVIDENCE_TYPES,
  createPolicyChangeRequestForRollout,
  appendPolicyEvidenceForRollout,
  recordPolicyApprovalForRollout,
} from "./policyAuthorityService.js";
import {
  VALID_TRANSITIONS,
  REQUIRED_EVIDENCE,
  REQUIRED_EVIDENCE_FOR_APPROVAL,
  redactPlan,
} from "./policyRolloutService.js";

export class GovernedPolicyWriterError extends Error {
  constructor(reason, detail = null) {
    super(reason);
    this.name = "GovernedPolicyWriterError";
    this.reason = reason;
    this.detail = detail;
  }
}

function principalIdOf(principal) {
  return principal?.principalId || null;
}

function requirePrincipal(principal) {
  const principalId = principalIdOf(principal);
  if (!principalId) {
    throw new GovernedPolicyWriterError("authoritative_principal_required");
  }
  return principalId;
}

function repositoryResource(row) {
  const parts = String(row.full_name || "").split("/");
  if (!row.installation_id || !row.github_id || parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new GovernedPolicyWriterError("repository_resource_unknown");
  }
  return Object.freeze({
    type: "repository",
    installationId: Number(row.installation_id),
    repositoryId: Number(row.github_id),
    organization: parts[0],
    repository: parts[1],
  });
}

async function requireRolloutUpdateAuthorization(client, rolloutPlanId, principal) {
  requirePrincipal(principal);
  const { rows: [row] } = await client.query(
    `SELECT p.id, p.repo_id, r.github_id, r.installation_id, r.full_name
       FROM policy_rollout_plans p
       JOIN repositories r ON r.github_id = p.repo_id
      WHERE p.id = $1`,
    [rolloutPlanId],
  );
  if (!row) throw new GovernedPolicyWriterError("rollout_plan_not_found");

  const outcome = await authorizeControlled({
    principal,
    permission: "policy_rollout_plan:update",
    resource: repositoryResource(row),
    mode: "enforced",
    queryable: client,
    lockAuthorityRows: true,
  });

  if (
    !outcome ||
    outcome.mode !== "enforced" ||
    outcome.persisted !== true ||
    outcome.blocked === true ||
    outcome.decision?.allowed !== true
  ) {
    throw new GovernedPolicyWriterError(
      "authorization_denied",
      outcome?.decision?.code || "invalid_authorization_outcome",
    );
  }
  return row;
}

function getCriticalRecommendations(recSummary) {
  if (!recSummary || !Array.isArray(recSummary.recommendations)) return [];
  return recSummary.recommendations
    .filter((item) => item?.severity === "critical")
    .map((item) => item?.id)
    .filter((id) => typeof id === "string" && id.length > 0);
}

export async function createGovernedRolloutPlan({
  repo,
  proposed_config,
  created_by = null,
  principal,
} = {}) {
  const principalId = requirePrincipal(principal);
  if (!repo || typeof repo !== "string") {
    throw new GovernedPolicyWriterError("repo_required");
  }
  if (!proposed_config || typeof proposed_config !== "object" || Array.isArray(proposed_config)) {
    throw new GovernedPolicyWriterError("proposed_config_required");
  }

  return db.transaction(async (client) => {
    const { rows: [repoRow] } = await client.query(
      `SELECT github_id, installation_id, full_name
         FROM repositories
        WHERE full_name = $1
        FOR SHARE`,
      [repo],
    );
    if (!repoRow) throw new GovernedPolicyWriterError("repository_not_found", repo);

    const { rows: [active] } = await client.query(
      `SELECT policy_version_id
         FROM active_policy_bindings
        WHERE repo_id = $1`,
      [repoRow.github_id],
    );

    const normalizedConfig = redactSecrets(proposed_config);
    const compatibilityActor =
      typeof created_by === "string" && created_by.trim().length > 0
        ? created_by.trim()
        : principalId;

    const { rows: [plan] } = await client.query(
      `INSERT INTO policy_rollout_plans (
         repo_id, proposed_config, normalized_config, created_by, status
       ) VALUES ($1, $2, $3, $4, 'draft')
       RETURNING *`,
      [repoRow.github_id, proposed_config, normalizedConfig, compatibilityActor],
    );

    const authority = await createPolicyChangeRequestForRollout({
      rolloutPlanId: plan.id,
      principal,
      basePolicyVersionId: active?.policy_version_id ?? null,
    }, client);

    logger.info(
      {
        plan_id: plan.id,
        repo,
        change_request_id: authority.change_request_id,
        policy_version_id: authority.policy_version_id,
        base_policy_version_id: authority.base_policy_version_id,
        author_principal_id: authority.author_principal_id,
      },
      "Governed rollout plan created",
    );
    return redactPlan(plan);
  });
}

export async function attachGovernedRolloutEvidence(
  id,
  evidence = {},
  { principal } = {},
) {
  requirePrincipal(principal);
  if (!Number.isSafeInteger(Number(id)) || Number(id) <= 0) {
    throw new GovernedPolicyWriterError("rollout_plan_id_required");
  }

  const fields = [
    ["validation_result", evidence.validation_result],
    ["simulation_summary", evidence.simulation_summary],
    ["diff_impact_summary", evidence.diff_impact_summary],
    ["recommendations_summary", evidence.recommendations_summary],
  ];
  const provided = fields.filter(([, value]) => value !== undefined);
  if (provided.length === 0) {
    throw new GovernedPolicyWriterError("evidence_fields_required");
  }

  return db.transaction(async (client) => {
    const { rows: [plan] } = await client.query(
      `SELECT * FROM policy_rollout_plans WHERE id = $1 FOR UPDATE`,
      [id],
    );
    if (!plan) throw new GovernedPolicyWriterError("rollout_plan_not_found");
    if (plan.status !== "draft" && plan.status !== "validated") {
      throw new GovernedPolicyWriterError("rollout_state_disallows_evidence", plan.status);
    }

    const updates = [];
    const values = [];
    for (const [field, value] of provided) {
      values.push(value);
      updates.push(`${field} = $${values.length}`);
    }
    values.push(id);

    const { rows: [updated] } = await client.query(
      `UPDATE policy_rollout_plans
          SET ${updates.join(", ")}
        WHERE id = $${values.length}
        RETURNING *`,
      values,
    );

    await appendPolicyEvidenceForRollout({
      rolloutPlanId: id,
      principal,
      evidenceTypes: provided.map(([field]) => field),
    }, client);

    logger.info(
      { plan_id: id, evidence_types: provided.map(([field]) => field) },
      "Governed rollout evidence attached and snapshotted",
    );
    return redactPlan(updated);
  });
}

export async function transitionGovernedRolloutPlan(id, params = {}) {
  const { status: targetStatus, principal, review_notes } = params;
  const principalId = requirePrincipal(principal);
  if (!targetStatus) throw new GovernedPolicyWriterError("status_required");

  return db.transaction(async (client) => {
    const { rows: [plan] } = await client.query(
      `SELECT * FROM policy_rollout_plans WHERE id = $1 FOR UPDATE`,
      [id],
    );
    if (!plan) throw new GovernedPolicyWriterError("rollout_plan_not_found");

    const allowed = VALID_TRANSITIONS[plan.status];
    if (!allowed || allowed.size === 0) {
      throw new GovernedPolicyWriterError("rollout_terminal_state", plan.status);
    }
    if (!allowed.has(targetStatus)) {
      throw new GovernedPolicyWriterError("invalid_rollout_transition", {
        from: plan.status,
        to: targetStatus,
      });
    }

    if (["approved", "rejected", "promoted", "rolled_back"].includes(targetStatus)) {
      throw new GovernedPolicyWriterError("dedicated_governed_endpoint_required", targetStatus);
    }

    const required = REQUIRED_EVIDENCE[targetStatus];
    if (required) {
      for (const field of required) {
        if (!plan[field]) {
          throw new GovernedPolicyWriterError("rollout_required_evidence_missing", field);
        }
      }
    }

    if (targetStatus === "review_ready") {
      await appendPolicyEvidenceForRollout({
        rolloutPlanId: id,
        principal,
        evidenceTypes: POLICY_EVIDENCE_TYPES,
      }, client);
    } else {
      await requireRolloutUpdateAuthorization(client, id, principal);
    }

    const updates = ["status = $1"];
    const values = [targetStatus];
    if (targetStatus === "cancelled") {
      values.push(principalId);
      updates.push(`cancelled_by = $${values.length}`);
      updates.push("cancelled_at = clock_timestamp()");
    }
    if (review_notes !== undefined && review_notes !== null) {
      values.push(review_notes);
      updates.push(`review_notes = $${values.length}`);
    }
    values.push(id);

    const { rows: [updated] } = await client.query(
      `UPDATE policy_rollout_plans
          SET ${updates.join(", ")}
        WHERE id = $${values.length}
        RETURNING *`,
      values,
    );

    logger.info(
      { plan_id: id, from: plan.status, to: targetStatus, principal_id: principalId },
      "Governed rollout plan transitioned",
    );
    return redactPlan(updated);
  });
}

export async function approveGovernedRolloutPlan(id, params = {}) {
  const {
    principal,
    reason = null,
    acknowledged_recommendations = [],
    expires_at = null,
  } = params;
  requirePrincipal(principal);
  if (!Array.isArray(acknowledged_recommendations)) {
    throw new GovernedPolicyWriterError("acknowledged_recommendations_must_be_array");
  }

  return db.transaction(async (client) => {
    const { rows: [plan] } = await client.query(
      `SELECT * FROM policy_rollout_plans WHERE id = $1 FOR UPDATE`,
      [id],
    );
    if (!plan) throw new GovernedPolicyWriterError("rollout_plan_not_found");
    if (plan.status !== "review_ready") {
      throw new GovernedPolicyWriterError("rollout_state_disallows_approval", plan.status);
    }

    const missing = REQUIRED_EVIDENCE_FOR_APPROVAL.filter((field) => !plan[field]);
    if (missing.length > 0) {
      throw new GovernedPolicyWriterError("approval_evidence_incomplete", missing);
    }
    if (plan.validation_result?.valid !== true) {
      throw new GovernedPolicyWriterError("approval_validation_failed_or_missing");
    }

    const critical = getCriticalRecommendations(plan.recommendations_summary);
    const acknowledged = new Set(acknowledged_recommendations);
    const unacknowledged = critical.filter((idValue) => !acknowledged.has(idValue));
    if (unacknowledged.length > 0) {
      throw new GovernedPolicyWriterError(
        "critical_recommendations_unacknowledged",
        unacknowledged,
      );
    }

    const approval = await recordPolicyApprovalForRollout({
      rolloutPlanId: id,
      principal,
      decision: "approved",
      reason,
      acknowledgedRecommendations: acknowledged_recommendations,
      expiresAt: expires_at,
    }, client);

    const reviewedEvidence = {
      validation_attached: true,
      simulation_attached: true,
      diff_attached: true,
      recommendations_attached: true,
      recommendation_counts: plan.recommendations_summary?.summary || {
        critical: 0,
        warning: 0,
        info: 0,
      },
      simulation_summary: plan.simulation_summary,
      diff_summary: plan.diff_impact_summary,
      immutable_approval_record_id: approval.id,
      immutable_evidence_set_hash: approval.evidence_set_hash,
    };

    const { rows: [updated] } = await client.query(
      `UPDATE policy_rollout_plans
          SET status = 'approved',
              approved_by = $1,
              approved_at = $2,
              approval_reason = $3,
              acknowledged_recommendations = $4,
              reviewed_evidence = $5
        WHERE id = $6
        RETURNING *`,
      [
        approval.approver_principal_id,
        approval.created_at,
        reason,
        acknowledged_recommendations,
        reviewedEvidence,
        id,
      ],
    );

    logger.info(
      {
        plan_id: id,
        approval_record_id: approval.id,
        approver_principal_id: approval.approver_principal_id,
      },
      "Governed rollout plan approved",
    );
    return redactPlan(updated);
  });
}

export async function rejectGovernedRolloutPlan(id, params = {}) {
  const { principal, reason = null } = params;
  requirePrincipal(principal);

  return db.transaction(async (client) => {
    const { rows: [plan] } = await client.query(
      `SELECT * FROM policy_rollout_plans WHERE id = $1 FOR UPDATE`,
      [id],
    );
    if (!plan) throw new GovernedPolicyWriterError("rollout_plan_not_found");
    if (plan.status !== "review_ready") {
      throw new GovernedPolicyWriterError("rollout_state_disallows_rejection", plan.status);
    }

    const rejection = await recordPolicyApprovalForRollout({
      rolloutPlanId: id,
      principal,
      decision: "rejected",
      reason,
    }, client);

    const { rows: [updated] } = await client.query(
      `UPDATE policy_rollout_plans
          SET status = 'rejected',
              rejected_by = $1,
              rejected_at = $2,
              rejection_reason = $3
        WHERE id = $4
        RETURNING *`,
      [rejection.approver_principal_id, rejection.created_at, reason, id],
    );

    logger.info(
      {
        plan_id: id,
        approval_record_id: rejection.id,
        rejector_principal_id: rejection.approver_principal_id,
      },
      "Governed rollout plan rejected",
    );
    return redactPlan(updated);
  });
}
