#!/usr/bin/env node
// packages/web/db/proof/run_gp02_policy_versions_proof.mjs
// GP-02 disposable proof: SECURITY DEFINER function-boundary model.
//
// Executable gates (each must produce a failure if the invariant is removed):
//   - Direct SQL INSERT/UPDATE/DELETE attempted as gitwire_app → fails
//   - Function collision: pre-create function → migration 045 aborts
//   - Concurrent version-vs-submission: one serializable outcome
//   - Forced event failure: state mutation rolls back
//   - Stale CAS in draft: no state change, no event
//   - Adversarial hash: quotes, backslashes, Unicode, newlines
//   - Non-draft version creation: rejected via FOR UPDATE lock
//   - Rollback: exact functions/grants dropped, no CASCADE
//   - Reapply: equivalent state restored

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
let proofFailed = false;
let cleanupFailed = false;
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
const pgName = "gp02-pg-" + pgPort;
const pgCid = docker("run", "-d", "--rm", "--name", pgName, "-p", "127.0.0.1:" + pgPort + ":5432", "-e", "POSTGRES_USER=proof", "-e", "POSTGRES_PASSWORD=proof-only", "-e", "POSTGRES_DB=proofdb", "postgres:16-alpine");
const dbUrl = "postgresql://proof:proof-only@127.0.0.1:" + pgPort + "/proofdb";

console.log("PG: " + pgName);

