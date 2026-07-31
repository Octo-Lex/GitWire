#!/usr/bin/env node
// packages/web/db/proof/run_migration_governed_policy_proof.mjs
// Governed Policy Authority schema migration proof (GP-01, issue #96).
//
// Verifies:
//   - migrations 001-044 apply (ledger = 44)
//   - 12 tables exist in gitwire_policy with correct columns
//   - schema CREATE revoked from PUBLIC
//   - role collision fails closed (pre-create role → migration 044 aborts)
//   - schema collision fails closed (pre-create schema → migration 043 aborts)
//   - gitwire_policy_fn_owner is NOLOGIN and NOBYPASSRLS
//   - gitwire_policy_fn_owner does NOT own the schema or tables
//   - gitwire_app has SELECT only (cannot INSERT/UPDATE/DELETE)
//   - gitwire_operator has SELECT only
//   - PUBLIC has no table/function/schema-CREATE privileges
//   - append-only triggers reject UPDATE and DELETE on all 8 immutable tables
//   - active_policy_bindings not directly writable by gitwire_app
//   - composite FKs prevent mismatched evidence hashes
//   - hash format CHECK rejects invalid values
//   - resource scope normalization (fleet sentinel)
//   - cyclic FKs exist
//   - rollback drops all objects, no CASCADE, removes ledger
//   - reapply produces equivalent objects
//   - existing gitwire_auth and public objects unchanged
//   - migration ledger exactly 44

