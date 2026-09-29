// W2-02 real-Postgres denial-evidence durability proof.
// Exercises the production promotion service and proves expected enforced
// authorization denials commit their decision evidence while every promotion
// effect remains absent.

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";

const { Client } = pg;
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");

const installationId = 985000001;
const promoterDeniedRepoId = 985000002;
const approverDeniedRepoId = 985000003;
const authorId = randomUUID();
const approverId = randomUUID();
const authorizedPromoterId = randomUUID();
const deniedPromoterId = randomUUID();
const grantorId = randomUUID();
const roleId = randomUUID();
const roleName = `w2-denial-evidence-${randomUUID()}`;

const policy = {
  dry_run: true,
  review: { enabled: true, denial_evidence: true },
};

const client = new Client({ connectionString: databaseUrl });
await client.connect();

async function seedAuthorityEnvelope(repoId, approvalPrincipalId) {
  const { rows: [rollout] } = await client.query(
    `INSERT INTO policy_rollout_plans (
       repo_id, proposed_config, normalized_config, status,
       created_by, approved_by, approved_at
     ) VALUES ($1, $2, $2, 'approved', 'legacy-author', 'legacy-approver', NOW())
     RETURNING id`,
    [repoId, policy],
  );

  const { rows: [version] } = await client.query(
    `INSERT INTO policy_versions (
       repo_id, base_policy_version_id, policy_document,
       normalized_document, author_principal_id
     ) VALUES ($1, NULL, $2, $2, $3)
     RETURNING id`,
    [repoId, policy, authorId],
  );

  const { rows: [changeRequest] } = await client.query(
    `INSERT INTO policy_change_requests (
       rollout_plan_id, repo_id, policy_version_id, author_principal_id
     ) VALUES ($1, $2, $3, $4)
     RETURNING id`,
    [rollout.id, repoId, version.id, authorId],
  );

  const payloads = [
    ["validation_result", { valid: true, errors: [] }],
    ["simulation_summary", { events_considered: 2, would_act: 1 }],
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
     ) VALUES ($1, $2, $3, 'approved', 'denial-evidence proof approval', $4::jsonb)
     RETURNING id`,
    [changeRequest.id, version.id, approvalPrincipalId, JSON.stringify(manifest)],
  );

  return { rollout, version, changeRequest, approval };
}

async function assertNoPromotionEffects(repoId, rolloutId) {
  const { rows: [counts] } = await client.query(
    `SELECT
       (SELECT count(*)::int FROM policy_promotion_records WHERE repo_id = $1) AS promotions,
       (SELECT count(*)::int FROM active_policy_bindings WHERE repo_id = $1) AS bindings,
       (SELECT count(*)::int FROM repo_config WHERE repo_id = $1) AS configs,
       (SELECT count(*)::int FROM config_history WHERE repo_id = $1) AS history`,
    [repoId],
  );
  assert.deepEqual(counts, {
    promotions: 0,
    bindings: 0,
    configs: 0,
    history: 0,
  });

  const { rows: [rollout] } = await client.query(
    `SELECT status, promoted_by, promoted_at, promotion_reason
       FROM policy_rollout_plans
      WHERE id = $1`,
    [rolloutId],
  );
  assert.equal(rollout.status, "approved");
  assert.equal(rollout.promoted_by, null);
  assert.equal(rollout.promoted_at, null);
  assert.equal(rollout.promotion_reason, null);
}

try {
  await client.query(
    `INSERT INTO installations (github_id, account_login, account_type)
     VALUES ($1, 'w2-denial-evidence', 'Organization')`,
    [installationId],
  );
  await client.query(
    `INSERT INTO repositories (github_id, installation_id, full_name, owner, name)
     VALUES
       ($1, $3, 'w2-denial-evidence/promoter-denied', 'w2-denial-evidence', 'promoter-denied'),
       ($2, $3, 'w2-denial-evidence/approver-denied', 'w2-denial-evidence', 'approver-denied')`,
    [promoterDeniedRepoId, approverDeniedRepoId, installationId],
  );

  await client.query(
    `INSERT INTO gitwire_auth.auth_principals (id, principal_type, display_name)
     VALUES
       ($1, 'user', 'w2-denial-author'),
       ($2, 'user', 'w2-denial-approver'),
       ($3, 'user', 'w2-denial-authorized-promoter'),
       ($4, 'user', 'w2-denial-promoter'),
       ($5, 'user', 'w2-denial-grantor')`,
    [authorId, approverId, authorizedPromoterId, deniedPromoterId, grantorId],
  );
  await client.query(
    `INSERT INTO gitwire_auth.auth_roles (id, name, description)
     VALUES ($1, $2, 'Disposable W2-02 denial-evidence proof role')`,
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
     ) VALUES ($1, $2, 'repository', $3, $4)`,
    [authorizedPromoterId, roleId, approverDeniedRepoId, grantorId],
  );

  const promoterDeniedAuthority =
    await seedAuthorityEnvelope(promoterDeniedRepoId, approverId);
  const approverDeniedAuthority =
    await seedAuthorityEnvelope(approverDeniedRepoId, approverId);

  const { initRuntime } = await import("@gitwire/runtime");
  initRuntime({
    server: { env: "test", logLevel: "silent" },
    db: { url: databaseUrl },
    redis: { url: process.env.REDIS_URL || "redis://127.0.0.1:6379" },
    github: {},
  });

  const { promotePolicyRollout } = await import("../../src/services/policyPromotionService.js");

  await assert.rejects(
    promotePolicyRollout({
      rolloutPlanId: Number(promoterDeniedAuthority.rollout.id),
      principal: {
        principalId: deniedPromoterId,
        authenticationMethod: "api_key",
      },
      reason: "must-not-promote",
    }),
    (err) => err?.reason === "promoter_authorization_denied"
      && err?.detail?.code === "permission_missing",
    "denied promoter must fail after committing enforced denial evidence",
  );

  const { rows: promoterDenials } = await client.query(
    `SELECT allowed, code, observe_mode
       FROM gitwire_auth.auth_decision_log
      WHERE principal_id = $1
        AND permission = 'policy_rollout_plan:approve'
        AND resource_repository_id = $2
      ORDER BY decided_at ASC`,
    [deniedPromoterId, promoterDeniedRepoId],
  );
  assert.equal(promoterDenials.length, 1);
  assert.equal(promoterDenials[0].allowed, false);
  assert.equal(promoterDenials[0].code, "permission_missing");
  assert.equal(promoterDenials[0].observe_mode, false);
  await assertNoPromotionEffects(
    promoterDeniedRepoId,
    promoterDeniedAuthority.rollout.id,
  );

  await assert.rejects(
    promotePolicyRollout({
      rolloutPlanId: Number(approverDeniedAuthority.rollout.id),
      principal: {
        principalId: authorizedPromoterId,
        authenticationMethod: "api_key",
      },
      reason: "must-not-promote",
    }),
    (err) => err?.reason === "no_currently_authorized_separated_approval"
      && err?.detail?.code === "permission_missing",
    "denied approver must fail after committing enforced denial evidence",
  );

  const { rows: approverDecisions } = await client.query(
    `SELECT principal_id, allowed, code, observe_mode
       FROM gitwire_auth.auth_decision_log
      WHERE permission = 'policy_rollout_plan:approve'
        AND resource_repository_id = $1
        AND principal_id = ANY($2::uuid[])
      ORDER BY decided_at ASC`,
    [approverDeniedRepoId, [authorizedPromoterId, approverId]],
  );
  assert.equal(approverDecisions.length, 2);
  const promoterDecision = approverDecisions.find(
    (row) => row.principal_id === authorizedPromoterId,
  );
  const approverDecision = approverDecisions.find(
    (row) => row.principal_id === approverId,
  );
  assert.ok(promoterDecision);
  assert.equal(promoterDecision.allowed, true);
  assert.equal(promoterDecision.code, "allowed");
  assert.equal(promoterDecision.observe_mode, false);
  assert.ok(approverDecision);
  assert.equal(approverDecision.allowed, false);
  assert.equal(approverDecision.code, "permission_missing");
  assert.equal(approverDecision.observe_mode, false);
  await assertNoPromotionEffects(
    approverDeniedRepoId,
    approverDeniedAuthority.rollout.id,
  );

  console.log("W2-02 denial evidence durability: PASS");
} finally {
  await client.end();
}

process.exit(0);
