// src/services/policyPromotionService.js
// W2-02: canonical governed promotion into live policy.
//
// This service is intentionally narrower than the Wave-2 exit state. It owns
// promotion itself; W2-03 converts/disables the remaining direct config/control
// writers and W2-04 owns layering/provenance/default semantics.

import { isDeepStrictEqual } from "node:util";
import { db } from "../lib/db.js";
import { logger } from "../lib/logger.js";
import { authorizeControlled } from "./auth/authorize.js";
import { invalidateConfigCache } from "./configService.js";

export const POLICY_PROMOTION_PERMISSION = "policy_rollout_plan:approve";

export class PolicyPromotionError extends Error {
  constructor(reason, detail = null) {
    super(reason);
    this.name = "PolicyPromotionError";
    this.reason = reason;
    this.detail = detail;
  }
}

function repositoryResource(row) {
  return Object.freeze({
    type: "repository",
    installationId: Number(row.installation_id),
    repositoryId: Number(row.repository_id),
    fullName: row.full_name,
  });
}

async function requirePersistedEnforcedAuthorization({ principal, resource, label }) {
  const outcome = await authorizeControlled({
    principal,
    permission: POLICY_PROMOTION_PERMISSION,
    resource,
    mode: "enforced",
  });

  if (!outcome.persisted) {
    throw new PolicyPromotionError(`${label}_authorization_not_persisted`);
  }
  if (outcome.blocked || !outcome.decision?.allowed) {
    throw new PolicyPromotionError(`${label}_authorization_denied`, {
      code: outcome.decision?.code ?? "unknown",
    });
  }
  return outcome;
}

async function resolveRolloutResource(rolloutPlanId) {
  const { rows: [row] } = await db.query(
    `SELECT p.repo_id,
            r.github_id AS repository_id,
            r.installation_id,
            r.full_name
       FROM policy_rollout_plans p
       JOIN repositories r ON r.github_id = p.repo_id
      WHERE p.id = $1`,
    [rolloutPlanId],
  );
  if (!row) throw new PolicyPromotionError("rollout_or_repository_not_found");
  return row;
}

function manifestValidationRecord(approval, evidenceRows) {
  const evidenceById = new Map(evidenceRows.map((row) => [String(row.id), row]));
  const manifest = Array.isArray(approval.evidence_manifest) ? approval.evidence_manifest : [];
  for (const item of manifest) {
    if (item?.evidence_type !== "validation_result") continue;
    const evidence = evidenceById.get(String(item.evidence_id));
    if (!evidence) return null;
    if (evidence.evidence_type !== "validation_result") return null;
    if (evidence.evidence_hash !== item.evidence_hash) return null;
    return evidence;
  }
  return null;
}

function approvalTemporallyValid(approval) {
  return Boolean(
    approval
    && approval.decision === "approved"
    && approval.temporally_valid === true
  );
}

async function selectCurrentAuthorizedApproval({
  approvals,
  evidenceRows,
  resource,
  authorPrincipalId,
  promoterPrincipalId,
}) {
  if (approvals.some((record) => record.decision === "rejected")) {
    throw new PolicyPromotionError("promotion_blocked_by_rejection");
  }

  const candidates = approvals
    .filter((record) => approvalTemporallyValid(record))
    .sort((a, b) => {
      const byTime = new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
      return byTime || String(a.id).localeCompare(String(b.id));
    });

  if (candidates.length === 0) {
    throw new PolicyPromotionError("approved_authority_record_missing_or_expired");
  }

  for (const approval of candidates) {
    if (String(approval.approver_principal_id) === String(authorPrincipalId)) {
      continue;
    }
    if (String(approval.approver_principal_id) === String(promoterPrincipalId)) {
      continue;
    }

    const validation = manifestValidationRecord(approval, evidenceRows);
    if (!validation || validation.evidence_payload?.valid !== true) {
      continue;
    }

    try {
      await requirePersistedEnforcedAuthorization({
        principal: {
          principalId: approval.approver_principal_id,
          authenticationMethod: null,
        },
        resource,
        label: "approver",
      });
      return approval;
    } catch (err) {
      if (!(err instanceof PolicyPromotionError)) throw err;
      if (!err.reason.startsWith("approver_authorization_")) throw err;
    }
  }

  throw new PolicyPromotionError("no_currently_authorized_separated_approval");
}

async function loadPromotionEnvelope(tx, rolloutPlanId) {
  const { rows: [envelope] } = await tx.query(
    `SELECT cr.id AS change_request_id,
            cr.rollout_plan_id,
            cr.repo_id,
            cr.policy_version_id,
            cr.author_principal_id,
            pv.base_policy_version_id,
            pv.policy_document,
            pv.content_hash,
            p.status AS rollout_status,
            p.proposed_config
       FROM policy_change_requests cr
       JOIN policy_versions pv
         ON pv.id = cr.policy_version_id
        AND pv.repo_id = cr.repo_id
       JOIN policy_rollout_plans p
         ON p.id = cr.rollout_plan_id
        AND p.repo_id = cr.repo_id
      WHERE cr.rollout_plan_id = $1
      FOR UPDATE OF cr, p`,
    [rolloutPlanId],
  );

  if (!envelope) throw new PolicyPromotionError("policy_authority_not_found");
  return envelope;
}

