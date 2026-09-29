// W2-03 real-PostgreSQL governed-writer cutover proof.
//
// Drives compatibility rollout authoring through the W2-01 immutable authority
// service, promotes only through W2-02, then proves direct config, legacy
// promotion, and legacy rollback writers cannot change committed live policy.

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";

const { Client } = pg;
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");

const installationId = 989300001;
const repositoryId = 989300002;
const bypassRepositoryId = 989300003;
const authorId = randomUUID();
const approverId = randomUUID();
const promoterId = randomUUID();
const grantorId = randomUUID();
const roleId = randomUUID();
const roleName = `w2-03-writers-${randomUUID()}`;
const repoFullName = "w2-03-writers/repo";

const policy1 = {
  settings: { dry_run: true },
  review: { enabled: true, generation: 1 },
};
const policy2 = {
  settings: { dry_run: true },
  review: { enabled: true, generation: 2 },
};
const policy3 = {
  settings: { dry_run: true },
  review: { enabled: true, generation: 3 },
};

const principal = (principalId) => ({
  principalId,
  authenticationMethod: "api_key",
});

const client = new Client({ connectionString: databaseUrl });
await client.connect();

try {
  await client.query(
    `INSERT INTO installations (github_id, account_login, account_type)
     VALUES ($1, 'w2-03-writers', 'Organization')`,
    [installationId],
  );
  await client.query(
    `INSERT INTO repositories (github_id, installation_id, full_name, owner, name)
     VALUES
       ($1, $3, $4, 'w2-03-writers', 'repo'),
       ($2, $3, 'w2-03-writers/bypass', 'w2-03-writers', 'bypass')`,
    [repositoryId, bypassRepositoryId, installationId, repoFullName],
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
     VALUES ($1, $2, 'Disposable W2-03 governed writer proof role')`,
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
    attachGovernedRolloutEvidence,
    transitionGovernedRolloutPlan,
    approveGovernedRolloutPlan,
  } = await import("../../src/services/governedPolicyWriterService.js");
  const { promotePolicyRollout } = await import("../../src/services/policyPromotionService.js");
  const {
    promoteRolloutPlan,
    rollbackRolloutPlan,
  } = await import("../../src/services/policyRolloutService.js");
  const {
    setConfigOverrides,
    deleteConfigOverrides,
    restoreConfigVersion,
  } = await import("../../src/services/configService.js");
  const { redis } = await import("../../src/lib/queue.js");

  async function createApproved(policy, suffix) {
    const plan = await createGovernedRolloutPlan({
      repo: repoFullName,
      proposed_config: policy,
      created_by: `legacy-display-${suffix}`,
      principal: principal(authorId),
    });

    await attachGovernedRolloutEvidence(
      Number(plan.id),
      {
        validation_result: { valid: true, errors: [] },
        simulation_summary: { events_considered: 3, would_act: 1 },
        diff_impact_summary: { risk: "low", suffix },
        recommendations_summary: { recommendations: [], summary: { critical: 0, warning: 0, info: 0 } },
      },
      { principal: principal(authorId) },
    );
    await transitionGovernedRolloutPlan(Number(plan.id), {
      status: "validated",
      principal: principal(authorId),
    });
    await transitionGovernedRolloutPlan(Number(plan.id), {
      status: "review_ready",
      principal: principal(authorId),
    });
    const approved = await approveGovernedRolloutPlan(Number(plan.id), {
      principal: principal(approverId),
      reason: `approved-${suffix}`,
      // Non-empty on purpose: node-postgres serializes JS arrays as PostgreSQL
      // array literals unless bound as JSON strings, which corrupts or rejects
      // the jsonb write (the defect this approval exercises).
      acknowledged_recommendations: ["rec-critical-proof"],
    });
    assert.equal(approved.status, "approved");
    assert.equal(approved.approved_by, approverId);
    assert.deepEqual(approved.acknowledged_recommendations, ["rec-critical-proof"]);
    const { rows: [storedAck] } = await client.query(
      `SELECT acknowledged_recommendations, reviewed_evidence
         FROM policy_rollout_plans
        WHERE id = $1`,
      [plan.id],
    );
    assert.deepEqual(storedAck.acknowledged_recommendations, ["rec-critical-proof"]);
    assert.equal(storedAck.reviewed_evidence.immutable_approval_record_id !== undefined, true);

    const { rows: [authority] } = await client.query(
      `SELECT cr.id AS change_request_id,
              cr.policy_version_id,
              cr.author_principal_id,
              pv.base_policy_version_id,
              (SELECT count(*)::int
                 FROM policy_evidence_records er
                WHERE er.change_request_id = cr.id) AS evidence_count,
              (SELECT count(*)::int
                 FROM policy_approval_records ar
                WHERE ar.change_request_id = cr.id
                  AND ar.decision = 'approved') AS approval_count
         FROM policy_change_requests cr
         JOIN policy_versions pv ON pv.id = cr.policy_version_id
        WHERE cr.rollout_plan_id = $1`,
      [plan.id],
    );
    assert.ok(authority, "governed rollout must have immutable authority");
    assert.equal(authority.author_principal_id, authorId);
    assert.equal(authority.evidence_count, 4);
    assert.equal(authority.approval_count, 1);
    return { plan: approved, authority };
  }

  const first = await createApproved(policy1, "first");
  assert.equal(first.authority.base_policy_version_id, null);

  const firstPromotion = await promotePolicyRollout({
    rolloutPlanId: Number(first.plan.id),
    principal: principal(promoterId),
    reason: "w2-03-first-promotion",
  });
  assert.equal(firstPromotion.rollout.status, "promoted");
  assert.equal(firstPromotion.promotion.policy_version_id, first.authority.policy_version_id);

  const second = await createApproved(policy2, "second");
  assert.equal(
    second.authority.base_policy_version_id,
    first.authority.policy_version_id,
    "new rollout must derive its immutable base from current active authority",
  );

  const secondPromotion = await promotePolicyRollout({
    rolloutPlanId: Number(second.plan.id),
    principal: principal(promoterId),
    reason: "w2-03-second-promotion",
  });
  assert.equal(secondPromotion.rollout.status, "promoted");
  assert.equal(secondPromotion.promotion.policy_version_id, second.authority.policy_version_id);

  const { rows: [historyEntry] } = await client.query(
    `SELECT id
       FROM config_history
      WHERE repo_id = $1
        AND changed_by = $2
      ORDER BY id DESC
      LIMIT 1`,
    [repositoryId, `policy-promotion:${promoterId}:${second.plan.id}`],
  );
  assert.ok(historyEntry, "canonical promotion history must exist");

  const baseline = await client.query(
    `SELECT
       (SELECT config FROM repo_config WHERE repo_id = $1) AS config,
       (SELECT count(*)::int FROM config_history WHERE repo_id = $1) AS history_count,
       (SELECT count(*)::int FROM policy_promotion_records WHERE repo_id = $1) AS promotion_count,
       (SELECT policy_version_id FROM active_policy_bindings WHERE repo_id = $1) AS active_version`,
    [repositoryId],
  );
  assert.deepEqual(baseline.rows[0].config, policy2);
  assert.equal(baseline.rows[0].history_count, 2);
  assert.equal(baseline.rows[0].promotion_count, 2);
  assert.equal(baseline.rows[0].active_version, second.authority.policy_version_id);

  // A brand-new repository cannot acquire a DB materialization without a full
  // immutable promotion + binding + rollout/history bundle.
  await assert.rejects(
    client.query(
      `INSERT INTO repo_config (repo_id, config, updated_by)
       VALUES ($1, $2::jsonb, 'dashboard')`,
      [bypassRepositoryId, JSON.stringify(policy3)],
    ),
    /lacks governed active-policy authority/,
  );

  // Existing internal compatibility writer is storage-disabled as well as
  // retired at the HTTP surface.
  await assert.rejects(
    setConfigOverrides(repoFullName, policy3, "dashboard", "set"),
    /does not match governed policy version|attribution does not match governed promotion/,
  );
  await assert.rejects(
    deleteConfigOverrides(repoFullName, "dashboard"),
    /direct live-policy deletion is disabled/,
  );
  await assert.rejects(
    restoreConfigVersion(repoFullName, Number(historyEntry.id), "dashboard"),
    /does not match governed policy version|attribution does not match governed promotion/,
  );

  // Build a third, valid immutable authority envelope but invoke the retired
  // legacy promotion implementation. Even valid approval cannot bypass W2-02:
  // it has no immutable promotion/binding transaction and the DB rejects its
  // direct repo_config write.
  const third = await createApproved(policy3, "third");
  await redis.set(`gitwire:config:${repoFullName}`, JSON.stringify(policy2), "EX", 300);
  await assert.rejects(
    promoteRolloutPlan(Number(third.plan.id), {
      actor: "legacy-promoter",
      reason: "must-not-bypass-w2-02",
    }),
    /Promotion failed: could not write policy/,
  );

  // The legacy previous_config restore path is also fail-closed. Cache the
  // current effective policy so this proof never needs an external GitHub read.
  await redis.set(`gitwire:config:${repoFullName}`, JSON.stringify(policy2), "EX", 300);
  await assert.rejects(
    rollbackRolloutPlan(Number(second.plan.id), {
      actor: "legacy-rollback",
      reason: "must-not-restore-directly",
    }),
    /Rollback failed: could not restore previous policy/,
  );

  const { rows: [after] } = await client.query(
    `SELECT
       (SELECT config FROM repo_config WHERE repo_id = $1) AS config,
       (SELECT count(*)::int FROM config_history WHERE repo_id = $1) AS history_count,
       (SELECT count(*)::int FROM policy_promotion_records WHERE repo_id = $1) AS promotion_count,
       (SELECT policy_version_id FROM active_policy_bindings WHERE repo_id = $1) AS active_version,
       (SELECT status FROM policy_rollout_plans WHERE id = $2) AS second_status,
       (SELECT status FROM policy_rollout_plans WHERE id = $3) AS third_status`,
    [repositoryId, second.plan.id, third.plan.id],
  );
  assert.deepEqual(after.config, policy2);
  assert.equal(after.history_count, 2, "retired writers must not append compatibility history");
  assert.equal(after.promotion_count, 2, "retired writers must not create immutable promotions");
  assert.equal(after.active_version, second.authority.policy_version_id);
  assert.equal(after.second_status, "promoted");
  assert.equal(after.third_status, "approved");

  console.log("W2-03 governed policy writers: PASS");
} finally {
  await client.end();
}

process.exit(0);
