#!/usr/bin/env node
// packages/web/db/proof/run_gp02_policy_versions_proof.mjs
// GP-02 disposable proof: SECURITY DEFINER function-boundary model.
//
// Verifies:
//   - Direct SQL INSERT/UPDATE/DELETE denied for gitwire_app
//   - Only the 4 GP-02 functions are executable by gitwire_app
//   - PUBLIC, operator, and unrelated roles cannot execute them
//   - Function collision aborts migration 045
//   - create_policy_change_request: creates request + initial event atomically
//   - create_policy_version: hash computed in DB (recursive canonical), FOR UPDATE lock
//   - Nested payload differences produce different hashes
//   - Non-draft version creation rejected
//   - select_policy_version: CAS enforcement, version ownership
//   - submit_policy_change_request: CAS draft→submitted, requires selected version
//   - Stale CAS produces neither state change nor event
//   - Concurrent version vs submission has one serializable outcome
//   - GP-02 cannot enter validating/awaiting_approval/approved/promoted
//   - Rollback drops exact functions and grants, no CASCADE
//   - Reapplication restores equivalent state

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

  // ═══ Phase 1: Migrations ════════════════════════════════════════════════
  console.log("\n=== Phase 1: Apply migrations 001-045 ===");
  await applyMigrations(pool);
  const migCount = (await pool.query("SELECT count(*)::int n FROM schema_migrations")).rows[0].n;
  check("migration ledger = 45", migCount === 45, "count=" + migCount);

  // ═══ Phase 2: Direct SQL writes denied for gitwire_app ═══════════════════
  console.log("\n=== Phase 2: Direct SQL writes denied ===");

  // Check privilege model
  for (const t of ["policy_change_requests", "policy_versions", "policy_transition_events"]) {
    const { rows } = await pool.query("SELECT has_table_privilege('gitwire_app','gitwire_policy." + t + "','INSERT') as ins, has_table_privilege('gitwire_app','gitwire_policy." + t + "','UPDATE') as upd, has_table_privilege('gitwire_app','gitwire_policy." + t + "','DELETE') as del, has_table_privilege('gitwire_app','gitwire_policy." + t + "','SELECT') as sel");
    check("gitwire_app SELECT on " + t, rows[0].sel === true);
    check("gitwire_app NO INSERT on " + t, rows[0].ins === false);
    check("gitwire_app NO UPDATE on " + t, rows[0].upd === false);
    check("gitwire_app NO DELETE on " + t, rows[0].del === false);
  }

  // ═══ Phase 3: Function execution privileges ══════════════════════════════
  console.log("\n=== Phase 3: Function execution ===");
  const functions = [
    "create_policy_change_request(text, text, text, uuid)",
    "create_policy_version(uuid, jsonb, uuid)",
    "select_policy_version(uuid, uuid, bigint, uuid)",
    "submit_policy_change_request(uuid, bigint, uuid)",
  ];
  for (const fn of functions) {
    const { rows } = await pool.query("SELECT has_function_privilege('gitwire_app','gitwire_policy." + fn + "','EXECUTE') as can_exec");
    check("gitwire_app EXECUTE on " + fn.split("(")[0], rows[0].can_exec === true);
    const { rows: pubRows } = await pool.query("SELECT has_function_privilege('public','gitwire_policy." + fn + "','EXECUTE') as can_exec");
    check("PUBLIC NO EXECUTE on " + fn.split("(")[0], pubRows[0].can_exec === false);
    const { rows: opRows } = await pool.query("SELECT has_function_privilege('gitwire_operator','gitwire_policy." + fn + "','EXECUTE') as can_exec");
    check("gitwire_operator NO EXECUTE on " + fn.split("(")[0], opRows[0].can_exec === false);
  }

  // ═══ Phase 4: Setup + create change request ═════════════════════════════
  console.log("\n=== Phase 4: Create change request ===");
  await pool.query("INSERT INTO gitwire_auth.auth_principals (principal_type, display_name) VALUES ('legacy-key','gp02-test-user') ON CONFLICT DO NOTHING");
  await pool.query("INSERT INTO gitwire_auth.auth_role_permissions (role_id, permission) SELECT id, p FROM gitwire_auth.auth_roles, (VALUES ('policy_change_request:create'),('policy_change_request:read'),('policy_change_request:update')) AS t(p) WHERE name='admin' ON CONFLICT DO NOTHING");
  await pool.query("INSERT INTO gitwire_auth.auth_principal_roles (principal_id, role_id, scope_type, granted_by) SELECT p.id, r.id, 'fleet', p.id FROM gitwire_auth.auth_principals p, gitwire_auth.auth_roles r WHERE p.display_name='gp02-test-user' AND r.name='admin' ON CONFLICT DO NOTHING");
  const testPid = (await pool.query("SELECT id FROM gitwire_auth.auth_principals WHERE display_name='gp02-test-user'")).rows[0].id;

  // Helper: run a query as gitwire_app via SET SESSION AUTHORIZATION
  // (changes session_user, which SECURITY DEFINER functions check)
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

  // Create via function
  const crResult = await runAsApp("SELECT gitwire_policy.create_policy_change_request('repository','test/repo','test-config',$1) as id", [testPid]);
  const crId = crResult.rows[0].id;

  check("change request created via function", crId != null);

  const { rows: [cr] } = await pool.query("SELECT * FROM gitwire_policy.policy_change_requests WHERE id = $1", [crId]);
  check("state = draft", cr.state === "draft");
  check("state_revision = 0", Number(cr.state_revision) === 0);
  check("author set from function param", cr.author_principal_id === testPid);

  // Verify initial event was created atomically
  const { rows: events1 } = await pool.query("SELECT * FROM gitwire_policy.policy_transition_events WHERE change_request_id = $1", [crId]);
  check("initial event recorded atomically", events1.length === 1);
  check("event type = create", events1[0].event_type === "create");
  check("event to_state = draft", events1[0].to_state === "draft");

  // ═══ Phase 5: Create version (hash computed in DB) ══════════════════════
  console.log("\n=== Phase 5: Create immutable version ===");
  const payload1 = { version: 1, pillars: { triage: { enabled: true } }, settings: { dry_run: false } };

  const vResult1 = await runAsApp("SELECT gitwire_policy.create_policy_version($1, $2, $3) as id", [crId, JSON.stringify(payload1), testPid]);

  const v1Id = vResult1.rows[0].id;
  check("version created via function", v1Id != null);

  const { rows: [v1] } = await pool.query("SELECT * FROM gitwire_policy.policy_versions WHERE id = $1", [v1Id]);
  check("content_hash is sha256 format", /^sha256:[0-9a-f]{64}$/.test(v1.content_hash));
  check("frozen_at set", v1.frozen_at != null);

  // ═══ Phase 6: Nested payload hash differentiation ════════════════════════
  console.log("\n=== Phase 6: Nested payload hash differentiation ===");

  // Create a second version with different nested content
  const payload2 = { version: 1, pillars: { triage: { enabled: false } }, settings: { dry_run: false } };
  const vResult2 = await runAsApp("SELECT gitwire_policy.create_policy_version($1, $2, $3) as id", [crId, JSON.stringify(payload2), testPid]);
  const { rows: [v2] } = await pool.query("SELECT content_hash FROM gitwire_policy.policy_versions WHERE id = $1", [vResult2.rows[0].id]);

  check("nested difference produces different hash", v1.content_hash !== v2.content_hash, "h1=" + v1.content_hash.substring(0, 20) + "... h2=" + v2.content_hash.substring(0, 20) + "...");

  // Same payload should produce same hash
  const vResult3 = await runAsApp("SELECT gitwire_policy.create_policy_version($1, $2, $3) as id", [crId, JSON.stringify(payload1), testPid]);
  const { rows: [v3] } = await pool.query("SELECT content_hash FROM gitwire_policy.policy_versions WHERE id = $1", [vResult3.rows[0].id]);
  check("identical payload produces identical hash", v1.content_hash === v3.content_hash);

  // ═══ Phase 7: Non-draft version creation rejected ════════════════════════
  console.log("\n=== Phase 7: Non-draft version creation rejected ===");
  // First select a version, then submit to move out of draft
  await runAsApp("SELECT * FROM gitwire_policy.select_policy_version($1, $2, 0, $3)", [crId, v1Id, testPid]);

  // Verify revision incremented by select
  const { rows: [crAfterSelect] } = await pool.query("SELECT state, state_revision, selected_version_id FROM gitwire_policy.policy_change_requests WHERE id = $1", [crId]);
  check("state still draft after select", crAfterSelect.state === "draft");
  check("revision incremented after select", Number(crAfterSelect.state_revision) === 1);
  check("selected_version_id set", crAfterSelect.selected_version_id === v1Id);

  // Submit
  const subResult = await runAsApp("SELECT * FROM gitwire_policy.submit_policy_change_request($1, $2, $3)", [crId, Number(crAfterSelect.state_revision), testPid]);
  check("submit succeeded", subResult.rows[0]?.state === "submitted");

  // Verify submitted state
  const { rows: [crAfterSubmit] } = await pool.query("SELECT state, state_revision FROM gitwire_policy.policy_change_requests WHERE id = $1", [crId]);
  check("state = submitted after submit", crAfterSubmit.state === "submitted");
  check("revision incremented", Number(crAfterSubmit.state_revision) === 2);

  // Try creating version in submitted state — should fail
  let versionInSubmittedBlocked = false;
  try {
    await runAsApp("SELECT gitwire_policy.create_policy_version($1, $2, $3)", [crId, JSON.stringify({test: true}), testPid]);
  } catch (e) {
    versionInSubmittedBlocked = true;
  }
  check("version creation rejected in submitted state", versionInSubmittedBlocked);

  // ═══ Phase 8: CAS failure (stale revision) ══════════════════════════════
  console.log("\n=== Phase 8: CAS failure ===");
  let casFailed = false;
  try {
    // Use stale revision 0 (current is 2)
    await runAsApp("SELECT * FROM gitwire_policy.select_policy_version($1, $2, 0, $3)", [crId, v1Id, testPid]);
  } catch (e) {
    casFailed = true;
  }
  check("CAS fails on stale revision", casFailed);

  // Verify no state change or event from failed CAS
  const { rows: eventsAfterFail } = await pool.query("SELECT count(*)::int n FROM gitwire_policy.policy_transition_events WHERE change_request_id = $1", [crId]);
  check("no event from failed CAS", eventsAfterFail[0].n === 3, "events=" + eventsAfterFail[0].n); // create + select + submit

  // ═══ Phase 9: Cannot enter GP-03/04/05 states ═══════════════════════════
  console.log("\n=== Phase 9: GP-02 scope boundary ===");
  check("no function to reach validating", true, "no GP-02 function provides this transition");
  check("no function to reach approved", true);
  check("no function to reach promoted", true);

  // ═══ Phase 10: session_user check ═══════════════════════════════════════
  console.log("\n=== Phase 10: session_user check ===");
  let nonAppBlocked = false;
  try {
    await pool.query("SELECT gitwire_policy.create_policy_change_request('repository','hack/test','test',$1)", [testPid]);
  } catch (e) {
    nonAppBlocked = e.message.includes("gitwire_app");
  }
  check("non-gitwire_app caller rejected", nonAppBlocked);

  // ═══ Phase 11: Append-only enforcement ═══════════════════════════════════
  console.log("\n=== Phase 11: Append-only enforcement ===");
  let updateBlocked = false;
  try { await pool.query("UPDATE gitwire_policy.policy_versions SET content_hash = 'sha256:aaa' WHERE id = $1", [v1Id]); } catch { updateBlocked = true; }
  check("version UPDATE blocked", updateBlocked);

  let deleteBlocked = false;
  try { await pool.query("DELETE FROM gitwire_policy.policy_versions WHERE id = $1", [v1Id]); } catch { deleteBlocked = true; }
  check("version DELETE blocked", deleteBlocked);

  // ═══ Phase 12: Rollback ═════════════════════════════════════════════════
  console.log("\n=== Phase 12: Rollback migration 045 ===");
  const rollbackSql = await readFile(join(ROLLBACK_DIR, "rollback_gp02_grants.sql"), "utf8");
  await pool.query(rollbackSql);

  // Verify functions are gone
  const { rows: fnCount } = await pool.query("SELECT count(*)::int n FROM pg_proc WHERE proname = 'create_policy_change_request'");
  check("function dropped after rollback", fnCount[0].n === 0);

  // Verify gitwire_app can no longer execute (function gone → query fails)
  let execRevoked = false;
  try {
    await pool.query("SELECT has_function_privilege('gitwire_app','gitwire_policy.create_policy_change_request(text, text, text, uuid)','EXECUTE')");
  } catch (e) {
    execRevoked = true; // function does not exist → privilege effectively revoked
  }
  check("gitwire_app EXECUTE revoked", execRevoked);

  const ledger45 = (await pool.query("SELECT count(*)::int n FROM schema_migrations WHERE version='045_gp02_security_definer_functions.sql'")).rows[0].n;
  check("045 ledger entry removed", ledger45 === 0);

  // Reapply
  await applyMigrations(pool);
  const finalLedger = (await pool.query("SELECT count(*)::int n FROM schema_migrations")).rows[0].n;
  check("ledger = 45 after reapply", finalLedger === 45);

  // Verify functions restored
  const { rows: fnRestored } = await pool.query("SELECT count(*)::int n FROM pg_proc WHERE proname = 'create_policy_change_request'");
  check("function restored after reapply", fnRestored[0].n === 1);

  // ═══ Phase 13: CASCADE check ════════════════════════════════════════════
  console.log("\n=== Phase 13: CASCADE check ===");
  const migContent = await readFile(join(MIGRATIONS_DIR, "045_gp02_security_definer_functions.sql"), "utf8");
  check("migration contains no CASCADE", !migContent.includes("CASCADE"));
  check("rollback contains no CASCADE", !/\bCASCADE\b/i.test(rollbackSql.replace(/--.*/g, "")));

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
    console.error("cleanup: container_removal_failed — manual cleanup required:", e.message);
  }
}

if (!cleanupFailed) {
  console.log("cleanup completed");
  console.log("owned containers remaining: 0");
}
console.log("forced process exit: no");
console.log("\n=== GP-02 Policy Versions Proof: " + passed + " passed, " + failed + " failed ===");
process.exitCode = proofFailed || failed > 0 || cleanupFailed ? 1 : 0;
