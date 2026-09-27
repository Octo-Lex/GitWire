// W2-02 real-Postgres service-path proof.
// Drives promotePolicyRollout through the production DB/auth code and verifies
// the atomic materialization, authority binding, compatibility history/state,
// and the fail-closed legacy rollback guard.

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";

const { Client } = pg;
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");

const installationId = 982000001;
const repositoryId = 982000002;
const authorId = randomUUID();
const approverId = randomUUID();
const promoterId = randomUUID();
const grantorId = randomUUID();
const roleId = randomUUID();
const roleName = `w2-service-proof-${randomUUID()}`;

const oldPolicy = {
  dry_run: true,
  review: { enabled: true, generation: 0 },
};
const newPolicy = {
  dry_run: true,
  review: { enabled: true, generation: 1 },
};

const client = new Client({ connectionString: databaseUrl });
await client.connect();

async function seedAuthorityEnvelope() {
  const { rows: [rollout] } = await client.query(
    `INSERT INTO policy_rollout_plans (
       repo_id, proposed_config, normalized_config, status,
       created_by, approved_by, approved_at
     ) VALUES ($1, $2, $2, 'approved', 'legacy-author', 'legacy-approver', NOW())
     RETURNING id`,
    [repositoryId, newPolicy],
  );

  const { rows: [version] } = await client.query(
    `INSERT INTO policy_versions (
       repo_id, base_policy_version_id, policy_document,
       normalized_document, author_principal_id
     ) VALUES ($1, NULL, $2, $2, $3)
     RETURNING id`,
    [repositoryId, newPolicy, authorId],
  );

  const { rows: [changeRequest] } = await client.query(
    `INSERT INTO policy_change_requests (
       rollout_plan_id, repo_id, policy_version_id, author_principal_id
     ) VALUES ($1, $2, $3, $4)
     RETURNING id`,
    [rollout.id, repositoryId, version.id, authorId],
  );

  const payloads = [
    ["validation_result", { valid: true, errors: [] }],
    ["simulation_summary", { events_considered: 3, would_act: 1 }],
    ["diff_impact_summary", { risk: "low" }],
    ["recommendations_summary", { recommendations: [] }],
  ];
  const manifest = [];
  for (const [evidenceType, evidencePayload] of payloads) {
    const { rows: [evidence] } = await client.query(
      `INSERT INTO policy_evidence_records (
         change_request_id, policy_version_id, evidence_type,
         evidence_payload, recorded_by_principal_id
       ) VALUES ($1, $2, $3, $4, $5)
       RETURNING id, evidence_type, evidence_hash`,
      [changeRequest.id, version.id, evidenceType, evidencePayload, authorId],
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
     ) VALUES ($1, $2, $3, 'approved', 'service-path approval', $4::jsonb)
     RETURNING id, evidence_set_hash`,
    [changeRequest.id, version.id, approverId, JSON.stringify(manifest)],
  );

  return { rollout, version, changeRequest, approval };
}

try {
  await client.query(
    `INSERT INTO installations (github_id, account_login, account_type)
     VALUES ($1, 'w2-service-proof', 'Organization')`,
    [installationId],
  );
  await client.query(
    `INSERT INTO repositories (github_id, installation_id, full_name, owner, name)
     VALUES ($1, $2, 'w2-service-proof/repo', 'w2-service-proof', 'repo')`,
    [repositoryId, installationId],
  );

  await client.query(
    `INSERT INTO gitwire_auth.auth_principals (id, principal_type, display_name)
     VALUES
       ($1, 'user', 'w2-service-author'),
       ($2, 'user', 'w2-service-approver'),
       ($3, 'user', 'w2-service-promoter'),
       ($4, 'user', 'w2-service-grantor')`,
    [authorId, approverId, promoterId, grantorId],
  );
  await client.query(
    `INSERT INTO gitwire_auth.auth_roles (id, name, description)
     VALUES ($1, $2, 'Disposable W2-02 service-path proof role')`,
    [roleId, roleName],
  );
  await client.query(
    `INSERT INTO gitwire_auth.auth_role_permissions (role_id, permission)
     VALUES ($1, 'policy_rollout_plan:approve')`,
    [roleId],
  );
  await client.query(
    `INSERT INTO gitwire_auth.auth_principal_roles (
       principal_id, role_id, scope_type, scope_id, granted_by
     ) VALUES
       ($1, $3, 'repository', $4, $5),
       ($2, $3, 'repository', $4, $5)`,
    [approverId, promoterId, roleId, repositoryId, grantorId],
  );

  await client.query(
    `INSERT INTO repo_config (repo_id, config, updated_by)
     VALUES ($1, $2::jsonb, 'service-proof-seed')`,
    [repositoryId, JSON.stringify(oldPolicy)],
  );

  const authority = await seedAuthorityEnvelope();
  const { promotePolicyRollout } = await import("../../src/services/policyPromotionService.js");

  const committed = await promotePolicyRollout({
    rolloutPlanId: Number(authority.rollout.id),
    principal: {
      principalId: promoterId,
      authenticationMethod: "api_key",
    },
    reason: "service-path-proof",
  });

  assert.equal(committed.rollout.status, "promoted");
  assert.equal(committed.promotion.policy_version_id, authority.version.id);
  assert.equal(committed.activePolicy.policy_version_id, authority.version.id);

  const actorToken = `policy-promotion:${promoterId}:${authority.rollout.id}`;

  const { rows: [promotion] } = await client.query(
    `SELECT * FROM policy_promotion_records WHERE rollout_plan_id = $1`,
    [authority.rollout.id],
  );
  assert.ok(promotion, "service must persist an immutable promotion record");
  assert.equal(promotion.change_request_id, authority.changeRequest.id);
  assert.equal(promotion.policy_version_id, authority.version.id);
  assert.equal(promotion.approval_record_id, authority.approval.id);
  assert.equal(promotion.author_principal_id, authorId);
  assert.equal(promotion.approver_principal_id, approverId);
  assert.equal(promotion.promoter_principal_id, promoterId);
  assert.equal(promotion.evidence_set_hash, authority.approval.evidence_set_hash);
  assert.equal(promotion.reason, "service-path-proof");

  const { rows: [binding] } = await client.query(
    `SELECT * FROM active_policy_bindings WHERE repo_id = $1`,
    [repositoryId],
  );
  assert.ok(binding, "service must persist the governed active binding");
  assert.equal(binding.policy_version_id, authority.version.id);
  assert.equal(binding.promotion_record_id, promotion.id);
  assert.equal(binding.change_request_id, authority.changeRequest.id);
  assert.equal(binding.approval_record_id, authority.approval.id);

  const { rows: [materialized] } = await client.query(
    `SELECT config, updated_by FROM repo_config WHERE repo_id = $1`,
    [repositoryId],
  );
  assert.deepEqual(materialized.config, newPolicy);
  assert.equal(materialized.updated_by, actorToken);

  const { rows: [history] } = await client.query(
    `SELECT action, config_old, config_new, changed_by
       FROM config_history
      WHERE repo_id = $1
      ORDER BY changed_at DESC, id DESC
      LIMIT 1`,
    [repositoryId],
  );
  assert.ok(history, "service must persist compatibility config history");
  assert.equal(history.action, "set");
  assert.deepEqual(history.config_old, oldPolicy);
  assert.deepEqual(history.config_new, newPolicy);
  assert.equal(history.changed_by, actorToken);

  const { rows: [rolloutState] } = await client.query(
    `SELECT status, promoted_by, promotion_reason, previous_config
       FROM policy_rollout_plans
      WHERE id = $1`,
    [authority.rollout.id],
  );
  assert.equal(rolloutState.status, "promoted");
  assert.equal(rolloutState.promoted_by, promoterId);
  assert.equal(rolloutState.promotion_reason, "service-path-proof");
  assert.deepEqual(rolloutState.previous_config, oldPolicy);

  const { rows: authRows } = await client.query(
    `SELECT principal_id, allowed, observe_mode
       FROM gitwire_auth.auth_decision_log
      WHERE permission = 'policy_rollout_plan:approve'
        AND resource_repository_id = $1
        AND principal_id = ANY($2::uuid[])
      ORDER BY decided_at ASC`,
    [repositoryId, [promoterId, approverId]],
  );
  assert.equal(authRows.length, 2, "promoter and approver decisions must persist");
  assert.deepEqual(
    new Set(authRows.map((row) => row.principal_id)),
    new Set([promoterId, approverId]),
  );
  for (const row of authRows) {
    assert.equal(row.allowed, true);
    assert.equal(row.observe_mode, false);
  }

  await assert.rejects(
    client.query(
      `UPDATE repo_config
          SET config = $2::jsonb,
              updated_by = $3
        WHERE repo_id = $1`,
      [
        repositoryId,
        JSON.stringify(oldPolicy),
        `rollout-rollback:legacy:${authority.rollout.id}`,
      ],
    ),
    /legacy rollback is disabled for governed active policy/,
    "legacy rollback materialization must fail closed after governed promotion",
  );

  const { rows: [afterRollbackAttempt] } = await client.query(
    `SELECT config, updated_by FROM repo_config WHERE repo_id = $1`,
    [repositoryId],
  );
  assert.deepEqual(afterRollbackAttempt.config, newPolicy);
  assert.equal(afterRollbackAttempt.updated_by, actorToken);

  console.log("W2-02 Postgres service path: PASS");
} finally {
  await client.end();
}

// The production service imports shared DB/Redis singletons. Explicit process
// termination keeps this standalone CI proof from waiting on those open handles.
process.exit(0);
