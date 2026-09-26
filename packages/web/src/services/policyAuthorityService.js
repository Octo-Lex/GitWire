// src/services/policyAuthorityService.js
// W2-01 — immutable policy authority records.
//
// This service intentionally binds to the existing policy_rollout_plans
// workflow instead of creating a second workflow. It snapshots DB-owned rollout
// state into immutable versions/change requests, appends immutable evidence,
// and records immutable approvals using server-owned principal ids.
//
// W2-02 will make these records authoritative for promotion. W2-01 does not
// change active policy or disable legacy config writers.

import { createHash } from "node:crypto";
import { db } from "../lib/db.js";

export const POLICY_EVIDENCE_TYPES = Object.freeze([
  "validation_result",
  "simulation_summary",
  "diff_impact_summary",
  "recommendations_summary",
]);

function canonicalize(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalize(item)).join(",")}]`;
  }
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(",")}}`;
}

export function canonicalPolicyJson(value) {
  return canonicalize(value);
}

export function hashPolicyJson(value) {
  const digest = createHash("sha256").update(canonicalPolicyJson(value)).digest("hex");
  return `sha256:${digest}`;
}

async function inTransaction(queryable, fn) {
  if (typeof queryable?.transaction === "function") {
    return queryable.transaction(fn);
  }
  return fn(queryable);
}

async function requireActivePrincipal(client, principalId) {
  if (!principalId) {
    throw new Error("authoritative principal_id is required");
  }
  const { rows: [principal] } = await client.query(
    `SELECT id, status, display_name
       FROM gitwire_auth.auth_principals
      WHERE id = $1`,
    [principalId],
  );
  if (!principal) {
    throw new Error("authoritative principal not found");
  }
  if (principal.status !== "active") {
    throw new Error("authoritative principal is not active");
  }
  return principal;
}