async function loadAuthorityEvidenceAndApprovals(tx, changeRequestId) {
  const { rows: evidenceRows } = await tx.query(
    `SELECT id, change_request_id, policy_version_id, evidence_type,
            evidence_payload, evidence_hash, recorded_by_principal_id, recorded_at
       FROM policy_evidence_records
      WHERE change_request_id = $1
      ORDER BY recorded_at ASC, id ASC`,
    [changeRequestId],
  );
  const { rows: approvals } = await tx.query(
    `SELECT id, change_request_id, policy_version_id, approver_principal_id,
            decision, reason, acknowledged_recommendations, evidence_manifest,
            evidence_set_hash, expires_at,
            (expires_at IS NULL OR expires_at > NOW()) AS temporally_valid,
            created_at
       FROM policy_approval_records
      WHERE change_request_id = $1
      ORDER BY created_at ASC, id ASC`,
    [changeRequestId],
  );
  return { evidenceRows, approvals };
}

async function lockActivePolicyState(tx, repoId) {
  // The repository row is the repository-scoped mutex. It serializes even the
  // first governed promotion where active_policy_bindings/repo_config may not
  // yet have rows to lock.
  const { rows: [repo] } = await tx.query(
    `SELECT github_id AS repository_id, installation_id, full_name
       FROM repositories
      WHERE github_id = $1
      FOR UPDATE`,
    [repoId],
  );
  if (!repo) throw new PolicyPromotionError("promotion_repository_not_found");

  const { rows: [active] } = await tx.query(
    `SELECT apb.*,
            pv.policy_document AS active_policy_document,
            rc.config AS materialized_config,
            CASE
              WHEN rc.repo_id IS NULL THEN FALSE
              ELSE rc.config = pv.policy_document
            END AS materialization_matches
       FROM active_policy_bindings apb
       JOIN policy_versions pv
         ON pv.id = apb.policy_version_id
        AND pv.repo_id = apb.repo_id
       LEFT JOIN repo_config rc ON rc.repo_id = apb.repo_id
      WHERE apb.repo_id = $1
      FOR UPDATE OF apb`,
    [repoId],
  );

  const { rows: [repoConfig] } = await tx.query(
    `SELECT config
       FROM repo_config
      WHERE repo_id = $1
      FOR UPDATE`,
    [repoId],
  );

  return { repo, active: active ?? null, repoConfig: repoConfig ?? null };
}

function assertCurrentBase(envelope, active) {
  const expectedBase = envelope.base_policy_version_id;
  if (!active) {
    if (expectedBase !== null && expectedBase !== undefined) {
      throw new PolicyPromotionError("first_governed_promotion_requires_null_base");
    }
    return;
  }

  if (String(expectedBase) !== String(active.policy_version_id)) {
    throw new PolicyPromotionError("stale_policy_base", {
      expected: expectedBase ?? null,
      active: active.policy_version_id,
    });
  }
  if (active.materialization_matches !== true) {
    throw new PolicyPromotionError("active_policy_materialization_drift");
  }
}

function changedByToken(principalId, rolloutPlanId) {
  return `policy-promotion:${principalId}:${rolloutPlanId}`;
}

/**
 * Atomically promote an approved immutable W2-01 policy version to the
 * repository's governed live-policy binding and repo_config materialization.
 *
 * Role grants are deliberately not seeded here. Until a human-approved role
 * grants POLICY_PROMOTION_PERMISSION, this service fails closed.
 */
