// W2-02 real-Postgres proof for approval expiry at the immutable insert boundary.
// The service must preserve the storage trigger as the final wall-clock guard,
// roll back all effects, and translate the raw PostgreSQL trigger exception into
// the stable policy-promotion domain error consumed by the API route.

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";

const { Client } = pg;
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");

const installationId = 982100001;
const repositoryId = 982100002;
const authorId = randomUUID();
const approverId = randomUUID();
const promoterId = randomUUID();
const grantorId = randomUUID();
const roleId = randomUUID();
const roleName = `w2-expiry-translation-${randomUUID()}`;
const policy = { dry_run: true, review: { enabled: true, proof: "approval-expiry" } };

const client = new Client({ connectionString: databaseUrl });
const blocker = new Client({ connectionString: databaseUrl });
await client.connect();
await blocker.connect();

let blockerTransactionOpen = false;
let promotionPromise = null;

async function waitForPromotionInsertToBlock(timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { rows } = await client.query(
      `SELECT 1
         FROM pg_stat_activity
        WHERE datname = current_database()
          AND query ILIKE '%INSERT INTO policy_promotion_records%'
          AND wait_event_type = 'Lock'
        LIMIT 1`,
    );
    if (rows.length > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("promotion service did not reach the blocked immutable insert before timeout");
}

try {
  await client.query(
    `INSERT INTO installations (github_id, account_login, account_type)
     VALUES ($1, 'w2-expiry-translation', 'Organization')`,
    [installationId],
  );
  await client.query(
    `INSERT INTO repositories (github_id, installation_id, full_name, owner, name)
     VALUES ($1, $2, 'w2-expiry-translation/repo', 'w2-expiry-translation', 'repo')`,
    [repositoryId, installationId],
  );
  await client.query(
    `INSERT INTO gitwire_auth.auth_principals (id, principal_type, display_name)
     VALUES
       ($1, 'user', 'w2-expiry-author'),
       ($2, 'user', 'w2-expiry-approver'),
       ($3, 'user', 'w2-expiry-promoter'),
       ($4, 'user', 'w2-expiry-grantor')`,
    [authorId, approverId, promoterId, grantorId],
  );
  await client.query(
    `INSERT INTO gitwire_auth.auth_roles (id, name, description)
     VALUES ($1, $2, 'Disposable W2-02 approval-expiry translation role')`,
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

  const { rows: [rollout] } = await client.query(
    `INSERT INTO policy_rollout_plans (
       repo_id, proposed_config, normalized_config, status,
       created_by, approved_by, approved_at
     ) VALUES ($1, $2, $2, 'approved', 'legacy-author', 'legacy-approver', NOW())
     RETURNING id`,
    [repositoryId, policy],
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
    ["simulation_summary", { events_considered: 1 }],
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
       $1, $2, $3, 'approved', 'expiry-boundary proof', $4::jsonb,
       clock_timestamp() + interval '6 seconds'
     )
     RETURNING id, expires_at`,
    [changeRequest.id, version.id, approverId, JSON.stringify(manifest)],
  );

  const { initRuntime } = await import("@gitwire/runtime");
  initRuntime({
    server: { env: "test", logLevel: "silent" },
    db: { url: databaseUrl },
    redis: { url: process.env.REDIS_URL || "redis://127.0.0.1:6379" },
    github: {},
  });
  const { promotePolicyRollout, PolicyPromotionError } =
    await import("../../src/services/policyPromotionService.js");

  await blocker.query("BEGIN");
  blockerTransactionOpen = true;
  await blocker.query("LOCK TABLE policy_promotion_records IN ACCESS EXCLUSIVE MODE");

  promotionPromise = promotePolicyRollout({
    rolloutPlanId: Number(rollout.id),
    principal: {
      principalId: promoterId,
      authenticationMethod: "api_key",
    },
    reason: "expiry-boundary-proof",
  });

  await waitForPromotionInsertToBlock();
  const waitMs = Math.max(0, new Date(approval.expires_at).getTime() - Date.now() + 250);
  await new Promise((resolve) => setTimeout(resolve, waitMs));

  await blocker.query("COMMIT");
  blockerTransactionOpen = false;

  await assert.rejects(
    promotionPromise,
    (err) => err instanceof PolicyPromotionError
      && err.reason === "approved_authority_record_missing_or_expired",
    "effect-boundary approval expiry must expose the stable domain error",
  );
  promotionPromise = null;

  const { rows: [rolloutState] } = await client.query(
    `SELECT status, promoted_by, promoted_at
       FROM policy_rollout_plans
      WHERE id = $1`,
    [rollout.id],
  );
  assert.equal(rolloutState.status, "approved");
  assert.equal(rolloutState.promoted_by, null);
  assert.equal(rolloutState.promoted_at, null);

  const { rows: [counts] } = await client.query(
    `SELECT
       (SELECT count(*)::int FROM policy_promotion_records WHERE rollout_plan_id = $1) AS promotions,
       (SELECT count(*)::int FROM active_policy_bindings WHERE repo_id = $2) AS bindings,
       (SELECT count(*)::int FROM repo_config WHERE repo_id = $2) AS materializations,
       (SELECT count(*)::int FROM config_history WHERE repo_id = $2) AS history_rows`,
    [rollout.id, repositoryId],
  );
  assert.deepEqual(counts, {
    promotions: 0,
    bindings: 0,
    materializations: 0,
    history_rows: 0,
  });

  console.log("W2-02 Postgres approval-expiry translation: PASS");
} finally {
  if (blockerTransactionOpen) {
    await blocker.query("ROLLBACK").catch(() => {});
  }
  if (promotionPromise) {
    await promotionPromise.catch(() => {});
  }
  await blocker.end();
  await client.end();
}

// Production service imports shared DB/Redis singletons. Explicit termination
// keeps this standalone CI proof from waiting on those open handles.
process.exit(0);