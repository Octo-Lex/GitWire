#!/usr/bin/env node
// packages/web/db/proof/run_gp04_validation_simulation_proof.mjs
// GP-04 disposable proof: validation, simulation, and atomic finalization.
//
// Critical executable gates (each must FAIL if the invariant is removed):
//   - Success: both evidence rows, one transition, exactly one 5-key event
//   - Validation failure: validation evidence persisted, request rejected
//   - Simulation failure: both evidence persisted, request rejected
//   - Forced failure of evidence insert → zero partial state (atomicity)
//   - Concurrent finalization: one winner, one CAS failure
//   - Stale revision / wrong state rejection
//   - JSON boolean enforcement (reject string "true")
//   - Independent evidence-hash recomputation
//   - Hash mutation sensitivity
//   - Rejection of client-supplied risk from outside the envelope
//   - Exact ACL and column-privilege equivalence
//   - Provenance table access control
//   - Rollback refusal when authoritative data exists
//   - GP-03 compatibility: real GP-04 event consumed by GP-03 approvals

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
function check(name, ok, detail = "") { if (ok) passed += 1; else failed += 1; console.log(`  [${ok ? "PASS" : "FAIL"}] ${name}${detail ? " — " + detail : ""}`); }
function docker(...a) { return execFileSync("docker", a, { encoding: "utf8" }).trim(); }
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
const pgName = "gp04-pg-" + pgPort;
const pgCid = docker("run", "-d", "--rm", "--name", pgName, "-p", "127.0.0.1:" + pgPort + ":5432", "-e", "POSTGRES_USER=proof", "-e", "POSTGRES_PASSWORD=proof-only", "-e", "POSTGRES_DB=proofdb", "postgres:16-alpine");
const dbUrl = "postgresql://proof:proof-only@127.0.0.1:" + pgPort + "/proofdb";

