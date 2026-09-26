// W2-02 real-Postgres promotion authority proof.
// Exercises migration 046 directly against ephemeral PostgreSQL.

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";

const { Client } = pg;
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");

async function expectReject(promise, pattern, label) {
  await assert.rejects(promise, pattern, label);
}

const installationId = 981000000001n;
const repositoryId = 981000000002n;
const authorId = randomUUID();
const approverId = randomUUID();
const promoterId = randomUUID();
const otherPromoterId = randomUUID();

const client = new Client({ connectionString: databaseUrl });
await client.connect();

async function createAuthorityEnvelope({
  policy,
  basePolicyVersionId = null,
  suffix,
}) {
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
    ["validation_result", { valid: true, errors: [] }],
    ["simulation_summary", { events_considered: 4, would_act: 1 }],
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
       decision, reason, evidence_manifest
     ) VALUES ($1, $2, $3, 'approved', $4, $5::jsonb)
     RETURNING id, evidence_set_hash`,
    [
      changeRequest.id,
      version.id,
      approverId,
      `approved-${suffix}`,
      JSON.stringify(manifest),
    ],
  );

  return { rollout, version, changeRequest, approval };
}

try {
  await client.query(
    `INSERT INTO installations (github_id, account_login, account_type)
     VALUES ($1, 'w2-promotion-ci', 'Organization')`,
    [installationId.toString()],
  );
  await client.query(
    `INSERT INTO repositories (github_id, installation_id, full_name, owner, name)
     VALUES ($1, $2, 'w2-promotion-ci/repo', 'w2-promotion-ci', 'repo')`,
    [repositoryId.toString(), installationId.toString()],
  );
  await client.query(
    `INSERT INTO gitwire_auth.auth_principals (id, principal_type, display_name)
     VALUES
       ($1, 'user', 'w2-author'),
       ($2, 'user', 'w2-approver'),
       ($3, 'user', 'w2-promoter'),
       ($4, 'user', 'w2-other-promoter')`,
    [authorId, approverId, promoterId, otherPromoterId],
  );

  const first = await createAuthorityEnvelope({
    policy: { dry_run: true, review: { enabled: true, generation: 1 } },
    suffix: "first",
  });

  // Separation of duties is also storage-enforced.
  await expectReject(
    client.query(
      `INSERT INTO policy_promotion_records (
         repo_id, rollout_plan_id, change_request_id, policy_version_id,
         previous_policy_version_id, approval_record_id,
         author_principal_id, approver_principal_id, promoter_principal_id,
         evidence_set_hash, reason
       ) VALUES ($1,$2,$3,$4,NULL,$5,$6,$7,$6,$8,'bad-self-promoter')`,
      [
        repositoryId.toString(),
        first.rollout.id,
        first.changeRequest.id,
        first.version.id,
        first.approval.id,
        authorId,
        approverId,
        first.approval.evidence_set_hash,
      ],
    ),
    /chk_policy_promotion_promoter_not_author|violates check constraint/,
    "author cannot promote their own policy",
  );

  const { rows: [promotion1] } = await client.query(
    `INSERT INTO policy_promotion_records (
       repo_id, rollout_plan_id, change_request_id, policy_version_id,
       previous_policy_version_id, approval_record_id,
       author_principal_id, approver_principal_id, promoter_principal_id,
       evidence_set_hash, reason
     ) VALUES ($1,$2,$3,$4,NULL,$5,$6,$7,$8,$9,'first governed promotion')
     RETURNING *`,
    [
      repositoryId.toString(),
      first.rollout.id,
      first.changeRequest.id,
      first.version.id,
      first.approval.id,
      authorId,
      approverId,
      promoterId,
      first.approval.evidence_set_hash,
    ],
  );

  const { rows: [binding1] } = await client.query(
    `INSERT INTO active_policy_bindings (
       repo_id, policy_version_id, promotion_record_id, change_request_id,
       approval_record_id, author_principal_id, approver_principal_id,
       promoter_principal_id, evidence_set_hash
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     RETURNING *`,
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
  assert.equal(binding1.policy_version_id, first.version.id);

  // Active binding cannot claim fields that do not match its immutable record.
  await expectReject(
    client.query(
      `UPDATE active_policy_bindings
          SET promoter_principal_id = $1
        WHERE repo_id = $2`,
      [otherPromoterId, repositoryId.toString()],
    ),
    /does not match immutable promotion record/,
    "active binding tuple must match its immutable promotion record",
  );

  const second = await createAuthorityEnvelope({
    policy: { dry_run: true, review: { enabled: true, generation: 2 } },
    basePolicyVersionId: first.version.id,
    suffix: "second",
  });

  // Once a governed active version exists, DB insertion itself rejects a stale
  // or omitted previous version even if application checks are bypassed.
  await expectReject(
    client.query(
      `INSERT INTO policy_promotion_records (
         repo_id, rollout_plan_id, change_request_id, policy_version_id,
         previous_policy_version_id, approval_record_id,
         author_principal_id, approver_principal_id, promoter_principal_id,
         evidence_set_hash, reason
       ) VALUES ($1,$2,$3,$4,NULL,$5,$6,$7,$8,$9,'stale base')`,
      [
        repositoryId.toString(),
        second.rollout.id,
        second.changeRequest.id,
        second.version.id,
        second.approval.id,
        authorId,
        approverId,
        otherPromoterId,
        second.approval.evidence_set_hash,
      ],
    ),
    /stale policy promotion base/,
    "promotion insert must bind the current active policy as previous version",
  );

  const { rows: [promotion2] } = await client.query(
    `INSERT INTO policy_promotion_records (
       repo_id, rollout_plan_id, change_request_id, policy_version_id,
       previous_policy_version_id, approval_record_id,
       author_principal_id, approver_principal_id, promoter_principal_id,
       evidence_set_hash, reason
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'second governed promotion')
     RETURNING *`,
    [
      repositoryId.toString(),
      second.rollout.id,
      second.changeRequest.id,
      second.version.id,
      first.version.id,
      second.approval.id,
      authorId,
      approverId,
      otherPromoterId,
      second.approval.evidence_set_hash,
    ],
  );

  const { rows: [binding2] } = await client.query(
    `UPDATE active_policy_bindings
        SET policy_version_id = $1,
            promotion_record_id = $2,
            change_request_id = $3,
            approval_record_id = $4,
            author_principal_id = $5,
            approver_principal_id = $6,
            promoter_principal_id = $7,
            evidence_set_hash = $8
      WHERE repo_id = $9
    RETURNING *`,
    [
      second.version.id,
      promotion2.id,
      second.changeRequest.id,
      second.approval.id,
      authorId,
      approverId,
      otherPromoterId,
      second.approval.evidence_set_hash,
      repositoryId.toString(),
    ],
  );
  assert.equal(binding2.policy_version_id, second.version.id);

  // Append-only promotion history and non-removable active pointer.
  await expectReject(
    client.query(`UPDATE policy_promotion_records SET reason = 'rewrite' WHERE id = $1`, [promotion1.id]),
    /policy_promotion_records is append-only/,
    "promotion record update must be blocked",
  );
  await expectReject(
    client.query(`DELETE FROM policy_promotion_records WHERE id = $1`, [promotion1.id]),
    /policy_promotion_records is append-only/,
    "promotion record delete must be blocked",
  );
  await expectReject(
    client.query(`DELETE FROM active_policy_bindings WHERE repo_id = $1`, [repositoryId.toString()]),
    /active_policy_bindings is append-only/,
    "active policy pointer cannot be removed",
  );

  const functionNames = [
    "prepare_w2_policy_promotion_insert",
    "prepare_w2_active_policy_binding_write",
    "enforce_w2_policy_promotion_append_only",
  ];
  const { rows: functions } = await client.query(
    `SELECT proname, proconfig
       FROM pg_proc
      WHERE proname = ANY($1::text[])`,
    [functionNames],
  );
  assert.equal(functions.length, functionNames.length);
  for (const row of functions) {
    assert.ok(
      row.proconfig?.includes("search_path=pg_catalog, public, pg_temp"),
      `${row.proname} must pin pg_catalog first`,
    );
  }

  console.log("W2-02 Postgres promotion invariants: PASS");
} finally {
  await client.end();
}
