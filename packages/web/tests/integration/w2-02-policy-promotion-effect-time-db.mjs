// W2-02 effect-time authority and audit-clock proof against real PostgreSQL.
//
// Proves that an approver grant cannot authorize a promotion after its matched
// assignment expires, and that an immutable promotion delayed on repository
// serialization is timestamped at wall-clock effect time rather than at the
// transaction-start timestamp.

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";

const { Client } = pg;
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");

const installationId = 986200001;
const repositoryId = 986200002;
const authorId = randomUUID();
const approverId = randomUUID();
const promoterId = randomUUID();
const grantorId = randomUUID();
const roleId = randomUUID();
const roleName = `w2-promotion-effect-time-${randomUUID()}`;

const oldPolicy = {
  dry_run: true,
  review: { enabled: true, generation: 0 },
};

const client = new Client({ connectionString: databaseUrl });
const blocker = new Client({ connectionString: databaseUrl });
await client.connect();
await blocker.connect();

async function createAuthorityEnvelope(suffix) {
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
       decision, reason, evidence_manifest
     ) VALUES ($1, $2, $3, 'approved', $4, $5::jsonb)
     RETURNING id, evidence_set_hash`,
    [
      changeRequest.id,
      version.id,
      approverId,
      `effect-time-approval-${suffix}`,
      JSON.stringify(manifest),
    ],
  );

  return { rollout, version, changeRequest, approval, policy };
}

try {
  await client.query(
    `INSERT INTO installations (github_id, account_login, account_type)
     VALUES ($1, 'w2-promotion-effect-time', 'Organization')`,
    [installationId],
  );
  await client.query(
    `INSERT INTO repositories (github_id, installation_id, full_name, owner, name)
     VALUES ($1, $2, 'w2-promotion-effect-time/repo', 'w2-promotion-effect-time', 'repo')`,
    [repositoryId, installationId],
  );
  await client.query(
    `INSERT INTO gitwire_auth.auth_principals (id, principal_type, display_name)
     VALUES
       ($1, 'user', 'w2-effect-time-author'),
       ($2, 'user', 'w2-effect-time-approver'),
       ($3, 'user', 'w2-effect-time-promoter'),
       ($4, 'user', 'w2-effect-time-grantor')`,
    [authorId, approverId, promoterId, grantorId],
  );
  await client.query(
    `INSERT INTO gitwire_auth.auth_roles (id, name, description)
     VALUES ($1, $2, 'Disposable W2-02 effect-time proof role')`,
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
     VALUES ($1, $2::jsonb, 'effect-time-seed')`,
    [repositoryId, JSON.stringify(oldPolicy)],
  );

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
  const runtime = getRuntime();

  // The approver's matched assignment is valid when authorization reads it,
  // then wall-clock time advances beyond expires_at before that positive result
  // is returned to the promotion service. The protected promotion write must
  // reject that stale authorization and reauthorize against current authority.
  const approverExpiryEnvelope = await createAuthorityEnvelope("approver-expiry");
  const { rows: [approverAssignment] } = await client.query(
    `UPDATE gitwire_auth.auth_principal_roles
        SET expires_at = clock_timestamp() + interval '2500 milliseconds'
      WHERE principal_id = $1
        AND role_id = $2
        AND scope_type = 'repository'
        AND scope_id = $3
      RETURNING id, expires_at`,
    [approverId, roleId, repositoryId],
  );
  assert.ok(approverAssignment, "approver assignment must exist for expiry proof");

  const originalTransaction = runtime.db.transaction;
  let delayedApproverAuthorization = false;
  let observedApproverAssignmentId = null;

  runtime.db.transaction = async (fn) => originalTransaction.call(runtime.db, async (tx) => {
    const observedTx = {
      query: async (...args) => {
        const result = await tx.query(...args);
        const [sql, params = []] = args;
        const q = typeof sql === "string" ? sql.replace(/\s+/g, " ").trim() : "";
        if (
          !delayedApproverAuthorization
          && q.includes("FROM gitwire_auth.auth_principal_roles apr")
          && q.includes("FOR SHARE OF apr, ar, arp")
          && String(params[0]) === String(approverId)
          && result.rows.length > 0
        ) {
          delayedApproverAuthorization = true;
          observedApproverAssignmentId = result.rows[0].assignment_id;
          const waitMs = Math.max(
            0,
            new Date(approverAssignment.expires_at).getTime() - Date.now() + 250,
          );
          await new Promise((resolve) => setTimeout(resolve, waitMs));
        }
        return result;
      },
    };
    return fn(observedTx);
  });

  try {
    await assert.rejects(
      promotePolicyRollout({
        rolloutPlanId: Number(approverExpiryEnvelope.rollout.id),
        principal: {
          principalId: promoterId,
          authenticationMethod: "api_key",
        },
        reason: "approver-expiry-effect-proof",
      }),
      (err) => err instanceof PolicyPromotionError
        && err.reason === "no_currently_authorized_separated_approval",
      "service must reject an approver grant that expires before promotion effect",
    );
  } finally {
    runtime.db.transaction = originalTransaction;
  }

  assert.equal(delayedApproverAuthorization, true);
  assert.equal(
    String(observedApproverAssignmentId),
    String(approverAssignment.id),
    "initial approver authorization must use the expiring assignment",
  );

  const { rows: [approverExpiryState] } = await client.query(
    `SELECT p.status,
            (SELECT count(*)::int FROM policy_promotion_records pr
              WHERE pr.rollout_plan_id = p.id) AS promotion_count,
            (SELECT count(*)::int FROM active_policy_bindings apb
              WHERE apb.repo_id = p.repo_id) AS active_binding_count,
            (SELECT config FROM repo_config rc WHERE rc.repo_id = p.repo_id) AS materialized_config
       FROM policy_rollout_plans p
      WHERE p.id = $1`,
    [approverExpiryEnvelope.rollout.id],
  );
  assert.equal(approverExpiryState.status, "approved");
  assert.equal(approverExpiryState.promotion_count, 0);
  assert.equal(approverExpiryState.active_binding_count, 0);
  assert.deepEqual(approverExpiryState.materialized_config, oldPolicy);

  await client.query(
    `UPDATE gitwire_auth.auth_principal_roles
        SET expires_at = NULL
      WHERE id = $1`,
    [approverAssignment.id],
  );

  // Hold the repository mutex after starting a promotion transaction. The
  // promotion succeeds only after release; promoted_at must therefore be at or
  // after the release wall clock, not PostgreSQL's earlier transaction time.
  const timestampEnvelope = await createAuthorityEnvelope("wall-clock-timestamp");

  await blocker.query("BEGIN");
  let timestampBlockerOpen = true;
  await blocker.query(
    `SELECT github_id
       FROM repositories
      WHERE github_id = $1
      FOR UPDATE`,
    [repositoryId],
  );

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

  let promotionResult;
  let releaseWallTime;
  try {
    const promotionPromise = promotePolicyRollout({
      rolloutPlanId: Number(timestampEnvelope.rollout.id),
      principal: {
        principalId: promoterId,
        authenticationMethod: "api_key",
      },
      reason: "wall-clock-timestamp-proof",
    });

    const started = await Promise.race([
      transactionStarted,
      new Promise((_, reject) => setTimeout(
        () => reject(new Error("timestamp promotion transaction did not start before timeout")),
        1500,
      )),
    ]);

    await new Promise((resolve) => setTimeout(resolve, 600));
    const { rows: [releaseClock] } = await blocker.query(
      `SELECT clock_timestamp() AS wall_time`,
    );
    releaseWallTime = releaseClock.wall_time;
    assert.ok(
      new Date(releaseWallTime).getTime() > new Date(started.transaction_time).getTime(),
      "repository wait must advance wall clock beyond transaction time",
    );

    await blocker.query("COMMIT");
    timestampBlockerOpen = false;
    promotionResult = await promotionPromise;
  } finally {
    runtime.db.transaction = originalTransaction;
    if (timestampBlockerOpen) {
      await blocker.query("ROLLBACK");
    }
  }

  assert.ok(
    new Date(promotionResult.promotion.promoted_at).getTime()
      >= new Date(releaseWallTime).getTime(),
    "immutable promotion timestamp must reflect wall-clock effect after mutex release",
  );
  assert.equal(
    new Date(promotionResult.activePolicy.activated_at).getTime(),
    new Date(promotionResult.promotion.promoted_at).getTime(),
    "active binding activation must inherit immutable promotion effect time",
  );
  assert.equal(
    new Date(promotionResult.rollout.promoted_at).getTime(),
    new Date(promotionResult.promotion.promoted_at).getTime(),
    "rollout audit time must inherit immutable promotion effect time",
  );

  const { rows: [auditTimes] } = await client.query(
    `SELECT pr.promoted_at,
            apb.activated_at,
            p.promoted_at AS rollout_promoted_at
       FROM policy_promotion_records pr
       JOIN active_policy_bindings apb ON apb.promotion_record_id = pr.id
       JOIN policy_rollout_plans p ON p.id = pr.rollout_plan_id
      WHERE pr.rollout_plan_id = $1`,
    [timestampEnvelope.rollout.id],
  );
  assert.ok(auditTimes);
  assert.equal(
    new Date(auditTimes.activated_at).getTime(),
    new Date(auditTimes.promoted_at).getTime(),
  );
  assert.equal(
    new Date(auditTimes.rollout_promoted_at).getTime(),
    new Date(auditTimes.promoted_at).getTime(),
  );

  console.log("W2-02 approver effect-time authority + promotion wall-clock audit time: PASS");
} finally {
  await blocker.end();
  await client.end();
}

// The production service imports shared DB/Redis singletons. Explicit process
// termination keeps this standalone CI proof from waiting on those open handles.
process.exit(0);