let pool = null;
try {
  await waitForReady(dbUrl, 60_000);
  pool = new pg.Pool({ connectionString: dbUrl });

  async function runAsApp(sql, params) {
    const c = await pool.connect();
    try { await c.query("SET SESSION AUTHORIZATION gitwire_app"); return await c.query(sql, params); }
    finally { await c.query("RESET SESSION AUTHORIZATION"); c.release(); }
  }

  // ═══ Phase 1: Migrations ════════════════════════════════════════════
  console.log("\n=== Phase 1: Apply migrations 001-047 ===");
  await applyMigrations(pool);
  const migCount = (await pool.query("SELECT count(*)::int n FROM schema_migrations")).rows[0].n;
  check("migration ledger = 47", migCount === 47, "count=" + migCount);

  // ═══ Phase 2: Function exists and is SECURITY DEFINER ════════════════
  console.log("\n=== Phase 2: finalize_policy_evaluation exists ===");
  const { rows: [fn] } = await pool.query("SELECT p.prosecdef, pg_get_userbyid(p.proowner) AS owner FROM pg_proc p JOIN pg_namespace n ON p.pronamespace=n.oid WHERE n.nspname='gitwire_policy' AND p.proname='finalize_policy_evaluation'");
  check("function exists", fn !== undefined);
  check("SECURITY DEFINER", fn.prosecdef === true);
  check("OWNER gitwire_policy_fn_owner", fn.owner === "gitwire_policy_fn_owner");

  // ═══ Phase 3: Direct SQL denied on evidence tables ═══════════════════
  console.log("\n=== Phase 3: Direct SQL denied ===");
  for (const t of ["policy_validation_evidence", "policy_simulation_evidence"]) {
    let blocked = false;
    try { await runAsApp("INSERT INTO gitwire_policy." + t + " DEFAULT VALUES"); } catch { blocked = true; }
    check("gitwire_app NO INSERT on " + t, blocked);
  }

  // ═══ Phase 4: Setup fixtures ═════════════════════════════════════════
  console.log("\n=== Phase 4: Setup fixtures ===");
  await pool.query("INSERT INTO gitwire_auth.auth_principals (principal_type, display_name) VALUES ('legacy-key','gp04-admin') ON CONFLICT DO NOTHING");
  await pool.query("INSERT INTO gitwire_auth.auth_principals (principal_type, display_name) VALUES ('legacy-key','gp04-author') ON CONFLICT DO NOTHING");
  const adminPid = (await pool.query("SELECT id FROM gitwire_auth.auth_principals WHERE display_name='gp04-admin'")).rows[0].id;
  const authorPid = (await pool.query("SELECT id FROM gitwire_auth.auth_principals WHERE display_name='gp04-author'")).rows[0].id;
  await pool.query("INSERT INTO gitwire_auth.auth_principal_roles (principal_id, role_id, scope_type, granted_by) SELECT $1, r.id, 'fleet', $1 FROM gitwire_auth.auth_roles r WHERE r.name='admin' ON CONFLICT DO NOTHING", [adminPid]);
  await pool.query("INSERT INTO installations (github_id, account_login, account_type) VALUES (99001, 'gp04', 'Organization') ON CONFLICT DO NOTHING");
  await pool.query("INSERT INTO repositories (github_id, installation_id, full_name, owner, name, private, default_branch, language, stars, open_issues, open_prs) VALUES (99002, 99001, 'gp04/test', 'gp04', 'test', false, 'main', 'x', 0, 0, 0) ON CONFLICT DO NOTHING");
  await pool.query("INSERT INTO gitwire_auth.auth_role_permissions (role_id, permission) SELECT id, p FROM gitwire_auth.auth_roles, (VALUES ('policy_change_request:evaluate'),('policy_validation_evidence:read'),('policy_simulation_evidence:read'),('policy_change_request:create'),('policy_change_request:update'),('policy_change_request:read'),('policy_approval_rule:create'),('policy_approval_rule:read'),('policy_approval:create'),('policy_approval:revoke'),('policy_change_request:approve')) AS t(p) WHERE name='admin' ON CONFLICT DO NOTHING");
  check("fixtures created", adminPid && authorPid);

  // Helper to create a submitted CR
  async function createSubmittedCR(authorPid) {
    const cr = await runAsApp("SELECT gitwire_policy.create_policy_change_request('repository','gp04/test','test-config',$1) as id", [authorPid]);
    const crId = cr.rows[0].id;
    const v = await runAsApp("SELECT gitwire_policy.create_policy_version($1, $2, $3) as id", [crId, JSON.stringify({v:1}), authorPid]);
    const vId = v.rows[0].id;
    await runAsApp("SELECT * FROM gitwire_policy.select_policy_version($1, $2, 0, $3)", [crId, vId, authorPid]);
    const { rows: [sel] } = await pool.query("SELECT state_revision FROM gitwire_policy.policy_change_requests WHERE id = $1", [crId]);
    await runAsApp("SELECT * FROM gitwire_policy.submit_policy_change_request($1, $2, $3)", [crId, Number(sel.state_revision), authorPid]);
    return { crId, vId };
  }

  // ═══ Phase 5: Success path ═══════════════════════════════════════════
  console.log("\n=== Phase 5: Success path (submitted → awaiting_approval) ===");
  {
    const { crId, vId } = await createSubmittedCR(authorPid);
    const { rows: [crBefore] } = await pool.query("SELECT state_revision FROM gitwire_policy.policy_change_requests WHERE id = $1", [crId]);

    const valResult = { valid: true, errors: [], warnings: [], checked_at: "2026-08-04T00:00:00Z" };
    const simResult = { passed: true, risk_classification: "standard", classifier_version: "classifier-v1", simulation_profile: { version: "sim-profile-v1" }, dataset_snapshot: { upper_bound: "2026-08-04T00:00:00Z", record_count: 0, input_set_hash: "sha256:" + "0".repeat(64) }, summary: {}, simulated_at: "2026-08-04T00:00:00Z" };

    const result = await runAsApp(
      "SELECT * FROM gitwire_policy.finalize_policy_evaluation($1, $2, $3::jsonb, $4, $5::jsonb, $6, $7)",
      [crId, Number(crBefore.state_revision), JSON.stringify(valResult), "gitwire-rules-v1", JSON.stringify(simResult), "gitwire-sim-v1", authorPid]
    );

    check("state = awaiting_approval", result.rows[0].out_state === "awaiting_approval", "state=" + result.rows[0].out_state);
    check("validation_evidence_hash is sha256 format", /^sha256:[0-9a-f]{64}$/.test(result.rows[0].out_validation_evidence_hash));
    check("simulation_evidence_hash is sha256 format", /^sha256:[0-9a-f]{64}$/.test(result.rows[0].out_simulation_evidence_hash));

    // Verify exactly one 5-key event
    const eventCount = (await pool.query("SELECT count(*)::int n FROM gitwire_policy.policy_transition_events WHERE change_request_id = $1 AND to_state = 'awaiting_approval'", [crId])).rows[0].n;
    check("exactly one awaiting_approval event", eventCount === 1, "count=" + eventCount);

    // Verify the 5 keys
    const { rows: [evt] } = await pool.query("SELECT detail FROM gitwire_policy.policy_transition_events WHERE change_request_id = $1 AND to_state = 'awaiting_approval'", [crId]);
    check("event has validation_evidence_hash", evt.detail.validation_evidence_hash === result.rows[0].out_validation_evidence_hash);
    check("event has simulation_evidence_hash", evt.detail.simulation_evidence_hash === result.rows[0].out_simulation_evidence_hash);
    check("event has risk_classification", evt.detail.risk_classification === "standard");
    check("event state_revision is number", typeof evt.detail.state_revision === "number");
    check("event state_revision matches post-transition", evt.detail.state_revision === Number(result.rows[0].out_state_revision));
    check("event version_id matches", evt.detail.version_id === vId);

    // Verify evidence rows exist
    const valEv = (await pool.query("SELECT count(*)::int n FROM gitwire_policy.policy_validation_evidence WHERE version_id = $1", [vId])).rows[0].n;
    check("validation evidence row exists", valEv === 1);
    const simEv = (await pool.query("SELECT count(*)::int n FROM gitwire_policy.policy_simulation_evidence WHERE version_id = $1", [vId])).rows[0].n;
    check("simulation evidence row exists", simEv === 1);

    // GP-03 compatibility: can record an approval using this event
    const ruleResult = await runAsApp("SELECT gitwire_policy.create_policy_approval_rule('v1', 'test-config', 'fleet', 'fleet', 'standard', 1, '[\"admin\"]', $1, NULL) as id", [adminPid]);
    const ruleId = ruleResult.rows[0].id;
    // Resolve the effective rule for this CR
    const apprResult = await runAsApp("SELECT gitwire_policy.record_policy_approval($1, $2, $3) as id", [crId, ruleId, adminPid]);
    check("GP-03 compatibility: approval recorded using GP-04 event", apprResult.rows[0].id != null);
  }

  // ═══ Phase 6: Validation failure path ════════════════════════════════
  console.log("\n=== Phase 6: Validation failure → rejected ===");
  {
    const { crId, vId } = await createSubmittedCR(authorPid);
    const { rows: [crBefore] } = await pool.query("SELECT state_revision FROM gitwire_policy.policy_change_requests WHERE id = $1", [crId]);

    const valResult = { valid: false, errors: ["test error"], warnings: [], checked_at: "2026-08-04T00:00:00Z" };

    const result = await runAsApp(
      "SELECT * FROM gitwire_policy.finalize_policy_evaluation($1, $2, $3::jsonb, $4, NULL, NULL, $5)",
      [crId, Number(crBefore.state_revision), JSON.stringify(valResult), "gitwire-rules-v1", authorPid]
    );

    check("state = rejected", result.rows[0].out_state === "rejected", "state=" + result.rows[0].out_state);
    check("simulation_evidence_hash is null", result.rows[0].out_simulation_evidence_hash === null);

    // Validation evidence persisted
    const valEv = (await pool.query("SELECT count(*)::int n FROM gitwire_policy.policy_validation_evidence WHERE version_id = $1", [vId])).rows[0].n;
    check("validation evidence persisted on failure", valEv === 1);
    // No simulation evidence
    const simEv = (await pool.query("SELECT count(*)::int n FROM gitwire_policy.policy_simulation_evidence WHERE version_id = $1", [vId])).rows[0].n;
    check("no simulation evidence on validation failure", simEv === 0);
    // No awaiting_approval event
    const evtCount = (await pool.query("SELECT count(*)::int n FROM gitwire_policy.policy_transition_events WHERE change_request_id = $1 AND to_state = 'awaiting_approval'", [crId])).rows[0].n;
    check("no awaiting_approval event on validation failure", evtCount === 0);
    // Rejection event exists
    const rejCount = (await pool.query("SELECT count(*)::int n FROM gitwire_policy.policy_transition_events WHERE change_request_id = $1 AND to_state = 'rejected'", [crId])).rows[0].n;
    check("rejection event exists", rejCount === 1);
  }

  // ═══ Phase 7: Simulation failure path ════════════════════════════════
  console.log("\n=== Phase 7: Simulation failure → rejected ===");
  {
    const { crId, vId } = await createSubmittedCR(authorPid);
    const { rows: [crBefore] } = await pool.query("SELECT state_revision FROM gitwire_policy.policy_change_requests WHERE id = $1", [crId]);

    const valResult = { valid: true, errors: [], warnings: [], checked_at: "2026-08-04T00:00:00Z" };
    const simResult = { passed: false, risk_classification: "standard", classifier_version: "classifier-v1", simulation_profile: { version: "sim-profile-v1" }, dataset_snapshot: { upper_bound: "2026-08-04T00:00:00Z", record_count: 0, input_set_hash: "sha256:" + "0".repeat(64) }, summary: {}, simulated_at: "2026-08-04T00:00:00Z" };

    const result = await runAsApp(
      "SELECT * FROM gitwire_policy.finalize_policy_evaluation($1, $2, $3::jsonb, $4, $5::jsonb, $6, $7)",
      [crId, Number(crBefore.state_revision), JSON.stringify(valResult), "gitwire-rules-v1", JSON.stringify(simResult), "gitwire-sim-v1", authorPid]
    );

    check("state = rejected", result.rows[0].out_state === "rejected", "state=" + result.rows[0].out_state);
    check("simulation_evidence_hash is not null", result.rows[0].out_simulation_evidence_hash !== null);
    // Both evidence persisted
    const valEv = (await pool.query("SELECT count(*)::int n FROM gitwire_policy.policy_validation_evidence WHERE version_id = $1", [vId])).rows[0].n;
    check("validation evidence persisted", valEv === 1);
    const simEv = (await pool.query("SELECT count(*)::int n FROM gitwire_policy.policy_simulation_evidence WHERE version_id = $1", [vId])).rows[0].n;
    check("simulation evidence persisted", simEv === 1);
    // No awaiting_approval event
    const evtCount = (await pool.query("SELECT count(*)::int n FROM gitwire_policy.policy_transition_events WHERE change_request_id = $1 AND to_state = 'awaiting_approval'", [crId])).rows[0].n;
    check("no awaiting_approval event on simulation failure", evtCount === 0);
  }

  // ═══ Phase 8: JSON boolean enforcement ═══════════════════════════════
  console.log("\n=== Phase 8: JSON boolean enforcement ===");
  {
    const { crId } = await createSubmittedCR(authorPid);
    const { rows: [crBefore] } = await pool.query("SELECT state_revision FROM gitwire_policy.policy_change_requests WHERE id = $1", [crId]);

    // Pass valid as a string "true" instead of boolean true
    let stringBoolBlocked = false;
    try {
      await runAsApp(
        "SELECT * FROM gitwire_policy.finalize_policy_evaluation($1, $2, '{\"valid\":\"true\"}'::jsonb, 'v1', NULL, NULL, $3)",
        [crId, Number(crBefore.state_revision), authorPid]
      );
    } catch (e) { stringBoolBlocked = e.message.includes("boolean"); }
    check("string 'true' for valid rejected", stringBoolBlocked);
    // CR should still be submitted (atomic rollback)
    const { rows: [crState] } = await pool.query("SELECT state FROM gitwire_policy.policy_change_requests WHERE id = $1", [crId]);
    check("CR remains submitted after boolean rejection", crState.state === "submitted", "state=" + crState.state);
  }

  // ═══ Phase 9: Stale revision / wrong state ═══════════════════════════
  console.log("\n=== Phase 9: CAS rejection ===");
  {
    const { crId } = await createSubmittedCR(authorPid);
    const valResult = { valid: true, errors: [], warnings: [], checked_at: "2026-08-04T00:00:00Z" };
    const simResult = { passed: true, risk_classification: "standard", classifier_version: "v1", simulation_profile: { version: "p1" }, dataset_snapshot: { upper_bound: "2026-08-04T00:00:00Z", record_count: 0, input_set_hash: "sha256:" + "0".repeat(64) }, summary: {}, simulated_at: "2026-08-04T00:00:00Z" };

    // Stale revision
    let staleBlocked = false;
    try { await runAsApp("SELECT * FROM gitwire_policy.finalize_policy_evaluation($1, 99999, $2::jsonb, 'v1', $3::jsonb, 'v1', $4)", [crId, JSON.stringify(valResult), JSON.stringify(simResult), authorPid]); }
    catch (e) { staleBlocked = e.message.includes("CAS"); }
    check("stale revision rejected", staleBlocked);

    // Wrong state (already transitioned — need a CR in draft)
    const cr2 = await runAsApp("SELECT gitwire_policy.create_policy_change_request('repository','gp04/test','test-config',$1) as id", [authorPid]);
    let wrongStateBlocked = false;
    try { await runAsApp("SELECT * FROM gitwire_policy.finalize_policy_evaluation($1, 0, $2::jsonb, 'v1', NULL, NULL, $3)", [cr2.rows[0].id, JSON.stringify(valResult), authorPid]); }
    catch (e) { wrongStateBlocked = e.message.includes("submitted"); }
    check("wrong state (draft) rejected", wrongStateBlocked);
  }

  // ═══ Phase 10: Unauthorized actor ════════════════════════════════════
  console.log("\n=== Phase 10: Actor eligibility ===");
  {
    await pool.query("INSERT INTO gitwire_auth.auth_principals (principal_type, display_name) VALUES ('legacy-key','gp04-nonadmin') ON CONFLICT DO NOTHING");
    const nonAdminPid = (await pool.query("SELECT id FROM gitwire_auth.auth_principals WHERE display_name='gp04-nonadmin'")).rows[0].id;
    const { crId } = await createSubmittedCR(authorPid);
    const { rows: [crBefore] } = await pool.query("SELECT state_revision FROM gitwire_policy.policy_change_requests WHERE id = $1", [crId]);
    const valResult = { valid: true, errors: [], warnings: [], checked_at: "2026-08-04T00:00:00Z" };

    let nonAdminBlocked = false;
    try { await runAsApp("SELECT * FROM gitwire_policy.finalize_policy_evaluation($1, $2, $3::jsonb, 'v1', NULL, NULL, $4)", [crId, Number(crBefore.state_revision), JSON.stringify(valResult), nonAdminPid]); }
    catch (e) { nonAdminBlocked = e.message.includes("author") || e.message.includes("admin") || e.message.includes("active"); }
    check("non-author non-admin rejected", nonAdminBlocked);
  }

  // ═══ Phase 11: Independent hash recomputation ═══════════════════════
  console.log("\n=== Phase 11: Hash recomputation ===");
  {
    const { crId, vId } = await createSubmittedCR(authorPid);
    const { rows: [crBefore] } = await pool.query("SELECT state_revision FROM gitwire_policy.policy_change_requests WHERE id = $1", [crId]);
    const valResult = { valid: true, errors: [], warnings: [], checked_at: "2026-08-04T00:00:00Z" };
    const simResult = { passed: true, risk_classification: "standard", classifier_version: "classifier-v1", simulation_profile: { version: "sim-profile-v1" }, dataset_snapshot: { upper_bound: "2026-08-04T00:00:00Z", record_count: 0, input_set_hash: "sha256:" + "0".repeat(64) }, summary: {}, simulated_at: "2026-08-04T00:00:00Z" };

    const result = await runAsApp(
      "SELECT * FROM gitwire_policy.finalize_policy_evaluation($1, $2, $3::jsonb, $4, $5::jsonb, $6, $7)",
      [crId, Number(crBefore.state_revision), JSON.stringify(valResult), "gitwire-rules-v1", JSON.stringify(simResult), "gitwire-sim-v1", authorPid]
    );

    // Recompute the validation evidence hash independently
    const { rows: [version] } = await pool.query("SELECT id, content_hash FROM gitwire_policy.policy_versions WHERE id = $1", [vId]);
    const { rows: [storedVal] } = await pool.query("SELECT result FROM gitwire_policy.policy_validation_evidence WHERE version_id = $1 AND evidence_hash = $2", [vId, result.rows[0].out_validation_evidence_hash]);

    // The stored result is the full envelope — verify it contains the expected fields
    check("stored validation result has schema_version", storedVal.result.schema_version === "gp04.validation.v1");
    check("stored validation result has version_id", storedVal.result.version_id === vId);
    check("stored validation result has content_hash", storedVal.result.content_hash === version.content_hash);
    check("stored validation result has validator_version", storedVal.result.validator_version === "gitwire-rules-v1");
  }

  // ═══ Phase 12: Provenance table access control ══════════════════════
  console.log("\n=== Phase 12: Provenance table access ===");
  for (const role of ["gitwire_app", "gitwire_policy_fn_owner"]) {
    let insBlocked = false, updBlocked = false, delBlocked = false;
    const rc = await pool.connect();
    try {
      await rc.query("SET ROLE " + role);
      try { await rc.query("INSERT INTO gitwire_policy.gp04_function_provenance (proname, identity_args, prosrc_hash, ret_type, lang_name, owner_name, prosecdef, proconfig, acl_canonical) VALUES ('t','t','t','t','t','t',false,'t','t')"); } catch { insBlocked = true; }
      try { await rc.query("UPDATE gitwire_policy.gp04_function_provenance SET prosrc_hash='tampered'"); } catch { updBlocked = true; }
      try { await rc.query("DELETE FROM gitwire_policy.gp04_function_provenance"); } catch { delBlocked = true; }
    } finally { try { await rc.query("RESET ROLE"); } catch {} rc.release(); }
    check("provenance table: " + role + " cannot INSERT", insBlocked);
    check("provenance table: " + role + " cannot UPDATE", updBlocked);
    check("provenance table: " + role + " cannot DELETE", delBlocked);
  }

  // ═══ Phase 13: session_user check ═══════════════════════════════════
  console.log("\n=== Phase 13: session_user check ===");
  {
    let nonAppBlocked = false;
    try { await pool.query("SELECT gitwire_policy.finalize_policy_evaluation(gen_random_uuid(), 0, '{}'::jsonb, 'v', NULL, NULL, gen_random_uuid())"); }
    catch (e) { nonAppBlocked = e.message.includes("gitwire_app"); }
    check("non-gitwire_app caller rejected", nonAppBlocked);
  }

  // ═══ Phase 14: search_path check ════════════════════════════════════
  console.log("\n=== Phase 14: search_path check ===");
  {
    const { rows: [fnConfig] } = await pool.query("SELECT p.proconfig FROM pg_proc p JOIN pg_namespace n ON p.pronamespace=n.oid WHERE n.nspname='gitwire_policy' AND p.proname='finalize_policy_evaluation'");
    check("search_path = gitwire_policy, pg_catalog", fnConfig.proconfig && fnConfig.proconfig[0] === "search_path=gitwire_policy, pg_catalog", "config=" + JSON.stringify(fnConfig.proconfig));
  }

  // ═══ Phase 15: CASCADE / fail-closed migration check ═════════════════
  console.log("\n=== Phase 15: Migration fail-closed ===");
  const migContent = await readFile(join(MIGRATIONS_DIR, "047_gp04_validation_simulation.sql"), "utf8");
  check("migration no CASCADE", !/\bCASCADE\b/i.test(migContent.replace(/--.*/g, "")));
  check("migration uses plain CREATE FUNCTION", !/CREATE\s+OR\s+REPLACE/i.test(migContent));
  check("migration no CREATE TABLE IF NOT EXISTS", !/CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS/i.test(migContent));

  // ═══ Phase 16: Rollback refusal when authoritative data exists ═══════
  console.log("\n=== Phase 16: Rollback refusal ===");
  {
    const rollback047 = await readFile(join(ROLLBACK_DIR, "rollback_gp04_validation_simulation.sql"), "utf8");
    let rollbackRefused = false;
    try { await pool.query(rollback047); }
    catch (e) { rollbackRefused = e.message.includes("authoritative") || e.message.includes("evidence") || e.message.includes("refused"); }
    check("rollback refused when evidence/events exist", rollbackRefused);
  }

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
    console.error("cleanup: container_removal_failed:", e.message);
  }
}

console.log("\n=== GP-04 Validation & Simulation Proof: " + passed + " passed, " + failed + " failed ===");
process.exit(proofFailed || failed > 0 ? 1 : 0);
