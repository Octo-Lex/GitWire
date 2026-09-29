// W2-03 real-PostgreSQL governed writer cutover proof.
//
// Proves the public rollout compatibility lifecycle is backed by immutable W2-01
// authority, W2-02 remains the only live-policy writer, and the deferred DB
// boundary rejects direct/internal repo_config mutation after migration 047.

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";

const { Client } = pg;
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");

const installationId = 989300001;
const repositoryId = 989300002;
const ungovernedRepositoryId = 989300003;
const authorId = randomUUID();
const approverId = randomUUID();
const promoterId = randomUUID();
const grantorId = randomUUID();
const roleId = randomUUID();
const roleName = `w2-03-governed-writers-${randomUUID()}`;

const policy = {
  dry_run: true,
  review: { enabled: true, generation: 3 },
};
const divergentPolicy = {
  dry_run: false,
  review: { enabled: false, generation: 999 },
};

const client = new Client({ connectionString: databaseUrl });
await client.connect();

try {
  await client.query(
    `INSERT INTO installations (github_id, account_login, account_type)
     VALUES ($1, 'w2-03-governed-writers', 'Organization')`,
    [installationId],
  );
  await client.query(
    `INSERT INTO repositories (github_id, installation_id, full_name, owner, name)
     VALUES
       ($1, $3, 'w2-03-governed-writers/repo', 'w2-03-governed-writers', 'repo'),
       ($2, $3, 'w2-03-governed-writers/ungoverned', 'w2-03-governed-writers', 'ungoverned')`,
    [repositoryId, ungovernedRepositoryId, installationId],
  );

  await client.query(
    `INSERT INTO gitwire_auth.auth_principals (id, principal_type, display_name)
     VALUES
       ($1, 'user', 'w2-03-author'),
       ($2, 'user', 'w2-03-approver'),
       ($3, 'user', 'w2-03-promoter'),
       ($4, 'user', 'w2-03-grantor')`,
    [authorId, approverId, promoterId, grantorId],
  );
  await client.query(
    `INSERT INTO gitwire_auth.auth_roles (id, name, description)
     VALUES ($1, $2, 'Disposable W2-03 governed-writer proof role')`,
    [roleId, roleName],
  );
  await client.query(
    `INSERT INTO gitwire_auth.auth_role_permissions (role_id, permission)
     VALUES
       ($1, 'policy_definition:create'),
       ($1, 'policy_rollout_plan:update'),
       ($1, 'policy_rollout_plan:approve')`,
    [roleId],
  );
  await client.query(
    `INSERT INTO gitwire_auth.auth_principal_roles (
       principal_id, role_id, scope_type, scope_id, granted_by
     ) VALUES
       ($1, $4, 'repository', $5, $6),
       ($2, $4, 'repository', $5, $6),
       ($3, $4, 'repository', $5, $6)`,
    [authorId, approverId, promoterId, roleId, repositoryId, grantorId],
  );

  const { initRuntime } = await import("@gitwire/runtime");
  initRuntime({
    server: { env: "test", logLevel: "silent" },
    db: { url: databaseUrl },
    redis: { url: process.env.REDIS_URL || "redis://127.0.0.1:6379" },
    github: {},
  });

  const {
    createGovernedRolloutPlan,
    attachGovernedEvidence,
    approveGovernedRollout,
  } = await import("../../src/services/policyRolloutGovernanceService.js");
  const { transitionRolloutPlan } = await import("../../src/services/policyRolloutService.js");
  const { promotePolicyRollout } = await import("../../src/services/policyPromotionService.js");
  const { setConfigOverrides } = await import("../../src/services/configService.js");

  const authorPrincipal = {
    principalId: authorId,
    authenticationMethod: "api_key",
  };
  const approverPrincipal = {
    principalId: approverId,
    authenticationMethod: "api_key",
  };
  const promoterPrincipal = {
    principalId: promoterId,
    authenticationMethod: "api_key",
  };

  const created = await createGovernedRolloutPlan({
    repo: "w2-03-governed-writers/repo",
    proposedConfig: policy,
    compatibilityActor: "legacy-author-label",
    principal: authorPrincipal,
  });
  assert.equal(created.status, "draft");
  assert.equal(created.created_by, "legacy-author-label");

  const { rows: [authority] } = await client.query(
    `SELECT cr.id AS change_request_id,
            cr.author_principal_id,
            pv.id AS policy_version_id,
            pv.base_policy_version_id,
            pv.policy_document
       FROM policy_change_requests cr
       JOIN policy_versions pv ON pv.id = cr.policy_version_id
      WHERE cr.rollout_plan_id = $1`,
    [created.id],
  );
  assert.ok(authority, "governed create must persist immutable W2-01 authority");
  assert.equal(authority.author_principal_id, authorId);
  assert.equal(authority.base_policy_version_id, null);
  assert.deepEqual(authority.policy_document, policy);

  const evidence = {
    validation_result: { valid: true, errors: [] },
    simulation_summary: { events_considered: 5, would_act: 2 },
    diff_impact_summary: { risk: "low" },
    recommendations_summary: { recommendations: [] },
  };
  const withEvidence = await attachGovernedEvidence({
    rolloutPlanId: Number(created.id),
    evidence,
    principal: authorPrincipal,
  });
  assert.deepEqual(withEvidence.validation_result, evidence.validation_result);

  const { rows: [evidenceCount] } = await client.query(
    `SELECT count(*)::int AS count
       FROM policy_evidence_records
      WHERE change_request_id = $1`,
    [authority.change_request_id],
  );
  assert.equal(evidenceCount.count, 4, "all compatibility evidence must be immutable W2-01 evidence");

  await transitionRolloutPlan(Number(created.id), {
    status: "validated",
    actor: "legacy-author-label",
  });
  await transitionRolloutPlan(Number(created.id), {
    status: "review_ready",
    actor: "legacy-author-label",
  });

  const approved = await approveGovernedRollout({
    rolloutPlanId: Number(created.id),
    principal: approverPrincipal,
    compatibilityActor: "spoofable-display-label",
    reason: "w2-03 governed approval proof",
    acknowledgedRecommendations: [],
  });
  assert.equal(approved.status, "approved");
  assert.equal(approved.approved_by, "spoofable-display-label");

  const { rows: [approval] } = await client.query(
    `SELECT approver_principal_id, decision, evidence_manifest
       FROM policy_approval_records
      WHERE change_request_id = $1`,
    [authority.change_request_id],
  );
  assert.ok(approval, "governed approve must persist immutable approval authority");
  assert.equal(approval.approver_principal_id, approverId);
  assert.equal(approval.decision, "approved");
  assert.equal(approval.evidence_manifest.length, 4);

  const promoted = await promotePolicyRollout({
    rolloutPlanId: Number(created.id),
    principal: promoterPrincipal,
    reason: "w2-03 canonical promotion proof",
  });
  assert.equal(promoted.rollout.status, "promoted");
  assert.equal(promoted.promotion.policy_version_id, authority.policy_version_id);

  const expectedActor = `policy-promotion:${promoterId}:${created.id}`;
  const { rows: [live] } = await client.query(
    `SELECT rc.config,
            rc.updated_by,
            rc.updated_at,
            apb.policy_version_id,
            pr.promoted_at
       FROM repo_config rc
       JOIN active_policy_bindings apb ON apb.repo_id = rc.repo_id
       JOIN policy_promotion_records pr ON pr.id = apb.promotion_record_id
      WHERE rc.repo_id = $1`,
    [repositoryId],
  );
  assert.ok(live);
  assert.deepEqual(live.config, policy);
  assert.equal(live.updated_by, expectedActor);
  assert.equal(live.policy_version_id, authority.policy_version_id);
  assert.equal(
    new Date(live.updated_at).getTime(),
    new Date(live.promoted_at).getTime(),
    "live compatibility clock must remain the immutable promotion clock",
  );

  await assert.rejects(
    client.query(
      `UPDATE repo_config
          SET config = $2::jsonb,
              updated_by = 'direct-sql-bypass'
        WHERE repo_id = $1`,
      [repositoryId, JSON.stringify(divergentPolicy)],
    ),
    /repo_config live materialization does not match governed promotion/,
    "raw SQL cannot rewrite governed live policy",
  );

  await assert.rejects(
    setConfigOverrides(
      "w2-03-governed-writers/repo",
      divergentPolicy,
      "legacy-config-service",
      "set",
    ),
    /repo_config live materialization does not match governed promotion/,
    "legacy config service cannot bypass governed promotion",
  );

  await assert.rejects(
    client.query(`DELETE FROM repo_config WHERE repo_id = $1`, [repositoryId]),
    /repo_config live materialization requires governed active policy binding/,
    "direct delete cannot remove governed live materialization",
  );

  await assert.rejects(
    client.query(
      `INSERT INTO repo_config (repo_id, config, updated_by)
       VALUES ($1, $2::jsonb, 'ungoverned-insert')`,
      [ungovernedRepositoryId, JSON.stringify(divergentPolicy)],
    ),
    /repo_config live materialization requires governed active policy binding/,
    "a fresh repository cannot acquire live overrides without governed promotion",
  );

  const { rows: [afterBypassAttempts] } = await client.query(
    `SELECT config, updated_by FROM repo_config WHERE repo_id = $1`,
    [repositoryId],
  );
  assert.deepEqual(afterBypassAttempts.config, policy);
  assert.equal(afterBypassAttempts.updated_by, expectedActor);

  console.log("W2-03 governed writer cutover: PASS");
} finally {
  await client.end();
}

process.exit(0);
