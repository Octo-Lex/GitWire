// W2-02 review hardening proof against real PostgreSQL.
// Covers exact rollout/change-request binding, duplicate prevention, and
// storage-level approval/validation backstops discussed in exact-head review.

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";

const { Client } = pg;
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");

async function expectReject(promise, pattern, label) {
  await assert.rejects(promise, pattern, label);
}

const installationId = 982000000001n;
const repositoryId = 982000000002n;
const authorId = randomUUID();
const approverId = randomUUID();
const promoterId = randomUUID();
const rejectorId = randomUUID();

const client = new Client({ connectionString: databaseUrl });
await client.connect();

async function createAuthorityEnvelope({
  suffix,
  basePolicyVersionId = null,
  validationValid = true,
  approvalCreatedAt = null,
  approvalExpiresAt = null,
}) {
  const policy = { dry_run: true, review: { enabled: true, suffix } };
  const { rows: [rollout] } = await client.query(
    `INSERT INTO policy_rollout_plans (
       repo_id, proposed_config, normalized_config, status,
       created_by, approved_by, approved_at
     ) VALUES ($1, $2, $2, 'approved', $3, $4, NOW())
     RETURNING id`,
    [repositoryId.toString(), policy, `legacy-author-${suffix}`, `legacy-approver-${suffix}`],
  );

  const { rows: [version] } = await client.query(
    `INSERT INTO policy_versions (
       repo_id, base_policy_version_id, policy_document,
       normalized_document, author_principal_id
     ) VALUES ($1, $2, $3, $3, $4)
     RETURNING id`,
    [repositoryId.toString(), basePolicyVersionId, policy, authorId],
  );

  const { rows: [changeRequest] } = await client.query(
    `INSERT INTO policy_change_requests (
       rollout_plan_id, repo_id, policy_version_id, author_principal_id
     ) VALUES ($1, $2, $3, $4)
     RETURNING id`,
    [rollout.id, repositoryId.toString(), version.id, authorId],
  );

  const payloads = [
    ["validation_result", { valid: validationValid, errors: validationValid ? [] : ["forced-invalid"] }],
    ["simulation_summary", { events_considered: 1 }],
    ["diff_impact_summary", { risk: "low" }],
    ["recommendations_summary", { recommendations: [] }],
  ];
  const manifest = [];
  for (const [type, payload] of payloads) {
    const { rows: [evidence] } = await client.query(
      `INSERT INTO policy_evidence_records (
         change_request_id, policy_version_id, evidence_type,
         evidence_payload, recorded_by_principal_id
       ) VALUES ($1, $2, $3, $4, $5)
       RETURNING id, evidence_type, evidence_hash`,
      [changeRequest.id, version.id, type, payload, authorId],
    );
    manifest.push({
      evidence_type: evidence.evidence_type,
      evidence_id: evidence.id,
      evidence_hash: evidence.evidence_hash,
    });
  }

  const { rows: [approval] } = await client.query(
    `INSERT INTO policy_approval_records (
       change_request_id, policy_version_id, approver_principal_id,
       decision, reason, evidence_manifest, created_at, expires_at
     ) VALUES (
       $1, $2, $3, 'approved', $4, $5::jsonb,
       COALESCE($6::timestamptz, NOW()), $7::timestamptz
     )
     RETURNING id, evidence_set_hash`,
    [
      changeRequest.id,
      version.id,
      approverId,
      `approved-${suffix}`,
      JSON.stringify(manifest),
      approvalCreatedAt,
      approvalExpiresAt,
    ],
  );

  return { rollout, version, changeRequest, approval };
}

async function insertPromotion({ envelope, rolloutPlanId = envelope.rollout.id, previousPolicyVersionId = null }) {
  return client.query(
    `INSERT INTO policy_promotion_records (
       repo_id, rollout_plan_id, change_request_id, policy_version_id,
       previous_policy_version_id, approval_record_id,
       author_principal_id, approver_principal_id, promoter_principal_id,
       evidence_set_hash, reason
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     RETURNING *`,
    [
      repositoryId.toString(),
      rolloutPlanId,
      envelope.changeRequest.id,
      envelope.version.id,
      previousPolicyVersionId,
      envelope.approval.id,
      authorId,
      approverId,
      promoterId,
      envelope.approval.evidence_set_hash,
      `review-hardening-${envelope.version.id}`,
    ],
  );
}

