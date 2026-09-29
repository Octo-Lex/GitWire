// W2-04 configuration layering proof against real PostgreSQL + Redis.
//
// Proves the canonical resolver wired through the production service:
//   * A9  — governed values identify the immutable active policy version /
//           promotion record that produced the live materialization;
//   * A10 — the governed layer wins over defaults for promoted keys;
//   * A14 — a repository with no org/repo/governed configuration resolves to
//           dry-run, non-mutating safe defaults;
//   * A19 — repeated resolution over identical sources is hash-stable while
//           resolved_at (observational) differs.
//
// The governed layer is established through the real W2-02 promotion service
// (the only repo_config writer since W2-03). Org/repo YAML layers are absent
// here: the repositories have no reachable GitHub installation, so those
// fetches degrade to absent layers exactly as the sparse contract requires.

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";

const { Client } = pg;
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");

const installationId = 986200101;
const governedRepoId = 986200102;
const bareRepoId = 986200103;
const authorId = randomUUID();
const approverId = randomUUID();
const promoterId = randomUUID();
const grantorId = randomUUID();
const roleId = randomUUID();

const governedPolicy = {
  settings: { dry_run: false },
  pillars: { trust: { enabled: true } },
};

const client = new Client({ connectionString: databaseUrl });
await client.connect();

try {
  await client.query(
    `INSERT INTO installations (github_id, account_login, account_type)
     VALUES ($1, 'w2-04-layering', 'Organization')`,
    [installationId],
  );
  for (const [repoId, name] of [
    [governedRepoId, "governed"],
    [bareRepoId, "bare"],
  ]) {
    await client.query(
      `INSERT INTO repositories (github_id, installation_id, full_name, owner, name)
       VALUES ($1, $2, $3, 'w2-04-layering', $4)`,
      [repoId, installationId, `w2-04-layering/${name}`, name],
    );
  }
  await client.query(
    `INSERT INTO gitwire_auth.auth_principals (id, principal_type, display_name)
     VALUES
       ($1, 'user', 'w2-04-author'),
       ($2, 'user', 'w2-04-approver'),
       ($3, 'user', 'w2-04-promoter'),
       ($4, 'user', 'w2-04-grantor')`,
    [authorId, approverId, promoterId, grantorId],
  );
  await client.query(
    `INSERT INTO gitwire_auth.auth_roles (id, name, description)
     VALUES ($1, $2, 'Disposable W2-04 layering proof role')`,
    [roleId, `w2-04-layering-${randomUUID()}`],
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
    [approverId, promoterId, roleId, governedRepoId, grantorId],
  );

  // ── Establish the governed layer through the real promotion service ──────
  const { initRuntime } = await import("@gitwire/runtime");
  initRuntime({
    server: { env: "test", logLevel: "silent" },
    db: { url: databaseUrl },
    redis: { url: process.env.REDIS_URL || "redis://127.0.0.1:6379" },
    github: {},
  });
  const { promotePolicyRollout } = await import("../../src/services/policyPromotionService.js");

  const { rows: [rollout] } = await client.query(
    `INSERT INTO policy_rollout_plans (
       repo_id, proposed_config, normalized_config, status,
       created_by, approved_by, approved_at
     ) VALUES ($1, $2, $2, 'approved', $3, $4, NOW())
     RETURNING id`,
    [governedRepoId, governedPolicy, "w2-04-author", "w2-04-approver"],
  );
  const { rows: [version] } = await client.query(
    `INSERT INTO policy_versions (
       repo_id, base_policy_version_id, policy_document,
       normalized_document, author_principal_id
     ) VALUES ($1, NULL, $2, $2, $3)
     RETURNING id`,
    [governedRepoId, governedPolicy, authorId],
  );
  const { rows: [changeRequest] } = await client.query(
    `INSERT INTO policy_change_requests (
       rollout_plan_id, repo_id, policy_version_id, author_principal_id
     ) VALUES ($1, $2, $3, $4)
     RETURNING id`,
    [rollout.id, governedRepoId, version.id, authorId],
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
     ) VALUES ($1, $2, $3, 'approved', $4, $5::jsonb)
     RETURNING id`,
    [changeRequest.id, version.id, approverId, "w2-04-layering-proof", JSON.stringify(manifest)],
  );

  const promoted = await promotePolicyRollout({
    rolloutPlanId: Number(rollout.id),
    principal: { principalId: promoterId, authenticationMethod: "api_key" },
    reason: "w2-04-layering-proof",
  });
  assert.ok(promoted.activePolicy, "governed promotion must produce an active binding");

  // ── Resolve through the production resolver ──────────────────────────────
  const { getConfigForRepo, invalidateConfigCache } = await import("../../src/services/configService.js");

  const resolved = await getConfigForRepo("w2-04-layering/governed");

  // A10: promoted values win over the (safe) defaults.
  assert.equal(resolved.pillars.trust.enabled, true);
  assert.equal(resolved.settings.dry_run, false);
  assert.equal(resolved._meta.provenance["/pillars/trust/enabled"], "governed");
  assert.equal(resolved._meta.provenance["/settings/dry_run"], "governed");

  // A9: the governed identity names the immutable policy version + promotion.
  assert.equal(
    resolved._meta.version_vector.governed,
    `policy_version:${version.id}:promotion:${promoted.promotion.id}`,
  );
  assert.equal(resolved._meta.layers.governed, true);

  // Unpromoted keys still resolve from safe defaults with default provenance.
  assert.equal(resolved.pillars.triage.enabled, false);
  assert.equal(resolved._meta.provenance["/pillars/triage/enabled"], "defaults");

  // A19: identical sources → identical identity; resolved_at differs.
  await invalidateConfigCache("w2-04-layering/governed");
  const again = await getConfigForRepo("w2-04-layering/governed");
  assert.equal(again._meta.effective_hash, resolved._meta.effective_hash);
  assert.equal(again._meta.version_vector.governed, resolved._meta.version_vector.governed);
  assert.notEqual(again._meta.resolved_at, resolved._meta.resolved_at);

  // The approval identity recorded by promotion is the governed approver.
  const { rows: [binding] } = await client.query(
    `SELECT policy_version_id, promotion_record_id
       FROM active_policy_bindings
      WHERE repo_id = $1`,
    [governedRepoId],
  );
  assert.equal(binding.policy_version_id, version.id);
  assert.equal(String(binding.promotion_record_id), String(promoted.promotion.id));
  void approval;

  // ── A14: a bare repository cannot mutate solely by being enrolled ───────
  const bare = await getConfigForRepo("w2-04-layering/bare");
  assert.equal(bare.settings.dry_run, true);
  for (const pillar of Object.keys(bare.pillars)) {
    assert.equal(bare.pillars[pillar].enabled, false, `${pillar} must default disabled`);
  }
  assert.deepEqual(bare._meta.layers, {
    defaults: true, org: false, repo: false, governed: false,
  });
  assert.equal(bare._meta.version_vector.governed, null);
  assert.equal(bare._meta.provenance["/settings/dry_run"], "defaults");
  assert.match(bare._meta.effective_hash, /^sha256:[0-9a-f]{64}$/);

  console.log("W2-04 configuration layering (governed identity, safe defaults, determinism): PASS");
} finally {
  await client.end();
}

// The production service imports shared DB/Redis singletons. Explicit process
// termination keeps this standalone CI proof from waiting on those handles.
process.exit(0);