async function getAuthorityEnvelope(client, rolloutPlanId, { lock = false } = {}) {
  const lockClause = lock ? " FOR SHARE OF p, cr, pv" : "";
  const { rows: [row] } = await client.query(
    `SELECT cr.id AS change_request_id,
            cr.rollout_plan_id,
            cr.repo_id,
            cr.policy_version_id,
            cr.author_principal_id,
            cr.author_display_name,
            cr.created_at AS change_request_created_at,
            pv.content_hash AS policy_content_hash,
            pv.base_policy_version_id,
            p.status AS rollout_status,
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
    author_display_name: row.author_display_name ?? null,
    created_at: row.change_request_created_at,
  };
}

/**
 * Create the immutable authority envelope for an EXISTING rollout plan.
 * The policy payload is read from policy_rollout_plans inside the transaction;
 * callers cannot supply a different policy document for the same rollout.
 */
export async function createPolicyChangeRequestForRollout({
  rolloutPlanId,
  authorPrincipalId,
  authorDisplayName = null,
  basePolicyVersionId = null,
} = {}, queryable = db) {
  if (!rolloutPlanId) throw new Error("rolloutPlanId is required");

  return inTransaction(queryable, async (client) => {
    const principal = await requireActivePrincipal(client, authorPrincipalId);

    const existing = await getAuthorityEnvelope(client, rolloutPlanId, { lock: true });
    if (existing) {
      if (String(existing.author_principal_id) !== String(authorPrincipalId)) {
        throw new Error("rollout authority is already bound to a different principal");
      }
      return authoritySummary(existing);
    }

    const { rows: [plan] } = await client.query(
      `SELECT p.id, p.repo_id, p.proposed_config, p.normalized_config, p.created_by
         FROM policy_rollout_plans p
        WHERE p.id = $1
        FOR SHARE`,
      [rolloutPlanId],
    );
    if (!plan) throw new Error(`Rollout plan not found: ${rolloutPlanId}`);

    if (basePolicyVersionId) {
      const { rows: [base] } = await client.query(
        `SELECT id, repo_id FROM policy_versions WHERE id = $1`,
        [basePolicyVersionId],
      );
      if (!base) throw new Error("base policy version not found");
      if (Number(base.repo_id) !== Number(plan.repo_id)) {
        throw new Error("base policy version belongs to a different repository");
      }
    }

    const contentHash = hashPolicyJson(plan.proposed_config);
    const displayName = authorDisplayName || plan.created_by || principal.display_name || null;

    const { rows: [version] } = await client.query(
      `INSERT INTO policy_versions (
         repo_id, base_policy_version_id, policy_document, normalized_document,
         content_hash, author_principal_id, author_display_name
       ) VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, repo_id, base_policy_version_id, content_hash, created_at`,
      [
        plan.repo_id,
        basePolicyVersionId,
        plan.proposed_config,
        plan.normalized_config,
        contentHash,
        authorPrincipalId,
        displayName,
      ],
    );

    const { rows: [request] } = await client.query(
      `INSERT INTO policy_change_requests (
         rollout_plan_id, repo_id, policy_version_id,
         author_principal_id, author_display_name
       ) VALUES ($1, $2, $3, $4, $5)
       RETURNING id, rollout_plan_id, repo_id, policy_version_id,
                 author_principal_id, author_display_name, created_at`,
      [rolloutPlanId, plan.repo_id, version.id, authorPrincipalId, displayName],
    );

    return {
      change_request_id: request.id,
      rollout_plan_id: request.rollout_plan_id,
      repo_id: request.repo_id,
      policy_version_id: request.policy_version_id,
      policy_content_hash: version.content_hash,
      base_policy_version_id: version.base_policy_version_id ?? null,
      author_principal_id: request.author_principal_id,
      author_display_name: request.author_display_name,
      created_at: request.created_at,
    };
  });
}

/**
 * Append immutable evidence for a rollout's authority envelope.
 * Evidence remains appendable only while the compatibility rollout is draft or
 * validated and before any approval/rejection record exists.
 */
export async function appendPolicyEvidenceForRollout({
  rolloutPlanId,
  evidence = {},
  recordedByPrincipalId,
  recordedByDisplayName = null,
} = {}, queryable = db) {
  if (!rolloutPlanId) throw new Error("rolloutPlanId is required");

  const entries = POLICY_EVIDENCE_TYPES
    .filter((type) => evidence[type] !== undefined)
    .map((type) => [type, evidence[type]]);
  if (entries.length === 0) throw new Error("No evidence fields provided");

  return inTransaction(queryable, async (client) => {
    const principal = await requireActivePrincipal(client, recordedByPrincipalId);
    const envelope = await getAuthorityEnvelope(client, rolloutPlanId, { lock: true });
    if (!envelope) throw new Error(`Policy authority not found for rollout plan: ${rolloutPlanId}`);

    if (envelope.rollout_status !== "draft" && envelope.rollout_status !== "validated") {
      throw new Error(`Cannot attach authority evidence to rollout in '${envelope.rollout_status}' state`);
    }

    const { rows: [approval] } = await client.query(
      `SELECT id FROM policy_approval_records WHERE change_request_id = $1 LIMIT 1`,
      [envelope.change_request_id],
    );
    if (approval) {
      throw new Error("Cannot attach authority evidence after an approval decision exists");
    }

    const recorded = [];
    const displayName = recordedByDisplayName || principal.display_name || null;

    for (const [type, payload] of entries) {
      const evidenceHash = hashPolicyJson(payload);
      const { rows } = await client.query(
        `INSERT INTO policy_evidence_records (
           change_request_id, policy_version_id, evidence_type,
           evidence_payload, evidence_hash,
           recorded_by_principal_id, recorded_by_display_name
         ) VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (change_request_id, evidence_type, evidence_hash) DO NOTHING
         RETURNING id, evidence_type, evidence_hash, recorded_at`,
        [
          envelope.change_request_id,
          envelope.policy_version_id,
          type,
          payload,
          evidenceHash,
          recordedByPrincipalId,
          displayName,
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
              AND evidence_hash = $3`,
          [envelope.change_request_id, type, evidenceHash],
        );
        recorded.push(existing);
      }
    }

    return recorded;
  });
}

function evidencePayloadFromEnvelope(envelope, type) {
  return envelope[type];
}

async function buildEvidenceManifest(client, envelope, { requireComplete }) {
  const { rows } = await client.query(
    `SELECT id, evidence_type, evidence_hash, recorded_at
       FROM policy_evidence_records
      WHERE change_request_id = $1
      ORDER BY evidence_type ASC, recorded_at ASC, id ASC`,
    [envelope.change_request_id],
  );

  const manifest = [];
  for (const type of POLICY_EVIDENCE_TYPES) {
    const payload = evidencePayloadFromEnvelope(envelope, type);
    if (payload === null || payload === undefined) {
      if (requireComplete) throw new Error(`Cannot approve: missing required evidence: ${type}`);
      continue;
    }

    const expectedHash = hashPolicyJson(payload);
    const match = [...rows].reverse().find(
      (row) => row.evidence_type === type && row.evidence_hash === expectedHash,
    );
    if (!match) {
      throw new Error(`Authority evidence mismatch for ${type}`);
    }
    manifest.push({
      evidence_type: type,
      evidence_id: match.id,
      evidence_hash: match.evidence_hash,
    });
  }
  return manifest;
}

