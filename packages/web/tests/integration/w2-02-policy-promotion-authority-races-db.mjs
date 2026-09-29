// W2-02 promotion authority-race proof against real PostgreSQL.
//
// Proves three exact-head review invariants through the production promotion
// service: retired roles cannot authorize promotion, approval expiry is
// evaluated against wall-clock time after repository serialization rather than
// PostgreSQL's transaction-start timestamp, and an expiring promoter grant is
// revalidated at the protected promotion write after intervening authority work.

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";

const { Client } = pg;
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");

const installationId = 986100001;
const repositoryId = 986100002;
const authorId = randomUUID();
const approverId = randomUUID();
const promoterId = randomUUID();
const grantorId = randomUUID();
const roleId = randomUUID();
const roleName = `w2-promotion-authority-races-${randomUUID()}`;

const client = new Client({ connectionString: databaseUrl });
const blocker = new Client({ connectionString: databaseUrl });
await client.connect();
await blocker.connect();

async function createAuthorityEnvelope({ suffix, expiresInMs = null }) {
  const policy = {
    dry_run: true,
    review: { enabled: true, suffix },
  };

  const { rows: [rollout] } = await client.query(
    `INSERT INTO policy_rollout_plans (
       repo_id, proposed_config, normalized_config, status,
       created_by, approved_by, approved_at
     ) VALUES ($1, $2, $2, 'approved', $3, $4, NOW())
     RETURNING id`,
    [repositoryId, policy, `legacy-author-${suffix}`, `legacy-approver-${suffix}`],
  );

  const { rows: [version] } = await client.query(
    `INSERT INTO policy_versions (
       repo_id, base_policy_version_id, policy_document,
       normalized_document, author_principal_id
     ) VALUES ($1, NULL, $2, $2, $3)
     RETURNING id`,
    [repositoryId, policy, authorId],
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
       decision, reason, evidence_manifest, expires_at
     ) VALUES (
       $1, $2, $3, 'approved', $4, $5::jsonb,
       CASE WHEN $6::int IS NULL
            THEN NULL
            ELSE clock_timestamp() + ($6::int * interval '1 millisecond')
       END
     )
     RETURNING id, evidence_set_hash, expires_at`,
    [
      changeRequest.id,
      version.id,
      approverId,
      `authority-race-approval-${suffix}`,
      JSON.stringify(manifest),
      expiresInMs,
    ],
  );

  return { rollout, version, changeRequest, approval, policy };
}

try {
  await client.query(
    `INSERT INTO installations (github_id, account_login, account_type)
     VALUES ($1, 'w2-promotion-authority-races', 'Organization')`,
    [installationId],
  );
  await client.query(
    `INSERT INTO repositories (github_id, installation_id, full_name, owner, name)
     VALUES ($1, $2, 'w2-promotion-authority-races/repo', 'w2-promotion-authority-races', 'repo')`,
    [repositoryId, installationId],
  );
  await client.query(
    `INSERT INTO gitwire_auth.auth_principals (id, principal_type, display_name)
     VALUES
       ($1, 'user', 'w2-authority-race-author'),
       ($2, 'user', 'w2-authority-race-approver'),
       ($3, 'user', 'w2-authority-race-promoter'),
       ($4, 'user', 'w2-authority-race-grantor')`,
    [authorId, approverId, promoterId, grantorId],
  );
  await client.query(
    `INSERT INTO gitwire_auth.auth_roles (id, name, description)
     VALUES ($1, $2, 'Disposable W2-02 authority-race proof role')`,
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

  // W2-03 forbids post-migration raw repo_config seeding. Every failure below
  // therefore proves that authority races leave the repository with no live
  // DB materialization or active binding.
  const { initRuntime, getRuntime } = await import("@gitwire/runtime");
  initRuntime({
    server: { env: "test", logLevel: "silent" },
    db: { url: databaseUrl },
    redis: { url: process.env.REDIS_URL || "redis://127.0.0.1:6379" },
    github: {},
  });

  const {
    promotePolicyRollout,
    PolicyPromotionError,
  } = await import("../../src/services/policyPromotionService.js");

  const retiredRoleEnvelope = await createAuthorityEnvelope({ suffix: "retired-role" });
  await client.query(
    `UPDATE gitwire_auth.auth_roles
        SET status = 'retired', retired_at = clock_timestamp()
      WHERE id = $1`,
    [roleId],
  );

  await assert.rejects(
    promotePolicyRollout({
      rolloutPlanId: Number(retiredRoleEnvelope.rollout.id),
      principal: {
        principalId: promoterId,
        authenticationMethod: "api_key",
      },
      reason: "retired-role-proof",
    }),
    (err) => err instanceof PolicyPromotionError
      && err.reason === "promoter_authorization_denied"
      && err.detail?.code === "permission_missing",
    "retired role must fail closed before live-policy promotion",
  );

  const { rows: [retiredRoleState] } = await client.query(
    `SELECT p.status,
            (SELECT count(*)::int FROM policy_promotion_records pr
              WHERE pr.rollout_plan_id = p.id) AS promotion_count,
            (SELECT count(*)::int FROM active_policy_bindings apb
              WHERE apb.repo_id = p.repo_id) AS active_binding_count
       FROM policy_rollout_plans p
      WHERE p.id = $1`,
    [retiredRoleEnvelope.rollout.id],
  );
  assert.equal(retiredRoleState.status, "approved");
  assert.equal(retiredRoleState.promotion_count, 0);
  assert.equal(retiredRoleState.active_binding_count, 0);

  await client.query(
    `UPDATE gitwire_auth.auth_roles
        SET status = 'active', retired_at = NULL
      WHERE id = $1`,
    [roleId],
  );

  const expiringEnvelope = await createAuthorityEnvelope({
    suffix: "approval-expiry",
    expiresInMs: 3000,
  });

  await blocker.query("BEGIN");
  let blockerOpen = true;
  await blocker.query(
    `SELECT github_id
       FROM repositories
      WHERE github_id = $1
      FOR UPDATE`,
    [repositoryId],
  );

  const runtime = getRuntime();
  const originalTransaction = runtime.db.transaction;
  let resolveTransactionStarted;
  const transactionStarted = new Promise((resolve) => {
    resolveTransactionStarted = resolve;
  });

  runtime.db.transaction = async (fn) => originalTransaction.call(runtime.db, async (tx) => {
    const { rows: [started] } = await tx.query(
      `SELECT now() AS transaction_time, clock_timestamp() AS wall_time`,
    );
    resolveTransactionStarted(started);
    return fn(tx);
  });

  try {
    const rejection = assert.rejects(
      promotePolicyRollout({
        rolloutPlanId: Number(expiringEnvelope.rollout.id),
        principal: {
          principalId: promoterId,
          authenticationMethod: "api_key",
        },
        reason: "approval-expiry-proof",
      }),
      (err) => err instanceof PolicyPromotionError
        && err.reason === "approved_authority_record_missing_or_expired",
      "service must reject approval authority that expires while waiting on repository serialization",
    );

    const started = await Promise.race([
      transactionStarted,
      new Promise((_, reject) => setTimeout(
        () => reject(new Error("promotion transaction did not start before timeout")),
        1500,
      )),
    ]);
    assert.ok(
      new Date(started.transaction_time).getTime()
        < new Date(expiringEnvelope.approval.expires_at).getTime(),
      "promotion transaction must start before approval expiry",
    );

    const waitMs = Math.max(
      0,
      new Date(expiringEnvelope.approval.expires_at).getTime() - Date.now() + 300,
    );
    await new Promise((resolve) => setTimeout(resolve, waitMs));

    const { rows: [afterWait] } = await blocker.query(
      `SELECT clock_timestamp() AS wall_time`,
    );
    assert.ok(
      new Date(afterWait.wall_time).getTime()
        > new Date(expiringEnvelope.approval.expires_at).getTime(),
      "wall clock must be past approval expiry before releasing repository serialization",
    );

    await blocker.query("COMMIT");
    blockerOpen = false;
    await rejection;
  } finally {
    runtime.db.transaction = originalTransaction;
    if (blockerOpen) {
      await blocker.query("ROLLBACK");
    }
  }

  const { rows: [expiryState] } = await client.query(
    `SELECT p.status,
            (SELECT count(*)::int FROM policy_promotion_records pr
              WHERE pr.rollout_plan_id = p.id) AS promotion_count,
            (SELECT count(*)::int FROM active_policy_bindings apb
              WHERE apb.repo_id = p.repo_id) AS active_binding_count,
            (SELECT config FROM repo_config rc WHERE rc.repo_id = p.repo_id) AS materialized_config
       FROM policy_rollout_plans p
      WHERE p.id = $1`,
    [expiringEnvelope.rollout.id],
  );
  assert.equal(expiryState.status, "approved");
  assert.equal(expiryState.promotion_count, 0);
  assert.equal(expiryState.active_binding_count, 0);
  assert.equal(expiryState.materialized_config, null);

  const promoterExpiryEnvelope = await createAuthorityEnvelope({
    suffix: "promoter-expiry",
  });
  const { rows: [promoterAssignment] } = await client.query(
    `UPDATE gitwire_auth.auth_principal_roles
        SET expires_at = clock_timestamp() + interval '3 seconds'
      WHERE principal_id = $1
        AND role_id = $2
        AND scope_type = 'repository'
        AND scope_id = $3
      RETURNING id, expires_at`,
    [promoterId, roleId, repositoryId],
  );
  assert.ok(promoterAssignment, "promoter assignment must exist for expiry proof");

  await blocker.query("BEGIN");
  let promoterBlockerOpen = true;
  await blocker.query(
    `SELECT id
       FROM gitwire_auth.auth_principals
      WHERE id = $1
      FOR UPDATE`,
    [approverId],
  );

  const promoterExpiryOriginalTransaction = runtime.db.transaction;
  let resolvePromoterAuthorized;
  const promoterAuthorized = new Promise((resolve) => {
    resolvePromoterAuthorized = resolve;
  });

  runtime.db.transaction = async (fn) => promoterExpiryOriginalTransaction.call(
    runtime.db,
    async (tx) => {
      const observedTx = {
        query: async (...args) => {
          const result = await tx.query(...args);
          const [sql, params = []] = args;
          const q = typeof sql === "string" ? sql.replace(/\s+/g, " ").trim() : "";
          if (
            q.includes("FROM gitwire_auth.auth_principal_roles apr")
            && q.includes("FOR SHARE OF apr, ar, arp")
            && String(params[0]) === String(promoterId)
            && result.rows.length > 0
          ) {
            resolvePromoterAuthorized({
              assignmentId: result.rows[0].assignment_id,
              observedAt: Date.now(),
            });
          }
          return result;
        },
      };
      return fn(observedTx);
    },
  );

  try {
    const rejection = assert.rejects(
      promotePolicyRollout({
        rolloutPlanId: Number(promoterExpiryEnvelope.rollout.id),
        principal: {
          principalId: promoterId,
          authenticationMethod: "api_key",
        },
        reason: "promoter-expiry-proof",
      }),
      (err) => err instanceof PolicyPromotionError
        && err.reason === "promoter_authorization_denied"
        && err.detail?.code === "permission_missing",
      "service must reject a promoter grant that expires before the protected write",
    );

    const observedAuthorization = await Promise.race([
      promoterAuthorized,
      new Promise((_, reject) => setTimeout(
        () => reject(new Error("promoter authorization was not observed before timeout")),
        1500,
      )),
    ]);
    assert.equal(
      String(observedAuthorization.assignmentId),
      String(promoterAssignment.id),
      "initial promotion authorization must use the expiring promoter assignment",
    );
    assert.ok(
      observedAuthorization.observedAt
        < new Date(promoterAssignment.expires_at).getTime(),
      "initial promoter authorization must complete before assignment expiry",
    );

    const waitMs = Math.max(
      0,
      new Date(promoterAssignment.expires_at).getTime() - Date.now() + 300,
    );
    await new Promise((resolve) => setTimeout(resolve, waitMs));

    const { rows: [afterPromoterWait] } = await blocker.query(
      `SELECT clock_timestamp() AS wall_time`,
    );
    assert.ok(
      new Date(afterPromoterWait.wall_time).getTime()
        > new Date(promoterAssignment.expires_at).getTime(),
      "wall clock must be past promoter grant expiry before approver work resumes",
    );

    await blocker.query("COMMIT");
    promoterBlockerOpen = false;
    await rejection;
  } finally {
    runtime.db.transaction = promoterExpiryOriginalTransaction;
    if (promoterBlockerOpen) {
      await blocker.query("ROLLBACK");
    }
  }

  const { rows: [promoterExpiryState] } = await client.query(
    `SELECT p.status,
            (SELECT count(*)::int FROM policy_promotion_records pr
              WHERE pr.rollout_plan_id = p.id) AS promotion_count,
            (SELECT count(*)::int FROM active_policy_bindings apb
              WHERE apb.repo_id = p.repo_id) AS active_binding_count,
            (SELECT config FROM repo_config rc WHERE rc.repo_id = p.repo_id) AS materialized_config
       FROM policy_rollout_plans p
      WHERE p.id = $1`,
    [promoterExpiryEnvelope.rollout.id],
  );
  assert.equal(promoterExpiryState.status, "approved");
  assert.equal(promoterExpiryState.promotion_count, 0);
  assert.equal(promoterExpiryState.active_binding_count, 0);
  assert.equal(promoterExpiryState.materialized_config, null);

  await client.query(
    `UPDATE gitwire_auth.auth_principal_roles
        SET expires_at = NULL
      WHERE id = $1`,
    [promoterAssignment.id],
  );

  console.log("W2-02 promotion retired-role + approval/promoter-expiry race safety: PASS");
} finally {
  await blocker.end();
  await client.end();
}

process.exit(0);