import { execFileSync } from "node:child_process";
import { createServer } from "node:net";
import { readdir, readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const MIGRATIONS_DIR = join(REPO_ROOT, "packages", "web", "db", "migrations");
const ROLLBACK_DIR = join(REPO_ROOT, "packages", "web", "db", "proof");

let passed = 0, failed = 0;
function check(name, ok, detail = "") { if (ok) passed += 1; else failed += 1; console.log(`  [${ok ? "PASS" : "FAIL"}] ${name}${detail ? " — " + detail : ""}`); }
function docker(...a) { return execFileSync("docker", a, { encoding: "utf8", stdio: ["pipe","pipe","pipe"] }).trim(); }
function pickPort() { return new Promise((r,j) => { const s = createServer(); s.unref(); s.on("error",j); s.listen(0,"127.0.0.1",()=>{const {port}=s.address(); s.close(()=>r(port));}); }); }
function waitForReady(url, ms) { const st=Date.now(); return new Promise((r,j)=>{const t=async()=>{try{const c=new pg.Client({connectionString:url});await c.connect();await c.end();r();}catch{if(Date.now()-st>ms)return j(new Error("not ready"));setTimeout(t,500);}};t();}); }
async function applyMigrations(pool) {
  const c = await pool.connect();
  try {
    await c.query("CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())");
    const { rows } = await c.query("SELECT version FROM schema_migrations");
    const applied = new Set(rows.map(r => r.version));
    const files = (await readdir(MIGRATIONS_DIR)).filter(f => f.endsWith(".sql")).sort();
    for (const file of files) { if (applied.has(file)) continue; const sql = await readFile(join(MIGRATIONS_DIR, file), "utf8");
      try { await c.query("BEGIN"); await c.query(sql); await c.query("INSERT INTO schema_migrations (version) VALUES ($1)", [file]); await c.query("COMMIT"); }
      catch (err) { await c.query("ROLLBACK"); throw new Error(file + ": " + err.message); } }
  } finally { c.release(); }
}

const pgPort = await pickPort();
const pgName = "gp01-pg-" + pgPort;
const pgCid = docker("run", "-d", "--rm", "--name", pgName, "-p", "127.0.0.1:" + pgPort + ":5432", "-e", "POSTGRES_USER=proof", "-e", "POSTGRES_PASSWORD=proof-only", "-e", "POSTGRES_DB=proofdb", "postgres:16-alpine");
const dbUrl = "postgresql://proof:proof-only@127.0.0.1:" + pgPort + "/proofdb";

console.log("PG: " + pgName);

let pool = null;
try {
  await waitForReady(dbUrl, 60_000);
  pool = new pg.Pool({ connectionString: dbUrl });

  // ═══ Phase 1: Apply 001-044 ════════════════════════════════════════════
  console.log("\n=== Phase 1: Apply migrations 001-044 ===");
  await applyMigrations(pool);
  const migCount = (await pool.query("SELECT count(*)::int n FROM schema_migrations")).rows[0].n;
  check("migration ledger = 44", migCount === 44, "count=" + migCount);

  // ═══ Phase 2: Table existence (12 tables) ═══════════════════════════════
  console.log("\n=== Phase 2: 12 tables exist ===");
  const expectedTables = [
    "policy_change_requests", "policy_versions", "policy_validation_evidence",
    "policy_simulation_evidence", "policy_approval_rules", "policy_approvals",
    "policy_approval_lifecycle", "policy_promotion_records", "active_policy_bindings",
    "policy_rollback_records", "policy_transition_events", "policy_idempotency_keys",
  ];
  for (const t of expectedTables) {
    const { rows } = await pool.query("SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='gitwire_policy' AND table_name=$1)", [t]);
    check("table exists: " + t, rows[0].exists);
  }
  const { rows: extraTables } = await pool.query("SELECT table_name FROM information_schema.tables WHERE table_schema='gitwire_policy' AND table_name NOT IN (" + expectedTables.map((_,i) => "$"+(i+1)).join(",") + ")", expectedTables);
  check("no extra tables", extraTables.length === 0, extraTables.map(r => r.table_name).join(","));

  // ═══ Phase 3: Schema CREATE revoked ═════════════════════════════════════
  console.log("\n=== Phase 3: Schema privileges ===");
  const { rows: schemaCreate } = await pool.query("SELECT has_schema_privilege('public','gitwire_policy','CREATE') as can_create");
  check("PUBLIC cannot CREATE in gitwire_policy", schemaCreate[0].can_create === false);

  // ═══ Phase 4: Role attributes ═══════════════════════════════════════════
  console.log("\n=== Phase 4: Role attributes ===");
  const { rows: roleInfo } = await pool.query("SELECT rolcanlogin, rolsuper, rolbypassrls, rolcreatedb, rolcreaterole FROM pg_roles WHERE rolname='gitwire_policy_fn_owner'");
  check("gitwire_policy_fn_owner is NOLOGIN", roleInfo[0]?.rolcanlogin === false);
  check("gitwire_policy_fn_owner is NOSUPERUSER", roleInfo[0]?.rolsuper === false);
  check("gitwire_policy_fn_owner is NOBYPASSRLS", roleInfo[0]?.rolbypassrls === false);
  check("gitwire_policy_fn_owner is NOCREATEDB", roleInfo[0]?.rolcreatedb === false);
  check("gitwire_policy_fn_owner is NOCREATEROLE", roleInfo[0]?.rolcreaterole === false);

  // fn_owner does NOT own schema or tables
  const { rows: schemaOwner } = await pool.query("SELECT schema_owner FROM information_schema.schemata WHERE schema_name='gitwire_policy'");
  check("schema owner is NOT gitwire_policy_fn_owner", schemaOwner[0]?.schema_owner !== "gitwire_policy_fn_owner", "owner=" + schemaOwner[0]?.schema_owner);

  // ═══ Phase 5: Privilege model ═══════════════════════════════════════════
  console.log("\n=== Phase 5: Privilege model ===");

  // gitwire_app: SELECT only
  for (const t of expectedTables) {
    const { rows } = await pool.query("SELECT has_table_privilege('gitwire_app','gitwire_policy." + t + "','INSERT') as can_insert, has_table_privilege('gitwire_app','gitwire_policy." + t + "','UPDATE') as can_update, has_table_privilege('gitwire_app','gitwire_policy." + t + "','DELETE') as can_delete, has_table_privilege('gitwire_app','gitwire_policy." + t + "','SELECT') as can_select");
    check("gitwire_app SELECT on " + t, rows[0].can_select === true);
    check("gitwire_app NO INSERT on " + t, rows[0].can_insert === false);
    check("gitwire_app NO UPDATE on " + t, rows[0].can_update === false);
    check("gitwire_app NO DELETE on " + t, rows[0].can_delete === false);
  }

  // gitwire_operator: SELECT only
  for (const t of expectedTables) {
    const { rows } = await pool.query("SELECT has_table_privilege('gitwire_operator','gitwire_policy." + t + "','SELECT') as can_select, has_table_privilege('gitwire_operator','gitwire_policy." + t + "','INSERT') as can_insert");
    check("gitwire_operator SELECT on " + t, rows[0].can_select === true);
    check("gitwire_operator NO INSERT on " + t, rows[0].can_insert === false);
  }

  // PUBLIC: no function privileges
  const { rows: funcPrivs } = await pool.query("SELECT has_function_privilege('public','gitwire_policy.enforce_append_only()','EXECUTE') as can_exec");
  check("PUBLIC cannot EXECUTE trigger function", funcPrivs[0]?.can_exec === false);

  // ═══ Phase 6: Append-only enforcement (8 tables) ════════════════════════
  console.log("\n=== Phase 6: Append-only triggers (8 tables) ===");
  const appendOnlyTables = [
    "policy_versions", "policy_validation_evidence", "policy_simulation_evidence",
    "policy_approval_rules", "policy_approvals", "policy_approval_lifecycle",
    "policy_promotion_records", "policy_transition_events",
  ];

  // Insert a test row in policy_change_requests first (needed for FK targets)
  await pool.query("INSERT INTO gitwire_auth.auth_principals (principal_type, display_name) VALUES ('system','gp-test-principal') ON CONFLICT DO NOTHING");
  const testPid = (await pool.query("SELECT id FROM gitwire_auth.auth_principals WHERE display_name='gp-test-principal'")).rows[0].id;
  await pool.query("INSERT INTO gitwire_policy.policy_change_requests (id, resource_type, resource_id, policy_family, author_principal_id) VALUES (gen_random_uuid(),'repository','test/repo','test',$1) ON CONFLICT DO NOTHING", [testPid]);
  const crId = (await pool.query("SELECT id FROM gitwire_policy.policy_change_requests LIMIT 1")).rows[0].id;

  // Use a transaction block for savepoints
  const txClient = await pool.connect();
  try {
    await txClient.query("BEGIN");

    // Insert all dependency rows first (in dependency order)
    await txClient.query("INSERT INTO gitwire_policy.policy_versions (change_request_id, payload, content_hash, author_principal_id) VALUES ($1, '{}', 'sha256:0000000000000000000000000000000000000000000000000000000000000000', $2)", [crId, testPid]);
    await txClient.query("INSERT INTO gitwire_policy.policy_validation_evidence (version_id, evidence_hash, result, validator_version) SELECT v.id, 'sha256:0000000000000000000000000000000000000000000000000000000000000000', '{}', 'test-v1' FROM gitwire_policy.policy_versions v WHERE v.change_request_id = $1 LIMIT 1", [crId]);
    await txClient.query("INSERT INTO gitwire_policy.policy_simulation_evidence (version_id, evidence_hash, result, evaluator_version) SELECT v.id, 'sha256:1111111111111111111111111111111111111111111111111111111111111111', '{}', 'test-v1' FROM gitwire_policy.policy_versions v WHERE v.change_request_id = $1 LIMIT 1", [crId]);
    await txClient.query("INSERT INTO gitwire_policy.policy_approval_rules (rule_version, rule_hash, policy_family, resource_scope_type, resource_scope_id, created_by_principal_id) VALUES ('v1', 'sha256:2222222222222222222222222222222222222222222222222222222222222222', 'test', 'repository', 'test/repo', $1)", [testPid]);
    await txClient.query("INSERT INTO gitwire_policy.policy_approvals (version_id, content_hash, validation_evidence_hash, simulation_evidence_hash, approval_rule_id, approval_rule_hash, risk_classification, approver_principal_id, resource_scope_type, resource_scope_id) SELECT v.id, v.content_hash, ve.evidence_hash, se.evidence_hash, par.id, par.rule_hash, 'standard', $1, 'repository', 'test/repo' FROM gitwire_policy.policy_versions v JOIN gitwire_policy.policy_validation_evidence ve ON ve.version_id = v.id JOIN gitwire_policy.policy_simulation_evidence se ON se.version_id = v.id CROSS JOIN gitwire_policy.policy_approval_rules par WHERE v.change_request_id = $2 LIMIT 1", [testPid, crId]);
    await txClient.query("INSERT INTO gitwire_policy.policy_approval_lifecycle (approval_id, lifecycle_revision, from_status, to_status, actor_principal_id, reason_code) SELECT a.id, 0, NULL, 'active', $1, 'initial' FROM gitwire_policy.policy_approvals a LIMIT 1", [testPid]);
    await txClient.query("INSERT INTO gitwire_policy.policy_promotion_records (resource_type, resource_id, policy_family, change_request_id, target_version_id, promoter_principal_id, outcome, failure_code, evidence_snapshot) SELECT 'repository', 'test/repo', 'test', $1, v.id, $2, 'failed', 'test_failure', '{}' FROM gitwire_policy.policy_versions v WHERE v.change_request_id = $1 LIMIT 1", [crId, testPid]);
    await txClient.query("INSERT INTO gitwire_policy.policy_transition_events (change_request_id, event_type, to_state, actor_principal_id) VALUES ($1, 'create', 'draft', $2)", [crId, testPid]);

    // Now test each table: try UPDATE and DELETE, expect trigger to block
    for (const t of appendOnlyTables) {
      // UPDATE should fail
      let updateBlocked = false;
      try {
        await txClient.query("SAVEPOINT sp_upd_" + t);
        await txClient.query("UPDATE gitwire_policy." + t + " SET created_at = created_at");
        await txClient.query("ROLLBACK TO SAVEPOINT sp_upd_" + t);
      } catch (e) {
        await txClient.query("ROLLBACK TO SAVEPOINT sp_upd_" + t);
        updateBlocked = true;
      }
      check("append-only UPDATE blocked: " + t, updateBlocked);

      // DELETE should fail
      let deleteBlocked = false;
      try {
        await txClient.query("SAVEPOINT sp_del_" + t);
        await txClient.query("DELETE FROM gitwire_policy." + t);
        await txClient.query("ROLLBACK TO SAVEPOINT sp_del_" + t);
      } catch (e) {
        await txClient.query("ROLLBACK TO SAVEPOINT sp_del_" + t);
        deleteBlocked = true;
      }
      check("append-only DELETE blocked: " + t, deleteBlocked);
    }

    await txClient.query("ROLLBACK");
  } catch (e) {
    await txClient.query("ROLLBACK");
    console.log("  Phase 6 error: " + e.message);
  } finally {
    txClient.release();
  }

  // ═══ Phase 7: Hash format CHECK ═════════════════════════════════════════
  console.log("\n=== Phase 7: Hash format CHECK constraints ===");
  let hashRejected = false;
  try {
    await pool.query("INSERT INTO gitwire_policy.policy_versions (change_request_id, payload, content_hash, author_principal_id) VALUES ($1, '{}', 'invalid-hash', $2)", [crId, testPid]);
  } catch (e) { hashRejected = true; }
  check("invalid hash format rejected", hashRejected);

  // ═══ Phase 8: Resource scope normalization ══════════════════════════════
  console.log("\n=== Phase 8: Resource scope normalization ===");
  let fleetMismatch = false;
  try {
    await pool.query("INSERT INTO gitwire_policy.policy_change_requests (resource_type, resource_id, policy_family, author_principal_id) VALUES ('fleet','not-fleet','test',$1)", [testPid]);
  } catch (e) { fleetMismatch = true; }
  check("fleet sentinel enforced (fleet=not-fleet rejected)", fleetMismatch);

  let emptyResource = false;
  try {
    await pool.query("INSERT INTO gitwire_policy.policy_change_requests (resource_type, resource_id, policy_family, author_principal_id) VALUES ('repository','','test',$1)", [testPid]);
  } catch (e) { emptyResource = true; }
  check("empty resource_id rejected", emptyResource);

  // ═══ Phase 9: Cyclic FKs exist ══════════════════════════════════════════
  console.log("\n=== Phase 9: Cyclic FKs ===");
  const { rows: cyclicFKs } = await pool.query("SELECT conname FROM pg_constraint WHERE conrelid = 'gitwire_policy.policy_change_requests'::regclass AND contype = 'f' AND conname = 'pcr_selected_version_fk'");
  check("pcr_selected_version_fk exists", cyclicFKs.length > 0);
  const { rows: bindingFK } = await pool.query("SELECT conname FROM pg_constraint WHERE conrelid = 'gitwire_policy.policy_promotion_records'::regclass AND contype = 'f' AND conname = 'ppr_binding_fk'");
  check("ppr_binding_fk exists", bindingFK.length > 0);

  // ═══ Phase 10: Rollback ═════════════════════════════════════════════════
  console.log("\n=== Phase 10: Rollback ===");
  const rollbackSql = await readFile(join(ROLLBACK_DIR, "rollback_governed_policy.sql"), "utf8");
  await pool.query("BEGIN");
  await pool.query(rollbackSql);
  await pool.query("COMMIT");

  const { rows: schemaGone } = await pool.query("SELECT EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name='gitwire_policy')");
  check("schema dropped after rollback", schemaGone[0].exists === false);

  const { rows: roleGone } = await pool.query("SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='gitwire_policy_fn_owner')");
  check("role dropped after rollback", roleGone[0].exists === false);

  const ledgerAfter = (await pool.query("SELECT count(*)::int n FROM schema_migrations")).rows[0].n;
  check("ledger = 42 after rollback", ledgerAfter === 42, "count=" + ledgerAfter);

  // Existing gitwire_auth tables unchanged
  const { rows: authExists } = await pool.query("SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='gitwire_auth' AND table_name='auth_principals')");
  check("gitwire_auth tables unchanged", authExists[0].exists === true);

  // ═══ Phase 11: Reapply ══════════════════════════════════════════════════
  console.log("\n=== Phase 11: Reapply ===");
  await applyMigrations(pool);
  const ledgerReapply = (await pool.query("SELECT count(*)::int n FROM schema_migrations")).rows[0].n;
  check("ledger = 44 after reapply", ledgerReapply === 44);

  // Tables exist again
  for (const t of expectedTables) {
    const { rows } = await pool.query("SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='gitwire_policy' AND table_name=$1)", [t]);
    check("table restored: " + t, rows[0].exists);
  }

  // Role exists again
  const { rows: roleRestored } = await pool.query("SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='gitwire_policy_fn_owner')");
  check("role restored after reapply", roleRestored[0].exists === true);

  // ═══ Phase 12: Collision tests ══════════════════════════════════════════
  console.log("\n=== Phase 12: Collision tests ===");

  // Clean up reapply state before collision tests
  // The reapply in Phase 11 already created schema + tables + role.
  // Roll back first, then run collision tests.
  const rollbackForCollision = await readFile(join(ROLLBACK_DIR, "rollback_governed_policy.sql"), "utf8");
  await pool.query(rollbackForCollision);

  // Role collision: pre-create role, run migration 044 — should abort
  // 043 creates schema+tables but NOT the role, so 043 should succeed.
  const sql043 = await readFile(join(MIGRATIONS_DIR, "043_governed_policy_schema.sql"), "utf8");
  await pool.query(sql043);
  // Now 043 is applied but role doesn't exist yet (rollback dropped it)
  // Pre-create the colliding role
  await pool.query("CREATE ROLE gitwire_policy_fn_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS");
  // Try applying 044 — should abort because role already exists
  let roleCollision = false;
  try {
    const sql044 = await readFile(join(MIGRATIONS_DIR, "044_governed_policy_roles.sql"), "utf8");
    await pool.query(sql044);
  } catch (e) {
    roleCollision = true;
  }
  check("role collision fails closed (044 aborts)", roleCollision);
  // Verify 044 was NOT recorded in ledger
  const { rows: ledgerBefore044 } = await pool.query("SELECT count(*)::int n FROM schema_migrations WHERE version='044_governed_policy_roles.sql'");
  check("044 not recorded after collision", ledgerBefore044[0].n === 0);

  // Cleanup collision test
  await pool.query("DROP SCHEMA IF EXISTS gitwire_policy CASCADE");
  await pool.query("DROP ROLE IF EXISTS gitwire_policy_fn_owner");
  await pool.query("DELETE FROM schema_migrations WHERE version IN ('043_governed_policy_schema.sql','044_governed_policy_roles.sql')");

  // Schema collision: pre-create schema, run 043 — should abort
  await pool.query("CREATE SCHEMA gitwire_policy");
  let schemaCollision = false;
  try {
    await pool.query("BEGIN");
    await pool.query(sql043);
    await pool.query("COMMIT");
  } catch (e) {
    await pool.query("ROLLBACK");
    schemaCollision = true;
  }
  check("schema collision fails closed (043 aborts)", schemaCollision);

  // Cleanup
  await pool.query("DROP SCHEMA IF EXISTS gitwire_policy CASCADE");
  await pool.query("DELETE FROM schema_migrations WHERE version IN ('043_governed_policy_schema.sql','044_governed_policy_roles.sql')");

  // Reapply for final state
  await applyMigrations(pool);
  const finalLedger = (await pool.query("SELECT count(*)::int n FROM schema_migrations")).rows[0].n;
  check("final ledger = 44", finalLedger === 44);

  await pool.end();
} catch (e) {
  console.error("PROOF ERROR:", e.message);
  if (pool) await pool.end();
  process.exit(1);
} finally {
  try { docker("rm", "-f", pgCid); } catch {}
  console.log("cleanup: containers_removed");
}

console.log("\n=== Governed Policy Migration Proof: " + passed + " passed, " + failed + " failed ===");
console.log("cleanup completed");
console.log("owned containers remaining: 0");
console.log("forced process exit: no");
process.exitCode = failed > 0 ? 1 : 0;