/**
 * Record an immutable approval/rejection decision bound to an exact immutable
 * policy version and evidence-set hash.
 */
export async function recordPolicyApprovalForRollout({
  rolloutPlanId,
  approverPrincipalId,
  approverDisplayName = null,
  decision,
  reason = null,
  expiresAt = null,
} = {}, queryable = db) {
  if (!rolloutPlanId) throw new Error("rolloutPlanId is required");
  if (decision !== "approved" && decision !== "rejected") {
    throw new Error("decision must be approved or rejected");
  }

  return inTransaction(queryable, async (client) => {
    const principal = await requireActivePrincipal(client, approverPrincipalId);
    const envelope = await getAuthorityEnvelope(client, rolloutPlanId, { lock: true });
    if (!envelope) throw new Error(`Policy authority not found for rollout plan: ${rolloutPlanId}`);
    if (envelope.rollout_status !== "review_ready") {
      throw new Error(`Cannot record authority decision for rollout in '${envelope.rollout_status}' state`);
    }

    if (
      decision === "approved" &&
      String(envelope.author_principal_id) === String(approverPrincipalId)
    ) {
      throw new Error("self-approval is forbidden for policy change requests");
    }

    let normalizedExpiry = null;
    if (expiresAt) {
      const parsed = new Date(expiresAt);
      if (Number.isNaN(parsed.getTime()) || parsed.getTime() <= Date.now()) {
        throw new Error("approval expiry must be a valid future timestamp");
      }
      normalizedExpiry = parsed.toISOString();
    }

    const { rows: [existing] } = await client.query(
      `SELECT id FROM policy_approval_records
        WHERE change_request_id = $1 AND approver_principal_id = $2`,
      [envelope.change_request_id, approverPrincipalId],
    );
    if (existing) {
      throw new Error("approval decision already recorded for this principal");
    }

    const evidenceManifest = await buildEvidenceManifest(client, envelope, {
      requireComplete: decision === "approved",
    });
    const evidenceSetHash = hashPolicyJson(evidenceManifest);
    const displayName = approverDisplayName || principal.display_name || null;

    const { rows: [record] } = await client.query(
      `INSERT INTO policy_approval_records (
         change_request_id, policy_version_id, approver_principal_id,
         approver_display_name, decision, reason,
         evidence_manifest, evidence_set_hash, expires_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id, change_request_id, policy_version_id, approver_principal_id,
                 approver_display_name, decision, reason, evidence_manifest,
                 evidence_set_hash, expires_at, created_at`,
      [
        envelope.change_request_id,
        envelope.policy_version_id,
        approverPrincipalId,
        displayName,
        decision,
        reason,
        evidenceManifest,
        evidenceSetHash,
        normalizedExpiry,
      ],
    );

    return record;
  });
}

export async function getPolicyAuthorityForRollout(rolloutPlanId, queryable = db) {
  if (!rolloutPlanId) throw new Error("rolloutPlanId is required");
  const envelope = await getAuthorityEnvelope(queryable, rolloutPlanId);
  if (!envelope) return null;

  const { rows: evidence } = await queryable.query(
    `SELECT id, evidence_type, evidence_hash, recorded_by_principal_id,
            recorded_by_display_name, recorded_at
       FROM policy_evidence_records
      WHERE change_request_id = $1
      ORDER BY evidence_type ASC, recorded_at ASC, id ASC`,
    [envelope.change_request_id],
  );
  const { rows: approvals } = await queryable.query(
    `SELECT id, approver_principal_id, approver_display_name, decision, reason,
            evidence_manifest, evidence_set_hash, expires_at, created_at
       FROM policy_approval_records
      WHERE change_request_id = $1
      ORDER BY created_at ASC, id ASC`,
    [envelope.change_request_id],
  );

  return {
    ...authoritySummary(envelope),
    evidence,
    approvals,
  };
}

export function isApprovalRecordUsable(record, now = new Date()) {
  if (!record || record.decision !== "approved") return false;
  if (!record.expires_at) return true;
  const expiry = new Date(record.expires_at);
  return !Number.isNaN(expiry.getTime()) && expiry.getTime() > now.getTime();
}

export function assertApprovalRecordUsable(record, now = new Date()) {
  if (!isApprovalRecordUsable(record, now)) {
    throw new Error("approval record is not usable or has expired");
  }
  return true;
}