export async function promotePolicyRollout({
  rolloutPlanId,
  principal,
  reason = null,
}) {
  if (!rolloutPlanId) throw new PolicyPromotionError("rollout_plan_id_required");
  if (!principal?.principalId) throw new PolicyPromotionError("promoter_principal_required");

  const resourceRow = await resolveRolloutResource(rolloutPlanId);
  const resource = repositoryResource(resourceRow);

  await requirePersistedEnforcedAuthorization({
    principal,
    resource,
    label: "promoter",
  });

  const result = await db.transaction(async (tx) => {
    // Lock repository before reading mutable authority state. The resource was
    // server-resolved pre-auth; this lock re-establishes the same repository
    // identity inside the atomic promotion transaction.
    const { repo, active, repoConfig } =
      await lockActivePolicyState(tx, resourceRow.repository_id);

    if (String(repo.repository_id) !== String(resourceRow.repository_id)
        || String(repo.installation_id) !== String(resourceRow.installation_id)
        || repo.full_name !== resourceRow.full_name) {
      throw new PolicyPromotionError("repository_binding_changed");
    }

    // Read under the repository lock so rollout state/base checks cannot be
    // separated from the write by a concurrent repository-scoped promotion.
    const envelope = await loadPromotionEnvelope(tx, rolloutPlanId);

    if (envelope.rollout_status !== "approved") {
      throw new PolicyPromotionError("rollout_state_disallows_promotion", {
        status: envelope.rollout_status,
      });
    }
    if (!isDeepStrictEqual(envelope.proposed_config, envelope.policy_document)) {
      throw new PolicyPromotionError("rollout_policy_version_drift");
    }

    assertCurrentBase(envelope, active);

    if (String(principal.principalId) === String(envelope.author_principal_id)) {
      throw new PolicyPromotionError("promoter_must_differ_from_author");
    }

    const { evidenceRows, approvals } =
      await loadAuthorityEvidenceAndApprovals(tx, envelope.change_request_id);

    const approval = await selectCurrentAuthorizedApproval({
      approvals,
      evidenceRows,
      resource,
      authorPrincipalId: envelope.author_principal_id,
      promoterPrincipalId: principal.principalId,
    });

    const { rows: [promotion] } = await tx.query(
      `INSERT INTO policy_promotion_records (
         repo_id,
         rollout_plan_id,
         change_request_id,
         policy_version_id,
         previous_policy_version_id,
         approval_record_id,
         author_principal_id,
         approver_principal_id,
         promoter_principal_id,
         evidence_set_hash,
         reason
       )
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING *`,
      [
        envelope.repo_id,
        rolloutPlanId,
        envelope.change_request_id,
        envelope.policy_version_id,
        active?.policy_version_id ?? null,
        approval.id,
        envelope.author_principal_id,
        approval.approver_principal_id,
        principal.principalId,
        approval.evidence_set_hash,
        reason,
      ],
    );

    const actorToken = changedByToken(principal.principalId, rolloutPlanId);
    const previousConfig = repoConfig?.config ?? null;

    await tx.query(
      `INSERT INTO repo_config (repo_id, config, updated_at, updated_by)
       VALUES ($1, $2::jsonb, NOW(), $3)
       ON CONFLICT (repo_id) DO UPDATE
         SET config = EXCLUDED.config,
             updated_at = EXCLUDED.updated_at,
             updated_by = EXCLUDED.updated_by`,
      [envelope.repo_id, JSON.stringify(envelope.policy_document), actorToken],
    );

    await tx.query(
      `INSERT INTO config_history (
         repo_id, action, config_old, config_new, changed_by
       )
       VALUES ($1, 'set', $2::jsonb, $3::jsonb, $4)`,
      [
        envelope.repo_id,
        previousConfig === null ? null : JSON.stringify(previousConfig),
        JSON.stringify(envelope.policy_document),
        actorToken,
      ],
    );

    const { rows: [binding] } = await tx.query(
      `INSERT INTO active_policy_bindings (
         repo_id,
         policy_version_id,
         promotion_record_id,
         change_request_id,
         approval_record_id,
         author_principal_id,
         approver_principal_id,
         promoter_principal_id,
         evidence_set_hash
       )
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (repo_id) DO UPDATE
         SET policy_version_id = EXCLUDED.policy_version_id,
             promotion_record_id = EXCLUDED.promotion_record_id,
             change_request_id = EXCLUDED.change_request_id,
             approval_record_id = EXCLUDED.approval_record_id,
             author_principal_id = EXCLUDED.author_principal_id,
             approver_principal_id = EXCLUDED.approver_principal_id,
             promoter_principal_id = EXCLUDED.promoter_principal_id,
             evidence_set_hash = EXCLUDED.evidence_set_hash
       RETURNING *`,
      [
        envelope.repo_id,
        envelope.policy_version_id,
        promotion.id,
        envelope.change_request_id,
        approval.id,
        envelope.author_principal_id,
        approval.approver_principal_id,
        principal.principalId,
        approval.evidence_set_hash,
      ],
    );

    const { rows: [rollout] } = await tx.query(
      `UPDATE policy_rollout_plans
          SET status = 'promoted',
              promoted_by = $1,
              promoted_at = $2,
              promotion_reason = $3,
              previous_config = $4::jsonb
        WHERE id = $5
          AND status = 'approved'
      RETURNING id, repo_id, status, promoted_by, promoted_at, promotion_reason`,
      [
        String(principal.principalId),
        promotion.promoted_at,
        reason,
        previousConfig === null ? null : JSON.stringify(previousConfig),
        rolloutPlanId,
      ],
    );
    if (!rollout) {
      throw new PolicyPromotionError("rollout_state_changed_during_promotion");
    }

    return { promotion, binding, rollout, repoFullName: repo.full_name };
  });

  await invalidateConfigCache(result.repoFullName);

  logger.info(
    {
      rolloutPlanId,
      repo: result.repoFullName,
      policyVersionId: result.promotion.policy_version_id,
      promoterPrincipalId: principal.principalId,
    },
    "Governed policy promotion committed",
  );

  return Object.freeze({
    promotion: result.promotion,
    activePolicy: result.binding,
    rollout: result.rollout,
  });
}
