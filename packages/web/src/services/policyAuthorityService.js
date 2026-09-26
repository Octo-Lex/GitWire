// src/services/policyAuthorityService.js
// W2-01 — immutable policy authority records.
//
// This service binds to the existing policy_rollout_plans compatibility
// workflow; it does not create a second policy workflow and does not mutate
// active policy. W2-02 will consume these immutable records as the promotion
// authority boundary.

import { db } from "../lib/db.js";
import { authorizeControlled } from "./auth/authorize.js";

export const POLICY_EVIDENCE_TYPES = Object.freeze([
  "validation_result",
  "simulation_summary",
  "diff_impact_summary",
  "recommendations_summary",
]);

export const POLICY_AUTHORITY_PERMISSIONS = Object.freeze({
  create: "policy_definition:create",
  evidence: "policy_rollout_plan:update",
  decision: "policy_rollout_plan:approve",
});

export class PolicyAuthorityError extends Error {
  constructor(reason, detail = null) {
    super(reason);
    this.name = "PolicyAuthorityError";
    this.reason = reason;
    this.detail = detail;
  }
}

function canonicalize(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalize(item)).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(",")}}`;
}

export function canonicalPolicyJson(value) {
  return canonicalize(value);
}

function sameJson(left, right) {
  return canonicalPolicyJson(left) === canonicalPolicyJson(right);
}

function exactIdEqual(left, right) {
  return String(left) === String(right);
}

function principalIdOf(principal) {
  return principal?.principalId || null;
}

async function inTransaction(queryable, fn) {
  if (typeof queryable?.transaction === "function") return queryable.transaction(fn);
  return fn(queryable);
}

async function requireActivePrincipal(client, principal) {
  const principalId = principalIdOf(principal);
  if (!principalId) throw new PolicyAuthorityError("authoritative_principal_required");

  const { rows: [record] } = await client.query(
    `SELECT id, status
       FROM gitwire_auth.auth_principals
      WHERE id = $1`,
    [principalId],
  );
  if (!record) throw new PolicyAuthorityError("authoritative_principal_not_found");
  if (record.status !== "active") throw new PolicyAuthorityError("authoritative_principal_inactive");
  return record;
}

function repositoryResource(row) {
  if (!row?.installation_id || !row?.github_id || typeof row.full_name !== "string") {
    throw new PolicyAuthorityError("repository_resource_unknown");
  }
  const parts = row.full_name.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new PolicyAuthorityError("repository_resource_unknown");
  }
  return Object.freeze({
    type: "repository",
    installationId: Number(row.installation_id),
    repositoryId: Number(row.github_id),
    organization: parts[0],
    repository: parts[1],
  });
}

async function resolveRolloutRepository(queryable, rolloutPlanId) {
  const { rows: [row] } = await queryable.query(
    `SELECT p.repo_id, r.github_id, r.installation_id, r.full_name
       FROM policy_rollout_plans p
       JOIN repositories r ON r.github_id = p.repo_id
      WHERE p.id = $1`,
    [rolloutPlanId],
  );
  if (!row) throw new PolicyAuthorityError("rollout_repository_unknown");
  return { repoId: row.repo_id, resource: repositoryResource(row) };
}

async function requireRepositoryAuthorization({ principal, permission, rolloutPlanId }, queryable) {
  if (!principalIdOf(principal)) throw new PolicyAuthorityError("authoritative_principal_required");
  const target = await resolveRolloutRepository(queryable, rolloutPlanId);
  const outcome = await authorizeControlled({
    principal,
    permission,
    resource: target.resource,
    mode: "enforced",
  });

  if (
    !outcome ||
    outcome.mode !== "enforced" ||
    outcome.persisted !== true ||
    outcome.blocked === true ||
    outcome.decision?.allowed !== true
  ) {
    throw new PolicyAuthorityError(
      "authorization_denied",
      outcome?.decision?.code || "invalid_authorization_outcome",
    );
  }
  return target;
}

async function lockRolloutPlan(client, rolloutPlanId) {
  const { rows: [plan] } = await client.query(
    `SELECT id, repo_id, proposed_config, normalized_config, status,
            validation_result, simulation_summary, diff_impact_summary,
            recommendations_summary
       FROM policy_rollout_plans
      WHERE id = $1
      FOR UPDATE`,
    [rolloutPlanId],
  );
  if (!plan) throw new PolicyAuthorityError("rollout_plan_not_found");
  return plan;
}

async function getAuthorityEnvelope(client, rolloutPlanId, { lock = false } = {}) {
  const lockClause = lock ? " FOR UPDATE OF cr, p" : "";
  const { rows: [row] } = await client.query(
    `SELECT cr.id AS change_request_id,
            cr.rollout_plan_id,
            cr.repo_id,
            cr.policy_version_id,
            cr.author_principal_id,
            cr.created_at AS change_request_created_at,
            pv.content_hash AS policy_content_hash,
            pv.base_policy_version_id,
            pv.policy_document,
            p.status AS rollout_status,
            p.proposed_config,
            p.validation_result,
            p.simulation_summary,
            p.diff_impact_summary,
            p.recommendations_summary
       FROM policy_change_requests cr
       JOIN policy_versions pv ON pv.id = cr.policy_version_id
       JOIN policy_rollout_plans p ON p.id = cr.rollout_plan_id
      WHERE cr.rollout_plan_id = $1${lockClause}`,
    [rolloutPlanId],
  );
  return row || null;
}

function authoritySummary(row) {
  if (!row) return null;
  return {
    change_request_id: row.change_request_id,
    rollout_plan_id: row.rollout_plan_id,
    repo_id: row.repo_id,
    policy_version_id: row.policy_version_id,
    policy_content_hash: row.policy_content_hash,
    base_policy_version_id: row.base_policy_version_id ?? null,
    author_principal_id: row.author_principal_id,
    created_at: row.change_request_created_at,
  };
}

function assertRolloutPolicyStillMatches(envelope) {
  if (!sameJson(envelope.policy_document, envelope.proposed_config)) {
    throw new PolicyAuthorityError("rollout_policy_changed_after_authority_snapshot");
  }
}

function getCriticalRecommendations(summary) {
  if (!summary || !Array.isArray(summary.recommendations)) return [];
  const criticalIds = [];
  for (const item of summary.recommendations) {
    if (item?.severity !== "critical") continue;
    if (typeof item.id !== "string" || item.id.trim().length === 0) {
      throw new PolicyAuthorityError("critical_recommendation_id_invalid");
    }
    criticalIds.push(item.id);
  }
  return criticalIds;
}

/**
 * Snapshot an existing rollout into an immutable policy version/change request.
 * The caller cannot supply policy content: the transaction reads the rollout's
 * DB-owned proposed_config after locking the rollout row.
 */
export async function createPolicyChangeRequestForRollout({
  rolloutPlanId,
  principal,
  basePolicyVersionId = null,
} = {}, queryable = db) {
  if (!rolloutPlanId) throw new PolicyAuthorityError("rollout_plan_id_required");

  const target = await requireRepositoryAuthorization({
    principal,
    permission: POLICY_AUTHORITY_PERMISSIONS.create,
    rolloutPlanId,
  }, queryable);

  return inTransaction(queryable, async (client) => {
    const plan = await lockRolloutPlan(client, rolloutPlanId);
    if (!exactIdEqual(plan.repo_id, target.repoId)) {
      throw new PolicyAuthorityError("rollout_repository_changed_during_authorization");
    }
    await requireActivePrincipal(client, principal);

    const existing = await getAuthorityEnvelope(client, rolloutPlanId);
    if (existing) {
      if (!exactIdEqual(existing.author_principal_id, principal.principalId)) {
        throw new PolicyAuthorityError("rollout_authority_bound_to_different_principal");
      }
      if (
        basePolicyVersionId &&
        !exactIdEqual(existing.base_policy_version_id, basePolicyVersionId)
      ) {
        throw new PolicyAuthorityError("rollout_authority_base_version_mismatch");
      }
      return authoritySummary(existing);
    }

    if (basePolicyVersionId) {
      const { rows: [base] } = await client.query(
        `SELECT id, repo_id FROM policy_versions WHERE id = $1`,
        [basePolicyVersionId],
      );
      if (!base) throw new PolicyAuthorityError("base_policy_version_not_found");
      if (!exactIdEqual(base.repo_id, plan.repo_id)) {
        throw new PolicyAuthorityError("base_policy_version_repository_mismatch");
      }
    }

    const { rows: [version] } = await client.query(
      `INSERT INTO policy_versions (
         repo_id, base_policy_version_id, policy_document, normalized_document,
         author_principal_id
       ) VALUES ($1, $2, $3, $4, $5)
       RETURNING id, repo_id, base_policy_version_id, content_hash, created_at`,
      [
        plan.repo_id,
        basePolicyVersionId,
        plan.proposed_config,
        plan.normalized_config,
        principal.principalId,
      ],
    );

    const { rows: [request] } = await client.query(
      `INSERT INTO policy_change_requests (
         rollout_plan_id, repo_id, policy_version_id, author_principal_id
       ) VALUES ($1, $2, $3, $4)
       RETURNING id, rollout_plan_id, repo_id, policy_version_id,
                 author_principal_id, created_at`,
      [rolloutPlanId, plan.repo_id, version.id, principal.principalId],
    );

    return {
      change_request_id: request.id,
      rollout_plan_id: request.rollout_plan_id,
      repo_id: request.repo_id,
      policy_version_id: request.policy_version_id,
      policy_content_hash: version.content_hash,
      base_policy_version_id: version.base_policy_version_id ?? null,
      author_principal_id: request.author_principal_id,
      created_at: request.created_at,
    };
  });
}

/**
 * Append immutable evidence by type. Evidence payloads are not accepted from
 * the caller: each requested type is snapshotted from DB-owned rollout state.
 */
export async function appendPolicyEvidenceForRollout({
  rolloutPlanId,
  principal,
  evidenceTypes = [],
} = {}, queryable = db) {
  if (!rolloutPlanId) throw new PolicyAuthorityError("rollout_plan_id_required");
  if (!Array.isArray(evidenceTypes) || evidenceTypes.length === 0) {
    throw new PolicyAuthorityError("evidence_types_required");
  }
  const uniqueTypes = [...new Set(evidenceTypes)];
  for (const type of uniqueTypes) {
    if (!POLICY_EVIDENCE_TYPES.includes(type)) {
      throw new PolicyAuthorityError("unsupported_evidence_type", type);
    }
  }

  const target = await requireRepositoryAuthorization({
    principal,
    permission: POLICY_AUTHORITY_PERMISSIONS.evidence,
    rolloutPlanId,
  }, queryable);

  return inTransaction(queryable, async (client) => {
    await requireActivePrincipal(client, principal);
    const envelope = await getAuthorityEnvelope(client, rolloutPlanId, { lock: true });
    if (!envelope) throw new PolicyAuthorityError("policy_authority_not_found");
    if (!exactIdEqual(envelope.repo_id, target.repoId)) {
      throw new PolicyAuthorityError("rollout_repository_changed_during_authorization");
    }
    assertRolloutPolicyStillMatches(envelope);

    if (envelope.rollout_status !== "draft" && envelope.rollout_status !== "validated") {
      throw new PolicyAuthorityError("rollout_state_disallows_evidence", envelope.rollout_status);
    }

    const { rows: [approval] } = await client.query(
      `SELECT id FROM policy_approval_records WHERE change_request_id = $1 LIMIT 1`,
      [envelope.change_request_id],
    );
    if (approval) throw new PolicyAuthorityError("policy_evidence_frozen_after_decision");

    const recorded = [];
    for (const type of uniqueTypes) {
      const payload = envelope[type];
      if (payload === null || payload === undefined) {
        throw new PolicyAuthorityError("rollout_evidence_missing", type);
      }

      const { rows } = await client.query(
        `INSERT INTO policy_evidence_records (
           change_request_id, policy_version_id, evidence_type,
           evidence_payload, recorded_by_principal_id
         ) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT DO NOTHING
         RETURNING id, evidence_type, evidence_hash, recorded_at`,
        [
          envelope.change_request_id,
          envelope.policy_version_id,
          type,
          payload,
          principal.principalId,
        ],
      );

      if (rows[0]) {
        recorded.push(rows[0]);
      } else {
        const { rows: [existing] } = await client.query(
          `SELECT id, evidence_type, evidence_hash, recorded_at
             FROM policy_evidence_records
            WHERE change_request_id = $1
              AND evidence_type = $2
              AND evidence_payload = $3::jsonb
            ORDER BY recorded_at DESC, id DESC
            LIMIT 1`,
          [envelope.change_request_id, type, JSON.stringify(payload)],
        );
        if (!existing) throw new PolicyAuthorityError("policy_evidence_insert_conflict_unresolved", type);
        recorded.push(existing);
      }
    }
    return recorded;
  });
}

async function buildEvidenceManifest(client, envelope, { requireComplete }) {
  const { rows } = await client.query(
    `SELECT id, evidence_type, evidence_payload, evidence_hash, recorded_at
       FROM policy_evidence_records
      WHERE change_request_id = $1
      ORDER BY evidence_type ASC, recorded_at ASC, id ASC`,
    [envelope.change_request_id],
  );

  const manifest = [];
  for (const type of POLICY_EVIDENCE_TYPES) {
    const payload = envelope[type];
    if (payload === null || payload === undefined) {
      if (requireComplete) throw new PolicyAuthorityError("approval_evidence_incomplete", type);
      continue;
    }

    const match = [...rows].reverse().find(
      (row) => row.evidence_type === type && sameJson(row.evidence_payload, payload),
    );
    if (!match) throw new PolicyAuthorityError("approval_evidence_mismatch", type);
    manifest.push({
      evidence_type: type,
      evidence_id: match.id,
      evidence_hash: match.evidence_hash,
    });
  }
  return manifest;
}

/**
 * Record an immutable approval/rejection decision bound to the exact policy
 * version and immutable evidence manifest. Current repository authorization is
 * checked before the write. W2-02 must re-evaluate current approval policy and
 * current principal authority again at promotion time.
 */
export async function recordPolicyApprovalForRollout({
  rolloutPlanId,
  principal,
  decision,
  reason = null,
  acknowledgedRecommendations = [],
  expiresAt = null,
} = {}, queryable = db) {
  if (!rolloutPlanId) throw new PolicyAuthorityError("rollout_plan_id_required");
  if (decision !== "approved" && decision !== "rejected") {
    throw new PolicyAuthorityError("invalid_approval_decision");
  }
  if (!Array.isArray(acknowledgedRecommendations)) {
    throw new PolicyAuthorityError("acknowledged_recommendations_must_be_array");
  }
  if (decision === "rejected" && expiresAt) {
    throw new PolicyAuthorityError("rejection_cannot_expire");
  }

  const target = await requireRepositoryAuthorization({
    principal,
    permission: POLICY_AUTHORITY_PERMISSIONS.decision,
    rolloutPlanId,
  }, queryable);

  return inTransaction(queryable, async (client) => {
    await requireActivePrincipal(client, principal);
    const envelope = await getAuthorityEnvelope(client, rolloutPlanId, { lock: true });
    if (!envelope) throw new PolicyAuthorityError("policy_authority_not_found");
    if (!exactIdEqual(envelope.repo_id, target.repoId)) {
      throw new PolicyAuthorityError("rollout_repository_changed_during_authorization");
    }
    assertRolloutPolicyStillMatches(envelope);

    if (envelope.rollout_status !== "review_ready") {
      throw new PolicyAuthorityError("rollout_state_disallows_decision", envelope.rollout_status);
    }
    if (
      decision === "approved" &&
      exactIdEqual(envelope.author_principal_id, principal.principalId)
    ) {
      throw new PolicyAuthorityError("self_approval_forbidden");
    }

    let normalizedExpiry = null;
    if (expiresAt) {
      const parsed = new Date(expiresAt);
      if (Number.isNaN(parsed.getTime()) || parsed.getTime() <= Date.now()) {
        throw new PolicyAuthorityError("approval_expiry_must_be_future");
      }
      normalizedExpiry = parsed.toISOString();
    }

    const { rows: [existing] } = await client.query(
      `SELECT id FROM policy_approval_records
        WHERE change_request_id = $1 AND approver_principal_id = $2`,
      [envelope.change_request_id, principal.principalId],
    );
    if (existing) throw new PolicyAuthorityError("approval_decision_already_recorded");

    const evidenceManifest = await buildEvidenceManifest(client, envelope, {
      requireComplete: decision === "approved",
    });

    if (decision === "approved") {
      if (!envelope.validation_result || envelope.validation_result.valid !== true) {
        throw new PolicyAuthorityError("approval_validation_failed_or_missing");
      }
      const critical = getCriticalRecommendations(envelope.recommendations_summary);
      const acknowledged = new Set(acknowledgedRecommendations);
      const missing = critical.filter((id) => !acknowledged.has(id));
      if (missing.length > 0) {
        throw new PolicyAuthorityError("critical_recommendations_unacknowledged", missing);
      }
    }

    const { rows: [record] } = await client.query(
      `INSERT INTO policy_approval_records (
         change_request_id, policy_version_id, approver_principal_id,
         decision, reason, acknowledged_recommendations,
         evidence_manifest, expires_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, change_request_id, policy_version_id, approver_principal_id,
                 decision, reason, acknowledged_recommendations,
                 evidence_manifest, evidence_set_hash, expires_at, created_at`,
      [
        envelope.change_request_id,
        envelope.policy_version_id,
        principal.principalId,
        decision,
        reason,
        acknowledgedRecommendations,
        evidenceManifest,
        normalizedExpiry,
      ],
    );
    return record;
  });
}

async function getPolicyAuthorityForRollout(rolloutPlanId, queryable = db) {
  if (!rolloutPlanId) throw new PolicyAuthorityError("rollout_plan_id_required");
  const envelope = await getAuthorityEnvelope(queryable, rolloutPlanId);
  if (!envelope) return null;

  const { rows: evidence } = await queryable.query(
    `SELECT id, evidence_type, evidence_hash, recorded_by_principal_id, recorded_at
       FROM policy_evidence_records
      WHERE change_request_id = $1
      ORDER BY evidence_type ASC, recorded_at ASC, id ASC`,
    [envelope.change_request_id],
  );
  const { rows: approvals } = await queryable.query(
    `SELECT id, approver_principal_id, decision, reason,
            acknowledged_recommendations, evidence_manifest, evidence_set_hash,
            expires_at, created_at
       FROM policy_approval_records
      WHERE change_request_id = $1
      ORDER BY created_at ASC, id ASC`,
    [envelope.change_request_id],
  );

  return { ...authoritySummary(envelope), evidence, approvals };
}

/** Temporal validity only. W2-02 promotion must reauthorize the approver and
 * re-evaluate current approval policy; this helper does not imply authority. */
export function isApprovalRecordTemporallyValid(record, now = new Date()) {
  if (!record || record.decision !== "approved") return false;
  if (!record.expires_at) return true;
  const expiry = new Date(record.expires_at);
  return !Number.isNaN(expiry.getTime()) && expiry.getTime() > now.getTime();
}

export function assertApprovalRecordTemporallyValid(record, now = new Date()) {
  if (!isApprovalRecordTemporallyValid(record, now)) {
    throw new PolicyAuthorityError("approval_record_expired_or_unusable");
  }
  return true;
}