let pool = null;
try {
  await waitForReady(dbUrl, 60_000);
  pool = new pg.Pool({ connectionString: dbUrl });

  async function runAsApp(sql, params) {
    const c = await pool.connect();
    try {
      await c.query("SET SESSION AUTHORIZATION gitwire_app");
      return await c.query(sql, params);
    } finally {
      await c.query("RESET SESSION AUTHORIZATION");
      c.release();
    }
  }

  // ═══ Phase 1: Migrations ════════════════════════════════════════════════
  console.log("\n=== Phase 1: Apply migrations 001-045 ===");
  await applyMigrations(pool);
  const migCount = (await pool.query("SELECT count(*)::int n FROM schema_migrations")).rows[0].n;
  check("migration ledger = 45", migCount === 45, "count=" + migCount);

  // ═══ Phase 2: Direct SQL writes as gitwire_app → FAIL ═══════════════════
  console.log("\n=== Phase 2: Direct SQL writes attempted as gitwire_app ===");
  // Seed a principal first
  await pool.query("INSERT INTO gitwire_auth.auth_principals (principal_type, display_name) VALUES ('legacy-key','gp02-test') ON CONFLICT DO NOTHING");
  const testPid = (await pool.query("SELECT id FROM gitwire_auth.auth_principals WHERE display_name='gp02-test'")).rows[0].id;

  // Attempt direct INSERT as gitwire_app
  let directInsertBlocked = false;
  try {
    await runAsApp("INSERT INTO gitwire_policy.policy_change_requests (resource_type, resource_id, policy_family, author_principal_id) VALUES ('repository','test/r','test',$1)", [testPid]);
  } catch (e) { directInsertBlocked = true; }
  check("direct INSERT denied as gitwire_app", directInsertBlocked);

  // Attempt direct UPDATE as gitwire_app
  let directUpdateBlocked = false;
  try {
    await runAsApp("UPDATE gitwire_policy.policy_change_requests SET state = 'promoted' WHERE id = '00000000-0000-0000-0000-000000000000'");
  } catch (e) { directUpdateBlocked = true; }
  check("direct UPDATE denied as gitwire_app", directUpdateBlocked);

  // Attempt direct DELETE as gitwire_app
  let directDeleteBlocked = false;
  try {
    await runAsApp("DELETE FROM gitwire_policy.policy_versions WHERE id = '00000000-0000-0000-0000-000000000000'");
  } catch (e) { directDeleteBlocked = true; }
  check("direct DELETE denied as gitwire_app", directDeleteBlocked);

  // ═══ Phase 3: Function execution privileges ══════════════════════════════
  console.log("\n=== Phase 3: Function execution ===");
  const functions = [
    "create_policy_change_request(text, text, text, uuid)",
    "create_policy_version(uuid, jsonb, uuid)",
    "select_policy_version(uuid, uuid, bigint, uuid)",
    "submit_policy_change_request(uuid, bigint, uuid)",
  ];
  for (const fn of functions) {
    const { rows: appRows } = await pool.query("SELECT has_function_privilege('gitwire_app','gitwire_policy." + fn + "','EXECUTE') as can");
    check("gitwire_app EXECUTE on " + fn.split("(")[0], appRows[0].can === true);
    const { rows: pubRows } = await pool.query("SELECT has_function_privilege('public','gitwire_policy." + fn + "','EXECUTE') as can");
    check("PUBLIC NO EXECUTE on " + fn.split("(")[0], pubRows[0].can === false);
  }

  // ═══ Phase 4: Create change request + event atomically ══════════════════
  console.log("\n=== Phase 4: Create change request ===");
  const crResult = await runAsApp("SELECT gitwire_policy.create_policy_change_request('repository','test/repo','test-config',$1) as id", [testPid]);
  const crId = crResult.rows[0].id;
  check("change request created", crId != null);

  const { rows: [cr] } = await pool.query("SELECT * FROM gitwire_policy.policy_change_requests WHERE id = $1", [crId]);
  check("state = draft", cr.state === "draft");
  check("state_revision = 0", Number(cr.state_revision) === 0);

  const { rows: ev0 } = await pool.query("SELECT * FROM gitwire_policy.policy_transition_events WHERE change_request_id = $1", [crId]);
  check("initial event atomic", ev0.length === 1, "events=" + ev0.length);
  check("event type = create", ev0[0].event_type === "create");

  // ═══ Phase 5: Create version (hash in DB) ════════════════════════════════
  console.log("\n=== Phase 5: Create version ===");
  const payload1 = { version: 1, pillars: { triage: { enabled: true } }, settings: { dry_run: false } };
  const vr1 = await runAsApp("SELECT gitwire_policy.create_policy_version($1, $2, $3) as id", [crId, JSON.stringify(payload1), testPid]);
  const v1Id = vr1.rows[0].id;
  const { rows: [v1] } = await pool.query("SELECT * FROM gitwire_policy.policy_versions WHERE id = $1", [v1Id]);
  check("version created", v1Id != null);
  check("content_hash sha256 format", /^sha256:[0-9a-f]{64}$/.test(v1.content_hash));

  // ═══ Phase 6: Adversarial hash differentiation ═══════════════════════════
  console.log("\n=== Phase 6: Adversarial hash differentiation ===");
  const adversarial = [
    { name: "quotes in key", a: { "a\"b": 1 }, b: { "a": 1, "b": 1 } },
    { name: "backslash in key", a: { "a\\b": 1 }, b: { "a": 1 } },
    { name: "unicode", a: { "café": 1 }, b: { "cafe": 1 } },
    { name: "newline in value", a: { x: "line1\nline2" }, b: { x: "line1" } },
    { name: "tab in value", a: { x: "a\tb" }, b: { x: "ab" } },
    { name: "mixed ASCII/Unicode ordering", a: { z: 1, "β": 2, a: 3 }, b: { a: 3, z: 1, "β": 2 } }, // same after canonical with COLLATE C (identity check)
    { name: "nested reorder", a: { a: { b: 1, a: 2 } }, b: { a: { a: 2, b: 1 } } }, // same after canonical
  ];

  for (const adv of adversarial) {
    const r1 = await runAsApp("SELECT gitwire_policy.create_policy_version($1, $2, $3) as id", [crId, JSON.stringify(adv.a), testPid]);
    const r2 = await runAsApp("SELECT gitwire_policy.create_policy_version($1, $2, $3) as id", [crId, JSON.stringify(adv.b), testPid]);
    const { rows: [h1] } = await pool.query("SELECT content_hash FROM gitwire_policy.policy_versions WHERE id = $1", [r1.rows[0].id]);
    const { rows: [h2] } = await pool.query("SELECT content_hash FROM gitwire_policy.policy_versions WHERE id = $1", [r2.rows[0].id]);
    if (adv.name === "nested reorder" || adv.name === "mixed ASCII/Unicode ordering") {
      check(adv.name + ": identical after canonical", h1.content_hash === h2.content_hash);
    } else {
      check(adv.name + ": different hashes", h1.content_hash !== h2.content_hash);
    }
  }

  // ═══ Phase 7: Non-draft version creation (FOR UPDATE lock) ═══════════════
  console.log("\n=== Phase 7: Non-draft rejection ===");
  // Select a version, then submit
  await runAsApp("SELECT * FROM gitwire_policy.select_policy_version($1, $2, 0, $3)", [crId, v1Id, testPid]);
  const { rows: [crSel] } = await pool.query("SELECT state, state_revision FROM gitwire_policy.policy_change_requests WHERE id = $1", [crId]);
  check("revision incremented after select", Number(crSel.state_revision) === 1);

  await runAsApp("SELECT * FROM gitwire_policy.submit_policy_change_request($1, $2, $3)", [crId, Number(crSel.state_revision), testPid]);
  const { rows: [crSub] } = await pool.query("SELECT state, state_revision FROM gitwire_policy.policy_change_requests WHERE id = $1", [crId]);
  check("state = submitted", crSub.state === "submitted");

  // Try creating version in submitted state
  let nonDraftBlocked = false;
  try {
    await runAsApp("SELECT gitwire_policy.create_policy_version($1, $2, $3)", [crId, JSON.stringify({x:1}), testPid]);
  } catch (e) { nonDraftBlocked = true; }
  check("version creation rejected in submitted", nonDraftBlocked);

  // ═══ Phase 8: Stale CAS in draft (clean test) ═══════════════════════════
  console.log("\n=== Phase 8: Stale CAS (clean draft test) ===");
  // Create a fresh draft request for CAS testing
  const cr2Result = await runAsApp("SELECT gitwire_policy.create_policy_change_request('repository','cas/test','cfg',$1) as id", [testPid]);
  const cr2Id = cr2Result.rows[0].id;
  const vr2 = await runAsApp("SELECT gitwire_policy.create_policy_version($1, $2, $3) as id", [cr2Id, JSON.stringify({v:1}), testPid]);
  const v2Id = vr2.rows[0].id;

  // Valid select with correct revision (0)
  await runAsApp("SELECT * FROM gitwire_policy.select_policy_version($1, $2, 0, $3)", [cr2Id, v2Id, testPid]);

  // Now try select with stale revision 0 again (current is 1)
  let staleCas = false;
  try {
    await runAsApp("SELECT * FROM gitwire_policy.select_policy_version($1, $2, 0, $3)", [cr2Id, v2Id, testPid]);
  } catch (e) { staleCas = true; }
  check("stale CAS rejected in draft", staleCas);

  // Verify no extra event from failed CAS (create + select_version = 2 events)
  const { rows: evFail } = await pool.query("SELECT count(*)::int n FROM gitwire_policy.policy_transition_events WHERE change_request_id = $1", [cr2Id]);
  check("no event from failed CAS", evFail[0].n === 2, "events=" + evFail[0].n); // create + select_version

  // ═══ Phase 9: Concurrent version-vs-submission with lock proof ═════════
  console.log("\n=== Phase 9: FOR UPDATE lock contention ===");
  const cr3Result = await runAsApp("SELECT gitwire_policy.create_policy_change_request('repository','race/test','cfg',$1) as id", [testPid]);
  const cr3Id = cr3Result.rows[0].id;
  const vr3 = await runAsApp("SELECT gitwire_policy.create_policy_version($1, $2, $3) as id", [cr3Id, JSON.stringify({v:1}), testPid]);
  const v3Id = vr3.rows[0].id;
  await runAsApp("SELECT * FROM gitwire_policy.select_policy_version($1, $2, 0, $3)", [cr3Id, v3Id, testPid]);
  const { rows: [cr3Before] } = await pool.query("SELECT state_revision FROM gitwire_policy.policy_change_requests WHERE id = $1", [cr3Id]);

  // Prove FOR UPDATE blocks: hold a lock in one transaction, try to create version in another
  const lockClient = await pool.connect();
  const blockClient = await pool.connect();
  try {
    // Lock the change request row in lockClient (run as superuser to get FOR UPDATE)
    await lockClient.query("BEGIN");
    await lockClient.query("SELECT 1 FROM gitwire_policy.policy_change_requests WHERE id = $1 FOR UPDATE", [cr3Id]);

    // Now try create_policy_version in blockClient — it should block (timeout proves lock)
    await blockClient.query("SET SESSION AUTHORIZATION gitwire_app");
    await blockClient.query("SET lock_timeout = '2s'"); // fail after 2s instead of hanging
    let lockTimeout = false;
    try {
      await blockClient.query("SELECT gitwire_policy.create_policy_version($1, $2, $3) as id", [cr3Id, JSON.stringify({v:2}), testPid]);
    } catch (e) {
      lockTimeout = e.message.includes("canceling statement due to lock timeout") || e.code === "55P03";
    }
    check("create_policy_version blocks on FOR UPDATE lock", lockTimeout, "expected lock timeout");

    // Release the lock
    await lockClient.query("ROLLBACK");

    // Now try create_policy_version in blockClient — should succeed (lock released)
    await blockClient.query("RESET SESSION AUTHORIZATION");
    await blockClient.query("SET lock_timeout = DEFAULT");

    // Now version creation should succeed (lock released)
    const vrRace = await runAsApp("SELECT gitwire_policy.create_policy_version($1, $2, $3) as id", [cr3Id, JSON.stringify({v:3}), testPid]);
    check("version creation succeeds after lock release", vrRace.rows[0]?.id != null);

    // Submit should also work now (still in draft with correct revision)
    const { rows: [cr3Now] } = await pool.query("SELECT state_revision FROM gitwire_policy.policy_change_requests WHERE id = $1", [cr3Id]);
    const submitRace = await runAsApp("SELECT * FROM gitwire_policy.submit_policy_change_request($1, $2, $3)", [cr3Id, Number(cr3Now.state_revision), testPid]);
    check("submit succeeds after version creation completes", submitRace.rows[0]?.state === "submitted");

    // Version creation after submit must fail (not draft)
    let postSubmitVersionBlocked = false;
    try {
      await runAsApp("SELECT gitwire_policy.create_policy_version($1, $2, $3)", [cr3Id, JSON.stringify({v:4}), testPid]);
    } catch (e) { postSubmitVersionBlocked = e.message.includes("draft") || e.message.includes("state"); }
    check("version creation blocked after submit (serialized)", postSubmitVersionBlocked);
  } finally {
    try { await lockClient.query("ROLLBACK"); } catch {}
    try { await blockClient.query("RESET SESSION AUTHORIZATION"); } catch {}
    try { await blockClient.query("SET lock_timeout = DEFAULT"); } catch {}
    lockClient.release();
    blockClient.release();
  }

  // ═══ Phase 10: Forced event-failure rollback ════════════════════════════
  console.log("\n=== Phase 10: Forced event-failure rollback ===");
  // Revoke INSERT on policy_transition_events from gitwire_policy_fn_owner
  // so the SECURITY DEFINER function cannot insert the event, forcing
  // the entire function (request INSERT + event INSERT) to fail atomically
  await pool.query("REVOKE INSERT ON gitwire_policy.policy_transition_events FROM gitwire_policy_fn_owner");

  let eventFailBlocked = false;
  try {
    await runAsApp("SELECT gitwire_policy.create_policy_change_request('repository','fail/test','cfg',$1)", [testPid]);
  } catch (e) {
    eventFailBlocked = true;
  }
  check("forced event failure: function call fails", eventFailBlocked);

  // Verify no orphaned change request was left behind from the failed call
  const { rows: orphanCheck } = await pool.query("SELECT count(*)::int n FROM gitwire_policy.policy_change_requests WHERE resource_id = 'fail/test'");
  check("forced event failure: no orphaned request", orphanCheck[0].n === 0, "orphans=" + orphanCheck[0].n);

  // Restore the grant
  await pool.query("GRANT INSERT ON gitwire_policy.policy_transition_events TO gitwire_policy_fn_owner");

  // ═══ Phase 11: Scope boundary — exact function sets ═══════════════════
  console.log("\n=== Phase 11: Scope boundary ===");
  const expectedWriteFns = ['create_policy_change_request','create_policy_version','select_policy_version','submit_policy_change_request'];

  // 1. Exactly 4 SECURITY DEFINER functions owned by gitwire_policy_fn_owner
  const { rows: secDefFns } = await pool.query(
    "SELECT p.proname FROM pg_proc p JOIN pg_roles r ON p.proowner = r.oid JOIN pg_namespace n ON p.pronamespace = n.oid WHERE n.nspname = 'gitwire_policy' AND r.rolname = 'gitwire_policy_fn_owner' AND p.prosecdef = true"
  );
  const secDefNames = secDefFns.map(f => f.proname).sort();
  check("exactly 4 SECURITY DEFINER fn_owner functions", secDefNames.length === 4, "found=" + JSON.stringify(secDefNames));
  check("SECURITY DEFINER set matches expected", JSON.stringify(secDefNames) === JSON.stringify(expectedWriteFns.slice().sort()));

  // 2. Exactly 4 functions executable by gitwire_app
  const { rows: execFns } = await pool.query(
    "SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON p.pronamespace = n.oid WHERE n.nspname = 'gitwire_policy' AND EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl WHERE acl.grantee = (SELECT oid FROM pg_roles WHERE rolname = 'gitwire_app') AND acl.privilege_type = 'EXECUTE')"
  );
  const execNames = execFns.map(f => f.proname).sort();
  check("exactly 4 functions executable by gitwire_app", execNames.length === 4, "found=" + JSON.stringify(execNames));
  check("executable set matches expected", JSON.stringify(execNames) === JSON.stringify(expectedWriteFns.slice().sort()));

  // 3. No unexpected SECURITY DEFINER or executable functions
  const unexpectedSecDef = secDefNames.filter(n => !expectedWriteFns.includes(n));
  const unexpectedExec = execNames.filter(n => !expectedWriteFns.includes(n));
  check("no unexpected SECURITY DEFINER functions", unexpectedSecDef.length === 0, JSON.stringify(unexpectedSecDef));
  check("no unexpected executable functions", unexpectedExec.length === 0, JSON.stringify(unexpectedExec));

  // 4. None accept arbitrary state params
  for (const fn of expectedWriteFns) {
    const { rows: [fnArgs] } = await pool.query("SELECT pg_get_function_arguments(p.oid) as args FROM pg_proc p JOIN pg_namespace n ON p.pronamespace = n.oid WHERE n.nspname = 'gitwire_policy' AND p.proname = $1", [fn]);
    check(fn + ": no arbitrary state param", !(fnArgs.args.includes("to_state") || fnArgs.args.includes("new_state") || fnArgs.args.includes("destination")));
  }

  // 5. None can reach GP-03/04/05 states
  for (const targetState of ["validating", "awaiting_approval", "approved", "promoted"]) {
    const { rows: bodyCheck } = await pool.query(
      "SELECT count(*)::int n FROM pg_proc p JOIN pg_namespace n ON p.pronamespace = n.oid WHERE n.nspname = 'gitwire_policy' AND p.proname = ANY($1) AND prosrc LIKE $2",
      [expectedWriteFns, "%" + targetState + "%"]
    );
    check("no GP-02 function body references '" + targetState + "'", bodyCheck[0].n === 0);
  }

  // ═══ Phase 12: session_user check ═══════════════════════════════════════
  console.log("\n=== Phase 12: session_user check ===");
  let nonAppBlocked = false;
  try {
    await pool.query("SELECT gitwire_policy.create_policy_change_request('repository','hack/test','test',$1)", [testPid]);
  } catch (e) {
    nonAppBlocked = e.message.includes("gitwire_app");
  }
  check("non-gitwire_app caller rejected", nonAppBlocked);

  // ═══ Phase 13: Append-only enforcement ═══════════════════════════════════
  console.log("\n=== Phase 13: Append-only enforcement ===");
  let updBlocked = false;
  try { await pool.query("UPDATE gitwire_policy.policy_versions SET content_hash = 'sha256:aaa' WHERE id = $1", [v1Id]); } catch { updBlocked = true; }
  check("version UPDATE blocked", updBlocked);

  let delBlocked = false;
  try { await pool.query("DELETE FROM gitwire_policy.policy_versions WHERE id = $1", [v1Id]); } catch { delBlocked = true; }
  check("version DELETE blocked", delBlocked);

  // ═══ Phase 14: Function collision ═══════════════════════════════════════
  console.log("\n=== Phase 14: Function collision ===");
  // Rollback 045, pre-create the function, then try to reapply
  const rollbackSql = await readFile(join(ROLLBACK_DIR, "rollback_gp02_grants.sql"), "utf8");
  await pool.query(rollbackSql);

  // Pre-create a dummy function with the same signature
  await pool.query("CREATE FUNCTION gitwire_policy.create_policy_change_request(text, text, text, uuid) RETURNS void LANGUAGE sql AS $$ SELECT $$");
  await pool.query("INSERT INTO schema_migrations VALUES ('044_governed_policy_roles.sql') ON CONFLICT DO NOTHING");

  let functionCollision = false;
  try {
    const sql045 = await readFile(join(MIGRATIONS_DIR, "045_gp02_security_definer_functions.sql"), "utf8");
    await pool.query("BEGIN");
    await pool.query(sql045);
    await pool.query("COMMIT");
  } catch (e) {
    await pool.query("ROLLBACK");
    functionCollision = true;
  }
  check("function collision fails closed", functionCollision);

  // Cleanup
  await pool.query("DROP FUNCTION IF EXISTS gitwire_policy.create_policy_change_request(text, text, text, uuid)");
  await pool.query("DELETE FROM schema_migrations WHERE version = '045_gp02_security_definer_functions.sql'");

  // Reapply cleanly
  await applyMigrations(pool);
  const { rows: fnRestored } = await pool.query("SELECT count(*)::int n FROM pg_proc WHERE proname = 'create_policy_change_request' AND pronamespace = 'gitwire_policy'::regnamespace");
  check("function restored after clean reapply", fnRestored[0].n === 1);

  // ═══ Phase 15: Rollback + reapply with full equivalence ═════════════════
  console.log("\n=== Phase 15: Rollback + reapply equivalence ===");
  // Snapshot function metadata before rollback
  const fnNames = ['create_policy_change_request','create_policy_version','select_policy_version','submit_policy_change_request','canonical_jsonb'];
  const { rows: fnMetaBefore } = await pool.query(
    "SELECT p.proname, p.prosecdef as security_definer FROM pg_proc p JOIN pg_namespace n ON p.pronamespace = n.oid WHERE n.nspname = 'gitwire_policy' AND p.proname = ANY($1)",
    [fnNames]
  );
  const { rows: fnOwnerBefore } = await pool.query(
    "SELECT p.proname, r.rolname as owner FROM pg_proc p JOIN pg_roles r ON p.proowner = r.oid JOIN pg_namespace n ON p.pronamespace = n.oid WHERE n.nspname = 'gitwire_policy' AND p.proname = ANY($1)",
    [fnNames]
  );

  await pool.query(rollbackSql);
  const { rows: fnGone } = await pool.query("SELECT count(*)::int n FROM pg_proc p JOIN pg_namespace n ON p.pronamespace = n.oid WHERE n.nspname = 'gitwire_policy' AND p.proname = 'create_policy_change_request'");
  check("functions dropped after rollback", fnGone[0].n === 0);

  const ledger45 = (await pool.query("SELECT count(*)::int n FROM schema_migrations WHERE version = '045_gp02_security_definer_functions.sql'")).rows[0].n;
  check("045 ledger removed", ledger45 === 0);

  // Verify fn_owner table privileges revoked after rollback
  const { rows: fnOwnerPrivsAfter } = await pool.query("SELECT has_table_privilege('gitwire_policy_fn_owner','gitwire_policy.policy_change_requests','INSERT') as ins");
  check("fn_owner INSERT on change_requests revoked after rollback", fnOwnerPrivsAfter[0].ins === false);

  await applyMigrations(pool);
  const finalLedger = (await pool.query("SELECT count(*)::int n FROM schema_migrations")).rows[0].n;
  check("ledger = 45 after reapply", finalLedger === 45);

  // Verify functions restored with same properties
  const { rows: fnMetaAfter } = await pool.query(
    "SELECT p.proname, p.prosecdef as security_definer FROM pg_proc p JOIN pg_namespace n ON p.pronamespace = n.oid WHERE n.nspname = 'gitwire_policy' AND p.proname = ANY($1)",
    [fnNames]
  );
  check("same number of functions after reapply", fnMetaAfter.length === fnMetaBefore.length);

  // Verify each function has correct SECURITY DEFINER status
  for (const fn of fnMetaAfter) {
    if (fn.proname === "canonical_jsonb") {
      // Helper function is NOT SECURITY DEFINER — it's a normal IMMUTABLE function
      check(fn.proname + ": NOT SECURITY DEFINER (helper)", fn.security_definer === false);
    } else {
      check(fn.proname + ": SECURITY DEFINER", fn.security_definer === true);
    }
  }

  // Verify function ownership
  const { rows: fnOwnerAfter } = await pool.query(
    "SELECT p.proname, r.rolname as owner FROM pg_proc p JOIN pg_roles r ON p.proowner = r.oid JOIN pg_namespace n ON p.pronamespace = n.oid WHERE n.nspname = 'gitwire_policy' AND p.proname = ANY($1)",
    [fnNames]
  );
  for (const fn of fnOwnerAfter) {
    check(fn.proname + ": owner = gitwire_policy_fn_owner", fn.owner === "gitwire_policy_fn_owner");
  }

  // Verify fixed search_path via proconfig
  for (const fn of expectedWriteFns) {
    const { rows: [fnConfig] } = await pool.query("SELECT p.proconfig FROM pg_proc p JOIN pg_namespace n ON p.pronamespace = n.oid WHERE n.nspname = 'gitwire_policy' AND p.proname = $1", [fn]);
    const configStr = fnConfig.proconfig ? fnConfig.proconfig.join(",") : "";
    check(fn + ": search_path includes gitwire_policy", configStr.includes("gitwire_policy"), "config=" + configStr);
  }

  // Verify execution ACLs for the 4 write functions
  const execFnsCheck = ['create_policy_change_request','create_policy_version','select_policy_version','submit_policy_change_request'];
  for (const fn of execFnsCheck) {
    const { rows: [fnRow] } = await pool.query("SELECT p.oid FROM pg_proc p JOIN pg_namespace n ON p.pronamespace = n.oid WHERE n.nspname = 'gitwire_policy' AND p.proname = $1", [fn]);
    const { rows: [aclRow] } = await pool.query("SELECT EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl WHERE acl.grantee = (SELECT oid FROM pg_roles WHERE rolname = 'gitwire_app') AND acl.privilege_type = 'EXECUTE') as app_exec, EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl WHERE acl.grantee = 0 AND acl.privilege_type = 'EXECUTE') as public_exec FROM pg_proc p WHERE p.oid = $1", [fnRow.oid]);
    check(fn + ": gitwire_app EXECUTE restored", aclRow.app_exec === true);
    check(fn + ": PUBLIC NO EXECUTE restored", aclRow.public_exec === false);
  }

  // Verify canonical_jsonb ACL: PUBLIC NO EXECUTE
  const { rows: [cjAcl] } = await pool.query("SELECT EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl WHERE acl.grantee = 0 AND acl.privilege_type = 'EXECUTE') as public_exec FROM pg_proc p JOIN pg_namespace n ON p.pronamespace = n.oid WHERE n.nspname = 'gitwire_policy' AND p.proname = 'canonical_jsonb'");
  check("canonical_jsonb: PUBLIC NO EXECUTE", cjAcl.public_exec === false);

  // Full fn_owner privilege matrix
  const ownerTables = [
    { table: "policy_change_requests", privs: { SELECT: true, INSERT: true } },
    { table: "policy_versions", privs: { SELECT: true, INSERT: true } },
    { table: "policy_transition_events", privs: { INSERT: true } },
  ];
  for (const t of ownerTables) {
    for (const [priv, expected] of Object.entries(t.privs)) {
      const { rows: [r] } = await pool.query("SELECT has_table_privilege('gitwire_policy_fn_owner', $1, $2) as has", ["gitwire_policy." + t.table, priv]);
      check("fn_owner " + priv + " on " + t.table + " restored", r.has === expected);
    }
  }

  // Column-level UPDATE on policy_change_requests
  for (const col of ["state", "state_revision", "selected_version_id", "submitted_at", "updated_at"]) {
    const { rows: [r] } = await pool.query("SELECT has_column_privilege('gitwire_policy_fn_owner', 'gitwire_policy.policy_change_requests', $1, 'UPDATE') as has", [col]);
    check("fn_owner column UPDATE on " + col, r.has === true);
  }
  // Immutable columns NOT updatable
  for (const col of ["resource_type", "resource_id", "policy_family", "author_principal_id"]) {
    const { rows: [r] } = await pool.query("SELECT has_column_privilege('gitwire_policy_fn_owner', 'gitwire_policy.policy_change_requests', $1, 'UPDATE') as has", [col]);
    check("fn_owner NO column UPDATE on " + col, r.has === false);
  }

  // No table-wide UPDATE or DELETE for fn_owner
  const { rows: [updOwner] } = await pool.query("SELECT has_table_privilege('gitwire_policy_fn_owner','gitwire_policy.policy_change_requests','UPDATE') as has");
  check("fn_owner NO table-wide UPDATE on policy_change_requests", updOwner.has === false);
  const { rows: [delOwner] } = await pool.query("SELECT has_table_privilege('gitwire_policy_fn_owner','gitwire_policy.policy_versions','DELETE') as has");
  check("fn_owner NO DELETE on policy_versions", delOwner.has === false);

  // Verify gitwire_app still has NO direct write
  for (const table of ["policy_change_requests", "policy_versions", "policy_transition_events"]) {
    const { rows: [r] } = await pool.query("SELECT has_table_privilege('gitwire_app', $1, 'INSERT') as ins, has_table_privilege('gitwire_app', $1, 'UPDATE') as upd, has_table_privilege('gitwire_app', $1, 'DELETE') as del", ["gitwire_policy." + table]);
    check("gitwire_app NO INSERT on " + table, r.ins === false);
    check("gitwire_app NO UPDATE on " + table, r.upd === false);
    check("gitwire_app NO DELETE on " + table, r.del === false);
  }

  // ═══ Phase 16: CASCADE check ════════════════════════════════════════════
  console.log("\n=== Phase 16: CASCADE check ===");
  const migContent = await readFile(join(MIGRATIONS_DIR, "045_gp02_security_definer_functions.sql"), "utf8");
  check("migration no CASCADE", !/\bCASCADE\b/i.test(migContent.replace(/--.*/g, "")));
  check("rollback no CASCADE", !/\bCASCADE\b/i.test(rollbackSql.replace(/--.*/g, "")));

  // ═══ Phase 17: Fail-closed function creation ════════════════════════════
  console.log("\n=== Phase 17: Fail-closed function creation ===");
  check("migration uses plain CREATE FUNCTION", !/CREATE\s+OR\s+REPLACE/i.test(migContent));

  await pool.end();
} catch (e) {
  proofFailed = true;
  console.error("PROOF ERROR:", e.message);
  try { if (pool) await pool.end(); } catch {}
} finally {
  try {
    docker("rm", "-f", pgCid);
    console.log("cleanup: containers_removed");
  } catch (e) {
    cleanupFailed = true;
    console.error("cleanup: container_removal_failed:", e.message);
  }
}

if (!cleanupFailed) {
  console.log("cleanup completed");
  console.log("owned containers remaining: 0");
}
console.log("forced process exit: no");
console.log("\n=== GP-02 Policy Versions Proof: " + passed + " passed, " + failed + " failed ===");
process.exitCode = proofFailed || failed > 0 || cleanupFailed ? 1 : 0;
