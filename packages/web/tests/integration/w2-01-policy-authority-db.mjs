// W2-01 real-Postgres invariant and concurrency proof.
//
// This test intentionally bypasses the service layer and exercises migration
// 045 exactly as PostgreSQL enforces it: DB-owned hashes, relational bindings,
// approval/evidence serialization, self-approval rejection, and append-only
// triggers. It runs only in the dedicated CI job against an ephemeral database.

import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import pg from "pg";

const { Client } = pg;
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");

function sha256Text(text) {
  return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}

async function expectReject(promise, pattern, label) {
  await assert.rejects(promise, pattern, label);
}

const installationId = 980000000001n;
const repositoryId = 980000000002n;
const authorId = randomUUID();
const approverId = randomUUID();
const baseClient = new Client({ connectionString: databaseUrl });
const approvalClient = new Client({ connectionString: databaseUrl });
const evidenceClient = new Client({ connectionString: databaseUrl });

await Promise.all([baseClient.connect(), approvalClient.connect(), evidenceClient.connect()]);

try {
  await baseClient.query(
    `INSERT INTO installations (github_id, account_login, account_type)
     VALUES ($1, 'w2-authority-ci', 'Organization')`,
    [installationId.toString()],
  );
  await baseClient.query(
    `INSERT INTO repositories (github_id, installation_id, full_name, owner, name)
     VALUES ($1, $2, 'w2-authority-ci/repo', 'w2-authority-ci', 'repo')`,
    [repositoryId.toString(), installationId.toString()],
  );
  await baseClient.query(
    `INSERT INTO gitwire_auth.auth_principals (id, principal_type, display_name)
     VALUES ($1, 'user', 'w2-author'), ($2, 'user', 'w2-approver')`,
    [authorId, approverId],
  );

  const proposedPolicy = {
    review: { enabled: true, minimum_confidence: 0.87 },
    dry_run: true,
  };
  const { rows: [rollout] } = await baseClient.query(
    `INSERT INTO policy_rollout_plans (
       repo_id, proposed_config, normalized_config, status, created_by
     ) VALUES ($1, $2, $2, 'review_ready', 'legacy-ci-fixture')
     RETURNING id`,
    [repositoryId.toString(), proposedPolicy],
  );

  const { rows: [version] } = await baseClient.query(
    `INSERT INTO policy_versions (
       repo_id, policy_document, normalized_document, author_principal_id
     ) VALUES ($1, $2, $2, $3)
     RETURNING id, content_hash, policy_document::text AS policy_text`,
    [repositoryId.toString(), proposedPolicy, authorId],
  );
  assert.equal(version.content_hash, sha256Text(version.policy_text), "policy hash must be DB-owned SHA-256 over stored JSONB text");

  const { rows: [changeRequest] } = await baseClient.query(
    `INSERT INTO policy_change_requests (
       rollout_plan_id, repo_id, policy_version_id, author_principal_id
     ) VALUES ($1, $2, $3, $4)
     RETURNING id`,
    [rollout.id, repositoryId.toString(), version.id, authorId],
  );

  const evidencePayloads = new Map([
    ["validation_result", { valid: true, errors: [] }],
    ["simulation_summary", { events_considered: 12, would_act: 3 }],
    ["diff_impact_summary", { risk: "low", changed: 2 }],
    ["recommendations_summary", { recommendations: [] }],
  ]);
  const manifest = [];

  for (const [type, payload] of evidencePayloads) {
    const { rows: [evidence] } = await baseClient.query(
      `INSERT INTO policy_evidence_records (
         change_request_id, policy_version_id, evidence_type,
         evidence_payload, recorded_by_principal_id
       ) VALUES ($1, $2, $3, $4, $5)
       RETURNING id, evidence_type, evidence_hash, evidence_payload::text AS evidence_text`,
      [changeRequest.id, version.id, type, payload, authorId],
    );
    assert.equal(
      evidence.evidence_hash,
      sha256Text(evidence.evidence_text),
      `${type} hash must be DB-owned SHA-256 over stored JSONB text`,
    );
    manifest.push({
      evidence_type: evidence.evidence_type,
      evidence_id: evidence.id,
      evidence_hash: evidence.evidence_hash,
    });
  }

  await expectReject(
    baseClient.query(
      `INSERT INTO policy_approval_records (
         change_request_id, policy_version_id, approver_principal_id,
         decision, evidence_manifest
       ) VALUES ($1, $2, $3, 'approved', $4::jsonb)`,
      [changeRequest.id, version.id, approverId, JSON.stringify(manifest.slice(0, 3))],
    ),
    /complete evidence set/,
    "approved records must bind exactly the complete four-type evidence set",
  );

  await expectReject(
    baseClient.query(
      `INSERT INTO policy_approval_records (
         change_request_id, policy_version_id, approver_principal_id,
         decision, evidence_manifest
       ) VALUES ($1, $2, $3, 'approved', $4::jsonb)`,
      [changeRequest.id, version.id, authorId, JSON.stringify(manifest)],
    ),
    /self-approval is forbidden/,
    "DB must reject author self-approval even if the service layer is bypassed",
  );

  const functionNames = [
    "prepare_w2_policy_version_insert",
    "prepare_w2_policy_evidence_insert",
    "prepare_w2_policy_approval_insert",
    "enforce_w2_policy_authority_append_only",
  ];
  const { rows: functionRows } = await baseClient.query(
    `SELECT proname, proconfig
       FROM pg_proc
      WHERE proname = ANY($1::text[])`,
    [functionNames],
  );
  assert.equal(functionRows.length, functionNames.length, "all W2-01 trigger functions must exist");
  for (const row of functionRows) {
    assert.ok(
      row.proconfig?.includes("search_path=public, pg_catalog, pg_temp"),
      `${row.proname} must pin a deterministic search_path`,
    );
  }

  // Prove the evidence/approval race is serialized by the shared change-request
  // row lock. The approval inserts first but remains uncommitted. A concurrent
  // late evidence append must block, then fail closed after approval commits.
  await approvalClient.query("BEGIN");
  const { rows: [approval] } = await approvalClient.query(
    `INSERT INTO policy_approval_records (
       change_request_id, policy_version_id, approver_principal_id,
       decision, reason, evidence_manifest
     ) VALUES ($1, $2, $3, 'approved', 'db-concurrency-proof', $4::jsonb)
     RETURNING id`,
    [changeRequest.id, version.id, approverId, JSON.stringify(manifest)],
  );

  await evidenceClient.query("BEGIN");
  let lateSettled = false;
  const lateEvidence = evidenceClient.query(
    `INSERT INTO policy_evidence_records (
       change_request_id, policy_version_id, evidence_type,
       evidence_payload, recorded_by_principal_id
     ) VALUES ($1, $2, 'validation_result', $3, $4)`,
    [changeRequest.id, version.id, { valid: true, late: true }, authorId],
  ).then(
    () => ({ ok: true, error: null }),
    (error) => ({ ok: false, error }),
  ).finally(() => {
    lateSettled = true;
  });

  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(lateSettled, false, "late evidence must wait on the approval transaction lock");

  await approvalClient.query("COMMIT");
  const lateResult = await lateEvidence;
  assert.equal(lateResult.ok, false, "late evidence must fail after approval commits");
  assert.match(lateResult.error.message, /frozen after an approval decision exists/);
  await evidenceClient.query("ROLLBACK");

  const { rows: [storedApproval] } = await baseClient.query(
    `SELECT evidence_set_hash, evidence_manifest::text AS manifest_text
       FROM policy_approval_records
      WHERE id = $1`,
    [approval.id],
  );
  assert.equal(
    storedApproval.evidence_set_hash,
    sha256Text(storedApproval.manifest_text),
    "approval evidence-set hash must be DB-owned SHA-256 over stored manifest JSONB text",
  );

  const immutableCases = [
    ["policy_versions", version.id],
    ["policy_change_requests", changeRequest.id],
    ["policy_evidence_records", manifest[0].evidence_id],
    ["policy_approval_records", approval.id],
  ];
  for (const [table, id] of immutableCases) {
    await expectReject(
      baseClient.query(`UPDATE ${table} SET id = id WHERE id = $1`, [id]),
      /append-only/,
      `${table} must reject UPDATE`,
    );
    await expectReject(
      baseClient.query(`DELETE FROM ${table} WHERE id = $1`, [id]),
      /append-only/,
      `${table} must reject DELETE`,
    );
    // CASCADE is required here so PostgreSQL reaches BEFORE TRUNCATE triggers
    // instead of rejecting parent tables at the FK dependency precheck.
    await expectReject(
      baseClient.query(`TRUNCATE TABLE ${table} CASCADE`),
      /append-only/,
      `${table} must reject TRUNCATE`,
    );
  }

  console.log("W2-01 Postgres authority invariants: PASS");
} finally {
  await Promise.allSettled([
    approvalClient.query("ROLLBACK"),
    evidenceClient.query("ROLLBACK"),
  ]);
  await Promise.allSettled([
    baseClient.end(),
    approvalClient.end(),
    evidenceClient.end(),
  ]);
}
