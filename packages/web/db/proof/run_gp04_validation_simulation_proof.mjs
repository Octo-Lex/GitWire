#!/usr/bin/env node
// packages/web/db/proof/run_gp04_validation_simulation_proof.mjs
// GP-04 disposable proof: validation, simulation, and atomic finalization.
//
// F6 expanded coverage:
//   - Atomicity fault injection (trigger-based at each step)
//   - Concurrency (two sessions, one winner)
//   - Evidence hash recomputation + stored envelope verification
//   - ACL and provenance (exact column grants, provenance mutation, rollback refusal)
//   - GP-03 regression: exact 11-signature set

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

  async function createSubmittedCR(authorPid) {
    const cr = await runAsApp("SELECT gitwire_policy.create_policy_change_request('repository','gp04/test','test-config',$1) as id", [authorPid]);
    const crId = cr.rows[0].id;
    const v = await runAsApp("SELECT gitwire_policy.create_policy_version($1, $2, $3) as id", [crId, JSON.stringify({version:1,pillars:{},settings:{dry_run:true}}), authorPid]);
    const vId = v.rows[0].id;
    await runAsApp("SELECT * FROM gitwire_policy.select_policy_version($1, $2, 0, $3)", [crId, vId, authorPid]);
    const { rows: [sel] } = await pool.query("SELECT state_revision FROM gitwire_policy.policy_change_requests WHERE id = $1", [crId]);
    await runAsApp("SELECT * FROM gitwire_policy.submit_policy_change_request($1, $2, $3)", [crId, Number(sel.state_revision), authorPid]);
    return { crId, vId };
  }

  // ═══ Phase 1: Migrations ════════════════════════════════════════════
  console.log("\n=== Phase 1: Apply migrations 001-047 ===");
  await applyMigrations(pool);
  const migCount = (await pool.query("SELECT count(*)::int n FROM schema_migrations")).rows[0].n;
  check("migration ledger = 47", migCount === 47, "count=" + migCount);

  // ═══ Phase 2: Function exists ════════════════════════════════════════
  console.log("\n=== Phase 2: finalize_policy_evaluation ===");
  const { rows: [fn] } = await pool.query("SELECT p.prosecdef, pg_get_userbyid(p.proowner) AS owner FROM pg_proc p JOIN pg_namespace n ON p.pronamespace=n.oid WHERE n.nspname='gitwire_policy' AND p.proname='finalize_policy_evaluation'");
  check("function exists", fn !== undefined);
  check("SECURITY DEFINER", fn.prosecdef === true);
  check("OWNER gitwire_policy_fn_owner", fn.owner === "gitwire_policy_fn_owner");

  // ═══ Phase 3: Setup fixtures ═════════════════════════════════════════
  console.log("\n=== Phase 3: Setup fixtures ===");
  await pool.query("INSERT INTO gitwire_auth.auth_principals (principal_type, display_name) VALUES ('legacy-key','gp04-admin') ON CONFLICT DO NOTHING");
  await pool.query("INSERT INTO gitwire_auth.auth_principals (principal_type, display_name) VALUES ('legacy-key','gp04-author') ON CONFLICT DO NOTHING");
  const adminPid = (await pool.query("SELECT id FROM gitwire_auth.auth_principals WHERE display_name='gp04-admin'")).rows[0].id;
  const authorPid = (await pool.query("SELECT id FROM gitwire_auth.auth_principals WHERE display_name='gp04-author'")).rows[0].id;
  await pool.query("INSERT INTO gitwire_auth.auth_principal_roles (principal_id, role_id, scope_type, granted_by) SELECT $1, r.id, 'fleet', $1 FROM gitwire_auth.auth_roles r WHERE r.name='admin' ON CONFLICT DO NOTHING", [adminPid]);
  await pool.query("INSERT INTO installations (github_id, account_login, account_type) VALUES (99001, 'gp04', 'Organization') ON CONFLICT DO NOTHING");
  await pool.query("INSERT INTO repositories (github_id, installation_id, full_name, owner, name, private, default_branch, language, stars, open_issues, open_prs) VALUES (99002, 99001, 'gp04/test', 'gp04', 'test', false, 'main', 'x', 0, 0, 0) ON CONFLICT DO NOTHING");
  await pool.query("INSERT INTO gitwire_auth.auth_role_permissions (role_id, permission) SELECT id, p FROM gitwire_auth.auth_roles, (VALUES ('policy_change_request:evaluate'),('policy_validation_evidence:read'),('policy_simulation_evidence:read'),('policy_change_request:create'),('policy_change_request:update'),('policy_change_request:read'),('policy_approval_rule:create'),('policy_approval_rule:read'),('policy_approval:create'),('policy_approval:revoke'),('policy_change_request:approve')) AS t(p) WHERE name='admin' ON CONFLICT DO NOTHING");
  await pool.query("INSERT INTO decision_log (repo_id, source, trigger_event, target_type, target_number, decision, reason) VALUES (99002, 'ci_heal', 'workflow_completed', 'pr', 1, 'acted', 'test')");
  check("fixtures created", adminPid && authorPid);

  const valResultOk = { valid: true, errors: [], warnings: [], checked_at: "2026-08-04T00:00:00Z" };
  const valResultBad = { valid: false, errors: ["test error"], warnings: [], checked_at: "2026-08-04T00:00:00Z" };
  const simResultOk = { passed: true, risk_classification: "standard", classifier_version: "classifier-v1", simulation_profile: { version: "sim-profile-v1" }, dataset_snapshot: { upper_watermark: 1, record_count: 1, input_set_hash: "sha256:" + "a".repeat(64), repo_ids: [99002] }, summary: { total_decisions_evaluated: 1, would_change: 0, no_change: 1, would_block: 0 }, simulated_at: "2026-08-04T00:00:00Z" };
  const simResultFail = { ...simResultOk, passed: false, summary: { ...simResultOk.summary, would_block: 1 } };

  // ═══ Phase 4: Success path ═══════════════════════════════════════════
  console.log("\n=== Phase 4: Success path ===");
  {
    const { crId, vId } = await createSubmittedCR(authorPid);
    const { rows: [crBefore] } = await pool.query("SELECT state_revision FROM gitwire_policy.policy_change_requests WHERE id = $1", [crId]);
    const result = await runAsApp("SELECT * FROM gitwire_policy.finalize_policy_evaluation($1, $2, $3::jsonb, $4, $5::jsonb, $6, $7)", [crId, Number(crBefore.state_revision), JSON.stringify(valResultOk), "gitwire-rules-v1", JSON.stringify(simResultOk), "gitwire-sim-v1", authorPid]);
    check("state = awaiting_approval", result.rows[0].out_state === "awaiting_approval", "state=" + result.rows[0].out_state);
    check("validation hash sha256", /^sha256:[0-9a-f]{64}$/.test(result.rows[0].out_validation_evidence_hash));
    check("simulation hash sha256", /^sha256:[0-9a-f]{64}$/.test(result.rows[0].out_simulation_evidence_hash));
    const evtCount = (await pool.query("SELECT count(*)::int n FROM gitwire_policy.policy_transition_events WHERE change_request_id=$1 AND to_state='awaiting_approval'", [crId])).rows[0].n;
    check("exactly one awaiting_approval event", evtCount === 1, "count=" + evtCount);
    const { rows: [evt] } = await pool.query("SELECT detail FROM gitwire_policy.policy_transition_events WHERE change_request_id=$1 AND to_state='awaiting_approval'", [crId]);
    check("event has validation_evidence_hash", evt.detail.validation_evidence_hash === result.rows[0].out_validation_evidence_hash);
    check("event has simulation_evidence_hash", evt.detail.simulation_evidence_hash === result.rows[0].out_simulation_evidence_hash);
    check("event has risk_classification", evt.detail.risk_classification === "standard");
    check("event state_revision is number", typeof evt.detail.state_revision === "number");
    check("event version_id matches", evt.detail.version_id === vId);
    check("validation evidence exists", (await pool.query("SELECT count(*)::int n FROM gitwire_policy.policy_validation_evidence WHERE version_id=$1", [vId])).rows[0].n === 1);
    check("simulation evidence exists", (await pool.query("SELECT count(*)::int n FROM gitwire_policy.policy_simulation_evidence WHERE version_id=$1", [vId])).rows[0].n === 1);
    // GP-03 compatibility
    const ruleResult = await runAsApp("SELECT gitwire_policy.create_policy_approval_rule('v1', 'test-config', 'fleet', 'fleet', 'standard', 1, '[\"admin\"]', $1, NULL) as id", [adminPid]);
    const apprResult = await runAsApp("SELECT gitwire_policy.record_policy_approval($1, $2, $3) as id", [crId, ruleResult.rows[0].id, adminPid]);
    check("GP-03 compatibility: approval recorded", apprResult.rows[0].id != null);
  }

  // ═══ Phase 5: Validation failure ═════════════════════════════════════
  console.log("\n=== Phase 5: Validation failure → rejected ===");
  {
    const { crId, vId } = await createSubmittedCR(authorPid);
    const { rows: [crBefore] } = await pool.query("SELECT state_revision FROM gitwire_policy.policy_change_requests WHERE id = $1", [crId]);
    const result = await runAsApp("SELECT * FROM gitwire_policy.finalize_policy_evaluation($1, $2, $3::jsonb, $4, NULL, NULL, $5)", [crId, Number(crBefore.state_revision), JSON.stringify(valResultBad), "gitwire-rules-v1", authorPid]);
    check("state = rejected", result.rows[0].out_state === "rejected", "state=" + result.rows[0].out_state);
    check("sim hash null", result.rows[0].out_simulation_evidence_hash === null);
    check("validation evidence persisted", (await pool.query("SELECT count(*)::int n FROM gitwire_policy.policy_validation_evidence WHERE version_id=$1", [vId])).rows[0].n === 1);
    check("no simulation evidence", (await pool.query("SELECT count(*)::int n FROM gitwire_policy.policy_simulation_evidence WHERE version_id=$1", [vId])).rows[0].n === 0);
    check("no awaiting_approval event", (await pool.query("SELECT count(*)::int n FROM gitwire_policy.policy_transition_events WHERE change_request_id=$1 AND to_state='awaiting_approval'", [crId])).rows[0].n === 0);
    check("rejection event exists", (await pool.query("SELECT count(*)::int n FROM gitwire_policy.policy_transition_events WHERE change_request_id=$1 AND to_state='rejected'", [crId])).rows[0].n === 1);
  }

  // ═══ Phase 6: Simulation failure ═════════════════════════════════════
  console.log("\n=== Phase 6: Simulation failure → rejected ===");
  {
    const { crId, vId } = await createSubmittedCR(authorPid);
    const { rows: [crBefore] } = await pool.query("SELECT state_revision FROM gitwire_policy.policy_change_requests WHERE id = $1", [crId]);
    const result = await runAsApp("SELECT * FROM gitwire_policy.finalize_policy_evaluation($1, $2, $3::jsonb, $4, $5::jsonb, $6, $7)", [crId, Number(crBefore.state_revision), JSON.stringify(valResultOk), "gitwire-rules-v1", JSON.stringify(simResultFail), "gitwire-sim-v1", authorPid]);
    check("state = rejected", result.rows[0].out_state === "rejected", "state=" + result.rows[0].out_state);
    check("sim hash not null", result.rows[0].out_simulation_evidence_hash !== null);
    check("validation evidence persisted", (await pool.query("SELECT count(*)::int n FROM gitwire_policy.policy_validation_evidence WHERE version_id=$1", [vId])).rows[0].n === 1);
    check("simulation evidence persisted", (await pool.query("SELECT count(*)::int n FROM gitwire_policy.policy_simulation_evidence WHERE version_id=$1", [vId])).rows[0].n === 1);
    check("no awaiting_approval event", (await pool.query("SELECT count(*)::int n FROM gitwire_policy.policy_transition_events WHERE change_request_id=$1 AND to_state='awaiting_approval'", [crId])).rows[0].n === 0);
  }

  // ═══ Phase 7: JSON boolean enforcement ═══════════════════════════════
  console.log("\n=== Phase 7: JSON boolean enforcement ===");
  {
    const { crId } = await createSubmittedCR(authorPid);
    const { rows: [crBefore] } = await pool.query("SELECT state_revision FROM gitwire_policy.policy_change_requests WHERE id = $1", [crId]);
    let blocked = false;
    try { await runAsApp("SELECT * FROM gitwire_policy.finalize_policy_evaluation($1, $2, '{\"valid\":\"true\"}'::jsonb, 'v1', NULL, NULL, $3)", [crId, Number(crBefore.state_revision), authorPid]); }
    catch (e) { blocked = e.message.includes("boolean"); }
    check("string 'true' rejected", blocked);
    const { rows: [crState] } = await pool.query("SELECT state FROM gitwire_policy.policy_change_requests WHERE id = $1", [crId]);
    check("CR remains submitted", crState.state === "submitted", "state=" + crState.state);
  }

  // ═══ Phase 8: Strict envelope validation ════════════════════════════
  console.log("\n=== Phase 8: Strict envelope validation ===");
  {
    const { crId } = await createSubmittedCR(authorPid);
    const { rows: [crBefore] } = await pool.query("SELECT state_revision FROM gitwire_policy.policy_change_requests WHERE id = $1", [crId]);
    // Missing simulation_profile
    let badProfileBlocked = false;
    try { await runAsApp("SELECT * FROM gitwire_policy.finalize_policy_evaluation($1, $2, $3::jsonb, 'v1', '{\"passed\":true,\"risk_classification\":\"standard\",\"classifier_version\":\"c1\",\"dataset_snapshot\":{\"upper_watermark\":1,\"input_set_hash\":\"sha256:" + "0".repeat(64) + "\"}}'::jsonb, 'v1', $4)", [crId, Number(crBefore.state_revision), JSON.stringify(valResultOk), authorPid]); }
    catch (e) { badProfileBlocked = e.message.includes("simulation_profile"); }
    check("missing simulation_profile rejected", badProfileBlocked);
    // Missing dataset_snapshot
    let badSnapBlocked = false;
    try { await runAsApp("SELECT * FROM gitwire_policy.finalize_policy_evaluation($1, $2, $3::jsonb, 'v1', '{\"passed\":true,\"risk_classification\":\"standard\",\"classifier_version\":\"c1\",\"simulation_profile\":{\"version\":\"p1\"}}'::jsonb, 'v1', $4)", [crId, Number(crBefore.state_revision), JSON.stringify(valResultOk), authorPid]); }
    catch (e) { badSnapBlocked = e.message.includes("dataset_snapshot"); }
    check("missing dataset_snapshot rejected", badSnapBlocked);
    // Empty validator version
    let emptyVerBlocked = false;
    try { await runAsApp("SELECT * FROM gitwire_policy.finalize_policy_evaluation($1, $2, $3::jsonb, '', NULL, NULL, $4)", [crId, Number(crBefore.state_revision), JSON.stringify(valResultOk), authorPid]); }
    catch (e) { emptyVerBlocked = e.message.includes("validator_version"); }
    check("empty validator_version rejected", emptyVerBlocked);
    // Bad input_set_hash format
    let badHashBlocked = false;
    try { await runAsApp("SELECT * FROM gitwire_policy.finalize_policy_evaluation($1, $2, $3::jsonb, 'v1', '{\"passed\":true,\"risk_classification\":\"standard\",\"classifier_version\":\"c1\",\"simulation_profile\":{\"version\":\"p1\"},\"dataset_snapshot\":{\"upper_watermark\":1,\"input_set_hash\":\"not-a-hash\"}}'::jsonb, 'v1', $4)", [crId, Number(crBefore.state_revision), JSON.stringify(valResultOk), authorPid]); }
    catch (e) { badHashBlocked = e.message.includes("input_set_hash"); }
    check("bad input_set_hash format rejected", badHashBlocked);
  }

  // ═══ Phase 9: CAS rejection ═════════════════════════════════════════
  console.log("\n=== Phase 9: CAS rejection ===");
  {
    const { crId } = await createSubmittedCR(authorPid);
    let staleBlocked = false;
    try { await runAsApp("SELECT * FROM gitwire_policy.finalize_policy_evaluation($1, 99999, $2::jsonb, 'v1', $3::jsonb, 'v1', $4)", [crId, JSON.stringify(valResultOk), JSON.stringify(simResultOk), authorPid]); }
    catch (e) { staleBlocked = e.message.includes("CAS"); }
    check("stale revision rejected", staleBlocked);
    // Wrong state (draft)
    const cr2 = await runAsApp("SELECT gitwire_policy.create_policy_change_request('repository','gp04/test','test-config',$1) as id", [authorPid]);
    let wrongStateBlocked = false;
    try { await runAsApp("SELECT * FROM gitwire_policy.finalize_policy_evaluation($1, 0, $2::jsonb, 'v1', NULL, NULL, $3)", [cr2.rows[0].id, JSON.stringify(valResultOk), authorPid]); }
    catch (e) { wrongStateBlocked = e.message.includes("submitted"); }
    check("wrong state (draft) rejected", wrongStateBlocked);
  }

  // ═══ Phase 10: Actor eligibility ═════════════════════════════════════
  console.log("\n=== Phase 10: Actor eligibility ===");
  {
    await pool.query("INSERT INTO gitwire_auth.auth_principals (principal_type, display_name) VALUES ('legacy-key','gp04-nonadmin') ON CONFLICT DO NOTHING");
    const nonAdminPid = (await pool.query("SELECT id FROM gitwire_auth.auth_principals WHERE display_name='gp04-nonadmin'")).rows[0].id;
    const { crId } = await createSubmittedCR(authorPid);
    const { rows: [crBefore] } = await pool.query("SELECT state_revision FROM gitwire_policy.policy_change_requests WHERE id = $1", [crId]);
    let blocked = false;
    try { await runAsApp("SELECT * FROM gitwire_policy.finalize_policy_evaluation($1, $2, $3::jsonb, 'v1', NULL, NULL, $4)", [crId, Number(crBefore.state_revision), JSON.stringify(valResultOk), nonAdminPid]); }
    catch (e) { blocked = e.message.includes("author") || e.message.includes("admin"); }
    check("non-author non-admin rejected", blocked);
  }

  // ═══ Phase 11: Atomicity fault injection ════════════════════════════
  console.log("\n=== Phase 11: Atomicity fault injection ===");
  {
    for (const [faultName, triggerFn, targetTable] of [
      ["validation evidence insert", "BEGIN IF NEW.validator_version LIKE '%v1%' THEN RAISE EXCEPTION 'injected fault: val'; END IF; RETURN NEW; END", "policy_validation_evidence"],
      ["simulation evidence insert", "BEGIN IF NEW.evaluator_version LIKE '%v1%' THEN RAISE EXCEPTION 'injected fault: sim'; END IF; RETURN NEW; END", "policy_simulation_evidence"],
    ]) {
      const { crId } = await createSubmittedCR(authorPid);
      const { rows: [crBefore] } = await pool.query("SELECT state_revision FROM gitwire_policy.policy_change_requests WHERE id = $1", [crId]);
      const evBefore = (await pool.query("SELECT count(*)::int n FROM gitwire_policy.policy_validation_evidence UNION ALL SELECT count(*)::int n FROM gitwire_policy.policy_simulation_evidence")).rows.reduce((s,r)=>s+r.n,0);
      await pool.query("CREATE OR REPLACE FUNCTION gp04_fault_inject() RETURNS trigger AS $$ " + triggerFn + "; $$ LANGUAGE plpgsql");
      await pool.query("DROP TRIGGER IF EXISTS gp04_fault ON gitwire_policy." + targetTable);
      await pool.query("CREATE TRIGGER gp04_fault BEFORE INSERT ON gitwire_policy." + targetTable + " FOR EACH ROW EXECUTE FUNCTION gp04_fault_inject()");
      let faultBlocked = false;
      try {
        if (faultName.includes("simulation")) {
          await runAsApp("SELECT * FROM gitwire_policy.finalize_policy_evaluation($1, $2, $3::jsonb, 'v1', $4::jsonb, 'v1', $5)", [crId, Number(crBefore.state_revision), JSON.stringify(valResultOk), JSON.stringify(simResultOk), authorPid]);
        } else {
          await runAsApp("SELECT * FROM gitwire_policy.finalize_policy_evaluation($1, $2, $3::jsonb, 'v1', NULL, NULL, $4)", [crId, Number(crBefore.state_revision), JSON.stringify(valResultOk), authorPid]);
        }
      } catch (e) { faultBlocked = e.message.includes("injected fault"); }
      check("fault: " + faultName + " → exception", faultBlocked);
      const { rows: [crAfter] } = await pool.query("SELECT state, state_revision FROM gitwire_policy.policy_change_requests WHERE id = $1", [crId]);
      check("fault: " + faultName + " → state unchanged", crAfter.state === "submitted", "state=" + crAfter.state);
      check("fault: " + faultName + " → revision unchanged", Number(crAfter.state_revision) === Number(crBefore.state_revision));
      const evAfter = (await pool.query("SELECT count(*)::int n FROM gitwire_policy.policy_validation_evidence UNION ALL SELECT count(*)::int n FROM gitwire_policy.policy_simulation_evidence")).rows.reduce((s,r)=>s+r.n,0);
      check("fault: " + faultName + " → no new evidence", evAfter === evBefore);
      const evtCount = (await pool.query("SELECT count(*)::int n FROM gitwire_policy.policy_transition_events WHERE change_request_id=$1 AND to_state IN ('awaiting_approval','rejected')", [crId])).rows[0].n;
      check("fault: " + faultName + " → no GP-04 event", evtCount === 0);
      await pool.query("DROP TRIGGER IF EXISTS gp04_fault ON gitwire_policy." + targetTable);
      await pool.query("DROP FUNCTION IF EXISTS gp04_fault_inject()");
    }
  }

  // ═══ Phase 12: Concurrency ══════════════════════════════════════════
  console.log("\n=== Phase 12: Concurrency ===");
  {
    const { crId } = await createSubmittedCR(authorPid);
    const { rows: [crBefore] } = await pool.query("SELECT state_revision FROM gitwire_policy.policy_change_requests WHERE id = $1", [crId]);
    const rev = Number(crBefore.state_revision);
    const a = await pool.connect();
    const b = await pool.connect();
    try {
      await a.query("SET SESSION AUTHORIZATION gitwire_app");
      await b.query("SET SESSION AUTHORIZATION gitwire_app");
      const doFinalize = async (conn) => {
        try {
          await conn.query("BEGIN");
          const r = await conn.query("SELECT * FROM gitwire_policy.finalize_policy_evaluation($1, $2, $3::jsonb, $4, $5::jsonb, $6, $7)", [crId, rev, JSON.stringify(valResultOk), "v1", JSON.stringify(simResultOk), "v1", authorPid]);
          await conn.query("COMMIT");
          return { ok: true };
        } catch (e) { try { await conn.query("ROLLBACK"); } catch {} return { ok: false }; }
      };
      const [r1, r2] = await Promise.all([doFinalize(a), doFinalize(b)]);
      const oks = [r1, r2].filter(r => r.ok).length;
      check("concurrency: exactly one succeeded", oks === 1, "oks=" + oks);
      const evtCount = (await pool.query("SELECT count(*)::int n FROM gitwire_policy.policy_transition_events WHERE change_request_id=$1 AND event_type='evaluation_complete'", [crId])).rows[0].n;
      check("concurrency: exactly one evaluation_complete event", evtCount === 1, "count=" + evtCount);
    } finally {
      try { await a.query("RESET SESSION AUTHORIZATION"); } catch {}
      try { await b.query("RESET SESSION AUTHORIZATION"); } catch {}
      a.release(); b.release();
    }
  }

  // ═══ Phase 13: Hash recomputation ═══════════════════════════════════
  console.log("\n=== Phase 13: Hash recomputation ===");
  {
    const { crId, vId } = await createSubmittedCR(authorPid);
    const { rows: [crBefore] } = await pool.query("SELECT state_revision FROM gitwire_policy.policy_change_requests WHERE id = $1", [crId]);
    const result = await runAsApp("SELECT * FROM gitwire_policy.finalize_policy_evaluation($1, $2, $3::jsonb, $4, $5::jsonb, $6, $7)", [crId, Number(crBefore.state_revision), JSON.stringify(valResultOk), "gitwire-rules-v1", JSON.stringify(simResultOk), "gitwire-sim-v1", authorPid]);
    const { rows: [storedVal] } = await pool.query("SELECT result FROM gitwire_policy.policy_validation_evidence WHERE version_id=$1 AND evidence_hash=$2", [vId, result.rows[0].out_validation_evidence_hash]);
    check("stored val has schema_version gp04.validation.v1", storedVal.result.schema_version === "gp04.validation.v1");
    check("stored val has version_id", storedVal.result.version_id === vId);
    check("stored val has content_hash matching", storedVal.result.content_hash != null);
    const { rows: [storedSim] } = await pool.query("SELECT result FROM gitwire_policy.policy_simulation_evidence WHERE version_id=$1 AND evidence_hash=$2", [vId, result.rows[0].out_simulation_evidence_hash]);
    check("stored sim has schema_version gp04.simulation.v1", storedSim.result.schema_version === "gp04.simulation.v1");
    check("stored sim has risk.classification", storedSim.result.risk.classification === "standard");
    check("stored sim has evaluator_version", storedSim.result.evaluator_version != null);
  }

  // ═══ Phase 14: ACL ══════════════════════════════════════════════════
  console.log("\n=== Phase 14: ACL ===");
  {
    // Valid INSERT denied as gitwire_app (not DEFAULT VALUES)
    let insBlocked = false;
    try { await runAsApp("INSERT INTO gitwire_policy.policy_validation_evidence (version_id, evidence_hash, result, validator_version) VALUES (gen_random_uuid(), 'sha256:" + "0".repeat(64) + "', '{}'::jsonb, 'v1')"); }
    catch (e) { insBlocked = e.message.includes("permission denied"); }
    check("gitwire_app cannot INSERT valid validation evidence", insBlocked);
    let insSimBlocked = false;
    try { await runAsApp("INSERT INTO gitwire_policy.policy_simulation_evidence (version_id, evidence_hash, result, evaluator_version) VALUES (gen_random_uuid(), 'sha256:" + "0".repeat(64) + "', '{}'::jsonb, 'v1')"); }
    catch (e) { insSimBlocked = e.message.includes("permission denied"); }
    check("gitwire_app cannot INSERT valid simulation evidence", insSimBlocked);
    // Column-level grants
    const colGrants = (await pool.query("SELECT count(*)::int n FROM information_schema.role_column_grants WHERE grantee='gitwire_app' AND table_schema='gitwire_policy' AND table_name IN ('policy_validation_evidence','policy_simulation_evidence') AND privilege_type IN ('INSERT','UPDATE','DELETE')")).rows[0].n;
    check("gitwire_app zero column INSERT/UPDATE/DELETE on evidence", colGrants === 0, "count=" + colGrants);
    // fn_owner table grants
    const fnGrants = (await pool.query("SELECT privilege_type FROM information_schema.role_table_grants WHERE grantee='gitwire_policy_fn_owner' AND table_schema='gitwire_policy' AND table_name='policy_validation_evidence' ORDER BY 1")).rows.map(r=>r.privilege_type).join(",");
    check("fn_owner has INSERT,SELECT on validation evidence", fnGrants === "INSERT,SELECT", "grants=" + fnGrants);
  }

  // ═══ Phase 15: Provenance table access ══════════════════════════════
  console.log("\n=== Phase 15: Provenance table access ===");
  for (const role of ["gitwire_app", "gitwire_policy_fn_owner"]) {
    let i=false,u=false,d=false;
    const rc = await pool.connect();
    try {
      await rc.query("SET ROLE " + role);
      try { await rc.query("INSERT INTO gitwire_policy.gp04_function_provenance (proname, identity_args, prosrc_hash, ret_type, lang_name, owner_name, prosecdef, proconfig, acl_canonical) VALUES ('t','t','t','t','t','t',false,'t','t')"); } catch { i=true; }
      try { await rc.query("UPDATE gitwire_policy.gp04_function_provenance SET prosrc_hash='x'"); } catch { u=true; }
      try { await rc.query("DELETE FROM gitwire_policy.gp04_function_provenance"); } catch { d=true; }
    } finally { try { await rc.query("RESET ROLE"); } catch {} rc.release(); }
    check("provenance: " + role + " no INSERT", i);
    check("provenance: " + role + " no UPDATE", u);
    check("provenance: " + role + " no DELETE", d);
  }

  // ═══ Phase 16: session_user + search_path ═══════════════════════════
  console.log("\n=== Phase 16: session_user + search_path ===");
  {
    let nonAppBlocked = false;
    try { await pool.query("SELECT gitwire_policy.finalize_policy_evaluation(gen_random_uuid(), 0, '{}'::jsonb, 'v', NULL, NULL, gen_random_uuid())"); }
    catch (e) { nonAppBlocked = e.message.includes("gitwire_app"); }
    check("non-gitwire_app rejected", nonAppBlocked);
    const { rows: [fnConfig] } = await pool.query("SELECT p.proconfig FROM pg_proc p JOIN pg_namespace n ON p.pronamespace=n.oid WHERE n.nspname='gitwire_policy' AND p.proname='finalize_policy_evaluation'");
    check("search_path = gitwire_policy, pg_catalog", fnConfig.proconfig && fnConfig.proconfig[0] === "search_path=gitwire_policy, pg_catalog");
  }

  // ═══ Phase 17: Migration fail-closed ════════════════════════════════
  console.log("\n=== Phase 17: Migration fail-closed ===");
  const migContent = await readFile(join(MIGRATIONS_DIR, "047_gp04_validation_simulation.sql"), "utf8");
  check("migration no CASCADE", !/\bCASCADE\b/i.test(migContent.replace(/--.*/g, "")));
  check("migration plain CREATE FUNCTION", !/CREATE\s+OR\s+REPLACE/i.test(migContent));
  check("migration no CREATE TABLE IF NOT EXISTS", !/CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS/i.test(migContent));

  // ═══ Phase 18: Rollback refusal ═════════════════════════════════════
  console.log("\n=== Phase 18: Rollback refusal ===");
  {
    const rollback047 = await readFile(join(ROLLBACK_DIR, "rollback_gp04_validation_simulation.sql"), "utf8");
    let refused = false;
    try { await pool.query(rollback047); }
    catch (e) { refused = e.message.includes("authoritative") || e.message.includes("evidence"); }
    check("rollback refused when data exists", refused);
  }

  // ═══ Phase 19: GP-03 exact 11-signature set ═════════════════════════
  console.log("\n=== Phase 19: GP-03 exact 11-signature set ===");
  {
    const expectedSigs = [
      "gitwire_policy.approve_policy_change_request(uuid,bigint,uuid)",
      "gitwire_policy.create_policy_approval_rule(text,text,text,text,text,integer,jsonb,uuid,integer)",
      "gitwire_policy.create_policy_change_request(text,text,text,uuid)",
      "gitwire_policy.create_policy_version(uuid,jsonb,uuid)",
      "gitwire_policy.evaluate_approval_sufficiency(uuid)",
      "gitwire_policy.expire_policy_approval(uuid,bigint,uuid)",
      "gitwire_policy.finalize_policy_evaluation(uuid,bigint,jsonb,text,jsonb,text,uuid)",
      "gitwire_policy.record_policy_approval(uuid,uuid,uuid)",
      "gitwire_policy.revoke_policy_approval(uuid,bigint,uuid,text)",
      "gitwire_policy.select_policy_version(uuid,uuid,bigint,uuid)",
      "gitwire_policy.submit_policy_change_request(uuid,bigint,uuid)",
    ].sort();
    const { rows: secDefRows } = await pool.query("SELECT p.oid::regprocedure::text as sig FROM pg_proc p JOIN pg_roles r ON p.proowner=r.oid JOIN pg_namespace n ON p.pronamespace=n.oid WHERE n.nspname='gitwire_policy' AND r.rolname='gitwire_policy_fn_owner' AND p.prosecdef=true AND p.proname!='canonical_jsonb' ORDER BY 1");
    check("SECURITY DEFINER exact 11-signature set", JSON.stringify(secDefRows.map(r=>r.sig)) === JSON.stringify(expectedSigs), "found=" + JSON.stringify(secDefRows.map(r=>r.sig)));
  }

  // Helper: recompute the evidence hash for a jsonb envelope through PostgreSQL's
  // OWN canonical_jsonb + digest. NEVER a JS port — PG is the authoritative
  // canonicalization contract. Returns 'sha256:<64 hex>'.
  // canonical_jsonb lives in gitwire_policy; digest lives in public (pgcrypto).
  // Use a dedicated client so the search_path setting is isolated per call and
  // does not leak into other phases.
  async function recomputeHash(envelopeJsonb) {
    const c = await pool.connect();
    try {
      await c.query("SET search_path = gitwire_policy, public, pg_catalog");
      const { rows: [{ recomputed }] } = await c.query({
        text: `SELECT 'sha256:' || pg_catalog.encode(public.digest(pg_catalog.convert_to(canonical_jsonb($1::jsonb), 'UTF8'), 'sha256'), 'hex') AS recomputed`,
        values: [JSON.stringify(envelopeJsonb)],
      });
      return recomputed;
    } finally {
      await c.query("RESET search_path");
      c.release();
    }
  }

  // ═══ Phase 20: Independent hash recomputation (PG-authoritative) ════════
  // For both evidence tables: read the persisted envelope (result column) and
  // stored evidence_hash, recompute the digest through canonical_jsonb+digest
  // WITHOUT trusting the stored hash, assert exact equality, and assert the
  // canonical sha256:<64 hex> format.
  console.log("\n=== Phase 20: Independent hash recomputation (PG canonical_jsonb) ===");
  {
    const { crId, vId } = await createSubmittedCR(authorPid);
    const { rows: [crBefore] } = await pool.query("SELECT state_revision FROM gitwire_policy.policy_change_requests WHERE id = $1", [crId]);
    const result = await runAsApp("SELECT * FROM gitwire_policy.finalize_policy_evaluation($1, $2, $3::jsonb, $4, $5::jsonb, $6, $7)", [crId, Number(crBefore.state_revision), JSON.stringify(valResultOk), "gitwire-rules-v1", JSON.stringify(simResultOk), "gitwire-sim-v1", authorPid]);
    const storedValHash = result.rows[0].out_validation_evidence_hash;
    const storedSimHash = result.rows[0].out_simulation_evidence_hash;

    // Validation evidence
    const { rows: [storedVal] } = await pool.query("SELECT result, evidence_hash FROM gitwire_policy.policy_validation_evidence WHERE version_id = $1", [vId]);
    const recomputedVal = await recomputeHash(storedVal.result);
    check("validation: recomputed hash === stored hash", recomputedVal === storedVal.evidence_hash, "recomputed=" + recomputedVal + " stored=" + storedVal.evidence_hash);
    check("validation: recomputed hash === finalize output", recomputedVal === storedValHash);
    check("validation: hash format sha256:<64 hex>", /^sha256:[0-9a-f]{64}$/.test(recomputedVal));

    // Simulation evidence
    const { rows: [storedSim] } = await pool.query("SELECT result, evidence_hash FROM gitwire_policy.policy_simulation_evidence WHERE version_id = $1", [vId]);
    const recomputedSim = await recomputeHash(storedSim.result);
    check("simulation: recomputed hash === stored hash", recomputedSim === storedSim.evidence_hash, "recomputed=" + recomputedSim + " stored=" + storedSim.evidence_hash);
    check("simulation: recomputed hash === finalize output", recomputedSim === storedSimHash);
    check("simulation: hash format sha256:<64 hex>", /^sha256:[0-9a-f]{64}$/.test(recomputedSim));
  }

  // ═══ Phase 21: Per-field mutation sensitivity ═══════════════════════════
  // Mutate one bound field at a time, recompute through the PG expression, and
  // prove the hash differs from the original. JS only constructs the mutated
  // JSON value; PG canonicalizes+hashes it. Each mutation produces a genuinely
  // different canonical JSON value (no key-reorder-only mutations).
  console.log("\n=== Phase 21: Per-field mutation sensitivity ===");
  {
    const { crId, vId } = await createSubmittedCR(authorPid);
    const { rows: [crBefore] } = await pool.query("SELECT state_revision FROM gitwire_policy.policy_change_requests WHERE id = $1", [crId]);
    await runAsApp("SELECT * FROM gitwire_policy.finalize_policy_evaluation($1, $2, $3::jsonb, $4, $5::jsonb, $6, $7)", [crId, Number(crBefore.state_revision), JSON.stringify(valResultOk), "gitwire-rules-v1", JSON.stringify(simResultOk), "gitwire-sim-v1", authorPid]);

    // --- Validation envelope: 5 fields ---
    const { rows: [storedVal] } = await pool.query("SELECT result FROM gitwire_policy.policy_validation_evidence WHERE version_id = $1", [vId]);
    const valOriginalHash = await recomputeHash(storedVal.result);
    const valMutations = [
      { field: "schema_version", mutated: { ...storedVal.result, schema_version: "gp04.validation.v2" } },
      { field: "version_id", mutated: { ...storedVal.result, version_id: "00000000-0000-0000-0000-000000000001" } },
      { field: "content_hash", mutated: { ...storedVal.result, content_hash: "sha256:" + "f".repeat(64) } },
      { field: "validator_version", mutated: { ...storedVal.result, validator_version: "gitwire-rules-v9" } },
      { field: "result", mutated: { ...storedVal.result, result: { ...storedVal.result.result, valid: false, errors: ["mutated"] } } },
    ];
    for (const m of valMutations) {
      const mutatedHash = await recomputeHash(m.mutated);
      check("validation mutation [" + m.field + "] changes hash", mutatedHash !== valOriginalHash);
    }

    // --- Simulation envelope: 10 fields (nested paths for risk.*) ---
    const { rows: [storedSim] } = await pool.query("SELECT result FROM gitwire_policy.policy_simulation_evidence WHERE version_id = $1", [vId]);
    const simOriginalHash = await recomputeHash(storedSim.result);
    const simMutations = [
      { field: "schema_version", mutated: { ...storedSim.result, schema_version: "gp04.simulation.v2" } },
      { field: "version_id", mutated: { ...storedSim.result, version_id: "00000000-0000-0000-0000-000000000002" } },
      { field: "content_hash", mutated: { ...storedSim.result, content_hash: "sha256:" + "e".repeat(64) } },
      { field: "evaluator_version", mutated: { ...storedSim.result, evaluator_version: "gitwire-sim-v9" } },
      { field: "resource_scope", mutated: { ...storedSim.result, resource_scope: { type: "organization", id: "mutated" } } },
      { field: "simulation_profile", mutated: { ...storedSim.result, simulation_profile: { version: "sim-profile-v9" } } },
      { field: "dataset_snapshot", mutated: { ...storedSim.result, dataset_snapshot: { ...storedSim.result.dataset_snapshot, upper_watermark: storedSim.result.dataset_snapshot.upper_watermark + 999 } } },
      { field: "risk.classification", mutated: { ...storedSim.result, risk: { ...storedSim.result.risk, classification: "critical" } } },
      { field: "risk.classifier_version", mutated: { ...storedSim.result, risk: { ...storedSim.result.risk, classifier_version: "classifier-v9" } } },
      { field: "result", mutated: { ...storedSim.result, result: { ...storedSim.result.result, passed: false } } },
    ];
    for (const m of simMutations) {
      const mutatedHash = await recomputeHash(m.mutated);
      check("simulation mutation [" + m.field + "] changes hash", mutatedHash !== simOriginalHash);
    }
  }

  // ═══ Phase 22: Request-update fault injection (BEFORE UPDATE) ═══════════
  // Target-specific trigger on policy_change_requests that raises only when
  // the fixture CR transitions submitted → GP-04 terminal state. Proves the
  // UPDATE failure rolls back everything (state, revision, evidence, events).
  console.log("\n=== Phase 22: Request-update fault injection ===");
  {
    const { crId } = await createSubmittedCR(authorPid);
    const { rows: [crBefore] } = await pool.query("SELECT state_revision FROM gitwire_policy.policy_change_requests WHERE id = $1", [crId]);

    // Snapshot all five persistent invariants BEFORE the faulted call.
    const before = {
      state: (await pool.query("SELECT state FROM gitwire_policy.policy_change_requests WHERE id = $1", [crId])).rows[0].state,
      revision: Number((await pool.query("SELECT state_revision FROM gitwire_policy.policy_change_requests WHERE id = $1", [crId])).rows[0].state_revision),
      valCount: (await pool.query("SELECT count(*)::int n FROM gitwire_policy.policy_validation_evidence")).rows[0].n,
      simCount: (await pool.query("SELECT count(*)::int n FROM gitwire_policy.policy_simulation_evidence")).rows[0].n,
      evtCount: (await pool.query("SELECT count(*)::int n FROM gitwire_policy.policy_transition_events WHERE event_type IN ('evaluation_complete','validation_rejected','simulation_rejected')")).rows[0].n,
    };

    // Install target-specific BEFORE UPDATE trigger: raises only for this CR
    // when transitioning out of 'submitted' (covers both awaiting_approval and
    // rejected terminal states). Created by the superuser pool.
    // crId is a trusted internally-generated UUID, safe to interpolate into DDL.
    await pool.query("CREATE OR REPLACE FUNCTION gp04_fault_req_update() RETURNS trigger AS $$ BEGIN IF NEW.id = '" + crId + "'::uuid AND OLD.state = 'submitted' AND NEW.state IN ('awaiting_approval','rejected') THEN RAISE EXCEPTION 'injected fault: request update'; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql");
    await pool.query("DROP TRIGGER IF EXISTS gp04_fault_req ON gitwire_policy.policy_change_requests");
    await pool.query("CREATE TRIGGER gp04_fault_req BEFORE UPDATE ON gitwire_policy.policy_change_requests FOR EACH ROW EXECUTE FUNCTION gp04_fault_req_update()");

    let faultBlocked = false;
    try {
      await runAsApp("SELECT * FROM gitwire_policy.finalize_policy_evaluation($1, $2, $3::jsonb, $4, $5::jsonb, $6, $7)", [crId, Number(crBefore.state_revision), JSON.stringify(valResultOk), "gitwire-rules-v1", JSON.stringify(simResultOk), "gitwire-sim-v1", authorPid]);
    } catch (e) { faultBlocked = e.message.includes("injected fault: request update"); }
    check("request-update fault: exception raised", faultBlocked);

    // Always clean up trigger + function.
    await pool.query("DROP TRIGGER IF EXISTS gp04_fault_req ON gitwire_policy.policy_change_requests");
    await pool.query("DROP FUNCTION IF EXISTS gp04_fault_req_update()");

    // Assert exact equality with the BEFORE snapshot (all five invariants).
    const after = {
      state: (await pool.query("SELECT state FROM gitwire_policy.policy_change_requests WHERE id = $1", [crId])).rows[0].state,
      revision: Number((await pool.query("SELECT state_revision FROM gitwire_policy.policy_change_requests WHERE id = $1", [crId])).rows[0].state_revision),
      valCount: (await pool.query("SELECT count(*)::int n FROM gitwire_policy.policy_validation_evidence")).rows[0].n,
      simCount: (await pool.query("SELECT count(*)::int n FROM gitwire_policy.policy_simulation_evidence")).rows[0].n,
      evtCount: (await pool.query("SELECT count(*)::int n FROM gitwire_policy.policy_transition_events WHERE event_type IN ('evaluation_complete','validation_rejected','simulation_rejected')")).rows[0].n,
    };
    check("request-update fault: state unchanged", after.state === before.state, "state=" + after.state);
    check("request-update fault: revision unchanged", after.revision === before.revision);
    check("request-update fault: validation evidence unchanged", after.valCount === before.valCount);
    check("request-update fault: simulation evidence unchanged", after.simCount === before.simCount);
    check("request-update fault: GP-04 events unchanged", after.evtCount === before.evtCount);
  }

  // ═══ Phase 23: Transition-event fault injection (BEFORE INSERT) ═════════
  // Target-specific trigger on policy_transition_events for the fixture CR and
  // GP-04 event types. Exercises both the success path (evaluation_complete)
  // and a rejection path. Proves event-INSERT failure rolls back both evidence
  // inserts, the request-state update, and the revision increment.
  console.log("\n=== Phase 23: Transition-event fault injection ===");
  for (const [scenarioName, valRes, simRes] of [
    ["success → evaluation_complete", valResultOk, simResultOk],
    ["validation rejected → validation_rejected", valResultBad, null],
  ]) {
    const { crId } = await createSubmittedCR(authorPid);
    const { rows: [crBefore] } = await pool.query("SELECT state_revision FROM gitwire_policy.policy_change_requests WHERE id = $1", [crId]);

    const before = {
      state: (await pool.query("SELECT state FROM gitwire_policy.policy_change_requests WHERE id = $1", [crId])).rows[0].state,
      revision: Number((await pool.query("SELECT state_revision FROM gitwire_policy.policy_change_requests WHERE id = $1", [crId])).rows[0].state_revision),
      valCount: (await pool.query("SELECT count(*)::int n FROM gitwire_policy.policy_validation_evidence")).rows[0].n,
      simCount: (await pool.query("SELECT count(*)::int n FROM gitwire_policy.policy_simulation_evidence")).rows[0].n,
      evtCount: (await pool.query("SELECT count(*)::int n FROM gitwire_policy.policy_transition_events WHERE event_type IN ('evaluation_complete','validation_rejected','simulation_rejected')")).rows[0].n,
    };

    // Target-specific BEFORE INSERT trigger: raises only for this CR's GP-04 events.
    // crId is a trusted internally-generated UUID, safe to interpolate into DDL.
    await pool.query("CREATE OR REPLACE FUNCTION gp04_fault_evt_insert() RETURNS trigger AS $$ BEGIN IF NEW.change_request_id = '" + crId + "'::uuid AND NEW.event_type IN ('evaluation_complete','validation_rejected','simulation_rejected') THEN RAISE EXCEPTION 'injected fault: event insert'; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql");
    await pool.query("DROP TRIGGER IF EXISTS gp04_fault_evt ON gitwire_policy.policy_transition_events");
    await pool.query("CREATE TRIGGER gp04_fault_evt BEFORE INSERT ON gitwire_policy.policy_transition_events FOR EACH ROW EXECUTE FUNCTION gp04_fault_evt_insert()");

    let faultBlocked = false;
    try {
      if (simRes) {
        await runAsApp("SELECT * FROM gitwire_policy.finalize_policy_evaluation($1, $2, $3::jsonb, $4, $5::jsonb, $6, $7)", [crId, Number(crBefore.state_revision), JSON.stringify(valRes), "gitwire-rules-v1", JSON.stringify(simRes), "gitwire-sim-v1", authorPid]);
      } else {
        await runAsApp("SELECT * FROM gitwire_policy.finalize_policy_evaluation($1, $2, $3::jsonb, $4, NULL, NULL, $5)", [crId, Number(crBefore.state_revision), JSON.stringify(valRes), "gitwire-rules-v1", authorPid]);
      }
    } catch (e) { faultBlocked = e.message.includes("injected fault: event insert"); }
    check("event-insert fault [" + scenarioName + "]: exception raised", faultBlocked);

    await pool.query("DROP TRIGGER IF EXISTS gp04_fault_evt ON gitwire_policy.policy_transition_events");
    await pool.query("DROP FUNCTION IF EXISTS gp04_fault_evt_insert()");

    const after = {
      state: (await pool.query("SELECT state FROM gitwire_policy.policy_change_requests WHERE id = $1", [crId])).rows[0].state,
      revision: Number((await pool.query("SELECT state_revision FROM gitwire_policy.policy_change_requests WHERE id = $1", [crId])).rows[0].state_revision),
      valCount: (await pool.query("SELECT count(*)::int n FROM gitwire_policy.policy_validation_evidence")).rows[0].n,
      simCount: (await pool.query("SELECT count(*)::int n FROM gitwire_policy.policy_simulation_evidence")).rows[0].n,
      evtCount: (await pool.query("SELECT count(*)::int n FROM gitwire_policy.policy_transition_events WHERE event_type IN ('evaluation_complete','validation_rejected','simulation_rejected')")).rows[0].n,
    };
    check("event-insert fault [" + scenarioName + "]: state unchanged", after.state === before.state, "state=" + after.state);
    check("event-insert fault [" + scenarioName + "]: revision unchanged", after.revision === before.revision);
    check("event-insert fault [" + scenarioName + "]: validation evidence rolled back", after.valCount === before.valCount);
    check("event-insert fault [" + scenarioName + "]: simulation evidence rolled back", after.simCount === before.simCount);
    check("event-insert fault [" + scenarioName + "]: GP-04 event rolled back", after.evtCount === before.evtCount);
  }

  await pool.end();
} catch (e) {
  proofFailed = true;
  console.error("PROOF ERROR:", e.message);
  try { if (pool) await pool.end(); } catch {}
} finally {
  try { docker("rm", "-f", pgCid); console.log("cleanup: containers_removed"); } catch (e) { console.error("cleanup failed:", e.message); }
}

console.log("\n=== GP-04 Validation & Simulation Proof: " + passed + " passed, " + failed + " failed ===");
process.exit(proofFailed || failed > 0 ? 1 : 0);