try {
  await client.query(
    `INSERT INTO installations (github_id, account_login, account_type)
     VALUES ($1, 'w2-promotion-review-ci', 'Organization')`,
    [installationId.toString()],
  );
  await client.query(
    `INSERT INTO repositories (github_id, installation_id, full_name, owner, name)
     VALUES ($1, $2, 'w2-promotion-review-ci/repo', 'w2-promotion-review-ci', 'repo')`,
    [repositoryId.toString(), installationId.toString()],
  );
  await client.query(
    `INSERT INTO gitwire_auth.auth_principals (id, principal_type, display_name)
     VALUES
       ($1, 'user', 'review-author'),
       ($2, 'user', 'review-approver'),
       ($3, 'user', 'review-promoter'),
       ($4, 'user', 'review-rejector')`,
    [authorId, approverId, promoterId, rejectorId],
  );

  const first = await createAuthorityEnvelope({ suffix: "first" });
  const { rows: [decoyRollout] } = await client.query(
    `INSERT INTO policy_rollout_plans (
       repo_id, proposed_config, normalized_config, status,
       created_by, approved_by, approved_at
     ) VALUES ($1, $2, $2, 'approved', 'decoy-author', 'decoy-approver', NOW())
     RETURNING id`,
    [repositoryId.toString(), { dry_run: true, review: { enabled: true, suffix: "decoy" } }],
  );

  await expectReject(
    insertPromotion({ envelope: first, rolloutPlanId: decoyRollout.id }),
    /fk_policy_promotion_change_rollout|violates foreign key constraint/,
    "promotion must bind the rollout plan owned by its exact change request",
  );

  const { rows: [promotion1] } = await insertPromotion({ envelope: first });
  await client.query(
    `INSERT INTO active_policy_bindings (
       repo_id, policy_version_id, promotion_record_id, change_request_id,
       approval_record_id, author_principal_id, approver_principal_id,
       promoter_principal_id, evidence_set_hash
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      repositoryId.toString(),
      first.version.id,
      promotion1.id,
      first.changeRequest.id,
      first.approval.id,
      authorId,
      approverId,
      promoterId,
      first.approval.evidence_set_hash,
    ],
  );

  await expectReject(
    insertPromotion({ envelope: first, previousPolicyVersionId: first.version.id }),
    /uq_policy_promotion_change_request|uq_policy_promotion_version|duplicate key value/,
    "one change request/version cannot produce duplicate immutable promotion records",
  );

  const rejected = await createAuthorityEnvelope({
    suffix: "rejected",
    basePolicyVersionId: first.version.id,
  });
  await client.query(
    `INSERT INTO policy_approval_records (
       change_request_id, policy_version_id, approver_principal_id,
       decision, reason, evidence_manifest
     ) VALUES ($1, $2, $3, 'rejected', 'review rejection', '[]'::jsonb)`,
    [rejected.changeRequest.id, rejected.version.id, rejectorId],
  );
  await expectReject(
    insertPromotion({ envelope: rejected, previousPolicyVersionId: first.version.id }),
    /promotion is blocked by a rejection record/,
    "storage backstop blocks promotion when any rejection record exists",
  );

  const now = Date.now();
  const expired = await createAuthorityEnvelope({
    suffix: "expired",
    basePolicyVersionId: first.version.id,
    approvalCreatedAt: new Date(now - 2 * 60 * 60 * 1000).toISOString(),
    approvalExpiresAt: new Date(now - 60 * 60 * 1000).toISOString(),
  });
  await expectReject(
    insertPromotion({ envelope: expired, previousPolicyVersionId: first.version.id }),
    /promotion approval is expired/,
    "storage backstop rejects an approval expired at the transaction authority snapshot",
  );

  const invalid = await createAuthorityEnvelope({
    suffix: "invalid",
    basePolicyVersionId: first.version.id,
    validationValid: false,
  });
  await expectReject(
    insertPromotion({ envelope: invalid, previousPolicyVersionId: first.version.id }),
    /promotion validation evidence is not explicitly valid/,
    "storage backstop requires validation_result.valid === true",
  );

  console.log("W2-02 Postgres review hardening invariants: PASS");
} finally {
  await client.end();
}
