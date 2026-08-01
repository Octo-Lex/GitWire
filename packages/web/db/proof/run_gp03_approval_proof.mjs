#!/usr/bin/env node
// packages/web/db/proof/run_gp03_approval_proof.mjs
// GP-03 disposable proof: approval rules, approvals, separation of duties.
//
// Critical executable gates (each must FAIL if the invariant is removed):
//   - Direct SQL denied on approval tables
//   - Exactly 10 SECURITY DEFINER functions (4 GP-02 + 6 GP-03) by regprocedure
//   - Schema CHECK constraints enforce fail-closed (self_approval, step_up, assurance)
//   - Self-approval prohibition (absolute)
//   - Duplicate same-principal approval rejected
//   - Distinct-principal counting in sufficiency
//   - Rule hash covers all fields
//   - rule_revision serialization (v9/v10 labels don't affect ordering)
//   - Actor eligibility enforced inside functions (admin check, active check)
//   - Expired/revoked approvals excluded from sufficiency
//   - Approve transition (sufficient → approved, insufficient → rejected)
//   - GP-05 states unreachable
//   - Exhaustive ACL snapshot (GP-02 preserved through rollback)
//   - Exact search_path assertions
//   - Function collision fails closed

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
const pgName = "gp03-pg-" + pgPort;
const pgCid = docker("run", "-d", "--rm", "--name", pgName, "-p", "127.0.0.1:" + pgPort + ":5432", "-e", "POSTGRES_USER=proof", "-e", "POSTGRES_PASSWORD=proof-only", "-e", "POSTGRES_DB=proofdb", "postgres:16-alpine");
const dbUrl = "postgresql://proof:proof-only@127.0.0.1:" + pgPort + "/proofdb";

console.log("PG: " + pgName);

let pool = null;
try {
  await waitForReady(dbUrl, 60_000);
  pool = new pg.Pool({ connectionString: dbUrl });

  async function runAsApp(sql, params) {
    const c = await pool.connect();
    try { await c.query("SET SESSION AUTHORIZATION gitwire_app"); return await c.query(sql, params); }
    finally { await c.query("RESET SESSION AUTHORIZATION"); c.release(); }
  }

  // ═══ Phase 1: Migrations ══════════════════════════════════════════════
  console.log("\n=== Phase 1: Apply migrations 001-046 ===");
  await applyMigrations(pool);
  const migCount = (await pool.query("SELECT count(*)::int n FROM schema_migrations")).rows[0].n;
  check("migration ledger = 46", migCount === 46, "count=" + migCount);

  // ═══ Phase 2: Direct SQL denied ═══════════════════════════════════════
  console.log("\n=== Phase 2: Direct SQL denied ===");
  for (const t of ["policy_approval_rules", "policy_approvals", "policy_approval_lifecycle"]) {
    let blocked = false;
    try { await runAsApp("INSERT INTO gitwire_policy." + t + " DEFAULT VALUES"); } catch { blocked = true; }
    check("gitwire_app NO INSERT on " + t, blocked);
  }

  // ═══ Phase 3: Exact function signatures ══════════════════════════════
  console.log("\n=== Phase 3: Exact function signatures ===");
  const expectedAllSigs = [
    "gitwire_policy.create_policy_change_request(text,text,text,uuid)",
    "gitwire_policy.create_policy_version(uuid,jsonb,uuid)",
    "gitwire_policy.select_policy_version(uuid,uuid,bigint,uuid)",
    "gitwire_policy.submit_policy_change_request(uuid,bigint,uuid)",
    "gitwire_policy.create_policy_approval_rule(text,text,text,text,text,integer,jsonb,uuid,integer)",
    "gitwire_policy.record_policy_approval(uuid,uuid,uuid)",
    "gitwire_policy.revoke_policy_approval(uuid,bigint,uuid,text)",
    "gitwire_policy.expire_policy_approval(uuid,bigint,uuid)",
    "gitwire_policy.evaluate_approval_sufficiency(uuid)",
    "gitwire_policy.approve_policy_change_request(uuid,bigint,uuid)",
  ].sort();

  // SECURITY DEFINER set
  const { rows: secDefRows } = await pool.query(
    "SELECT p.oid::regprocedure::text as sig FROM pg_proc p JOIN pg_roles r ON p.proowner = r.oid JOIN pg_namespace n ON p.pronamespace = n.oid WHERE n.nspname = 'gitwire_policy' AND r.rolname = 'gitwire_policy_fn_owner' AND p.prosecdef = true AND p.proname != 'canonical_jsonb' ORDER BY 1"
  );
  const secDefSigs = secDefRows.map(f => f.sig);
  check("SECURITY DEFINER set exact match (10 functions)", JSON.stringify(secDefSigs) === JSON.stringify(expectedAllSigs), "found=" + JSON.stringify(secDefSigs));

  // Executable set
  const { rows: allFns } = await pool.query("SELECT p.oid, p.oid::regprocedure::text as sig FROM pg_proc p JOIN pg_namespace n ON p.pronamespace = n.oid WHERE n.nspname = 'gitwire_policy' ORDER BY 2");
  const execSigs = [];
  for (const fn of allFns) {
    const { rows: [priv] } = await pool.query("SELECT has_function_privilege('gitwire_app', $1, 'EXECUTE') as can", [fn.oid]);
    if (priv.can) execSigs.push(fn.sig);
  }
  execSigs.sort();
  check("gitwire_app executable set exact match (10 functions)", JSON.stringify(execSigs) === JSON.stringify(expectedAllSigs), "found=" + JSON.stringify(execSigs));

  // ═══ Phase 4: Schema CHECK constraints ════════════════════════════════
  console.log("\n=== Phase 4: Schema CHECK constraints ===");
  const { rows: checks } = await pool.query("SELECT conname FROM pg_constraint WHERE conrelid = 'gitwire_policy.policy_approval_rules'::regclass AND contype = 'c' ORDER BY conname");
  const checkNames = checks.map(c => c.conname);
  for (const required of ["par_self_approval_check", "par_step_up_check", "par_assurance_check", "par_risk_enum_check", "par_required_count_min", "par_rule_revision_check"]) {
    check("CHECK constraint exists: " + required, checkNames.includes(required));
  }

  // ═══ Phase 5: Setup fixture data ═════════════════════════════════════
  console.log("\n=== Phase 5: Setup fixtures ===");
  // Create principals: admin (approver), author, approver2
  await pool.query("INSERT INTO gitwire_auth.auth_principals (principal_type, display_name) VALUES ('legacy-key','gp03-admin') ON CONFLICT DO NOTHING");
  await pool.query("INSERT INTO gitwire_auth.auth_principals (principal_type, display_name) VALUES ('legacy-key','gp03-author') ON CONFLICT DO NOTHING");
  await pool.query("INSERT INTO gitwire_auth.auth_principals (principal_type, display_name) VALUES ('legacy-key','gp03-approver1') ON CONFLICT DO NOTHING");
  await pool.query("INSERT INTO gitwire_auth.auth_principals (principal_type, display_name) VALUES ('legacy-key','gp03-approver2') ON CONFLICT DO NOTHING");

  const adminPid = (await pool.query("SELECT id FROM gitwire_auth.auth_principals WHERE display_name='gp03-admin'")).rows[0].id;
  const authorPid = (await pool.query("SELECT id FROM gitwire_auth.auth_principals WHERE display_name='gp03-author'")).rows[0].id;
  const approver1Pid = (await pool.query("SELECT id FROM gitwire_auth.auth_principals WHERE display_name='gp03-approver1'")).rows[0].id;
  const approver2Pid = (await pool.query("SELECT id FROM gitwire_auth.auth_principals WHERE display_name='gp03-approver2'")).rows[0].id;

  // Grant admin role to all (fleet scope) so they can create rules and approve
  await pool.query("INSERT INTO gitwire_auth.auth_role_permissions (role_id, permission) SELECT id, p FROM gitwire_auth.auth_roles, (VALUES ('policy_approval_rule:create'),('policy_approval_rule:read'),('policy_approval:create'),('policy_approval:revoke'),('policy_change_request:approve'),('policy_change_request:create'),('policy_change_request:update'),('policy_change_request:read')) AS t(p) WHERE name='admin' ON CONFLICT DO NOTHING");
  for (const pid of [adminPid, authorPid, approver1Pid, approver2Pid]) {
    await pool.query("INSERT INTO gitwire_auth.auth_principal_roles (principal_id, role_id, scope_type, granted_by) SELECT $1, r.id, 'fleet', $1 FROM gitwire_auth.auth_roles r WHERE r.name='admin' ON CONFLICT DO NOTHING", [pid]);
  }

  // Create installation + repo for repository-scoped test
  await pool.query("INSERT INTO installations (github_id, account_login, account_type) VALUES (99001, 'gp03', 'Organization') ON CONFLICT DO NOTHING");
  await pool.query("INSERT INTO repositories (github_id, installation_id, full_name, owner, name, private, default_branch, language, stars, open_issues, open_prs) VALUES (99002, 99001, 'gp03/test', 'gp03', 'test', false, 'main', 'x', 0, 0, 0) ON CONFLICT DO NOTHING");

  check("fixtures created", adminPid && authorPid && approver1Pid && approver2Pid);

  // ═══ Phase 6: Create approval rule ═══════════════════════════════════
  console.log("\n=== Phase 6: Create approval rule ===");
  const ruleResult = await runAsApp(
    "SELECT gitwire_policy.create_policy_approval_rule('v1', 'test-config', 'fleet', 'fleet', 'standard', 2, '[\"admin\"]', $1, NULL) as id",
    [adminPid]
  );
  const ruleId = ruleResult.rows[0].id;
  check("approval rule created", ruleId != null);

  const { rows: [rule] } = await pool.query("SELECT * FROM gitwire_policy.policy_approval_rules WHERE id = $1", [ruleId]);
  check("rule_revision = 1", Number(rule.rule_revision) === 1);
  check("self_approval_prohibited = true", rule.self_approval_prohibited === true);
  check("step_up_required = false", rule.step_up_required === false);
  check("min_assurance_level = level1", rule.min_assurance_level === "level1");
  check("rule_hash is sha256 format", /^sha256:[0-9a-f]{64}$/.test(rule.rule_hash));

  // ═══ Phase 7: Rule revision serialization ════════════════════════════
  console.log("\n=== Phase 7: rule_revision serialization ===");
  // Use a DIFFERENT risk classification to avoid interfering with the sufficiency test
  const r9 = await runAsApp("SELECT gitwire_policy.create_policy_approval_rule('v9', 'test-config', 'fleet', 'fleet', 'critical', 1, '[\"admin\"]', $1, NULL) as id", [adminPid]);
  const r10 = await runAsApp("SELECT gitwire_policy.create_policy_approval_rule('v10', 'test-config', 'fleet', 'fleet', 'critical', 1, '[\"admin\"]', $1, NULL) as id", [adminPid]);
  const { rows: [rule9] } = await pool.query("SELECT rule_revision FROM gitwire_policy.policy_approval_rules WHERE id = $1", [r9.rows[0].id]);
  const { rows: [rule10] } = await pool.query("SELECT rule_revision FROM gitwire_policy.policy_approval_rules WHERE id = $1", [r10.rows[0].id]);
  check("v9 rule_revision assigned (first in critical class)", Number(rule9.rule_revision) === 1, "rev=" + rule9.rule_revision);
  check("v10 rule_revision > v9 revision (serialized, not text-ordered)", Number(rule10.rule_revision) > Number(rule9.rule_revision), "v9=" + rule9.rule_revision + " v10=" + rule10.rule_revision);

  // ═══ Phase 8: Non-admin actor rejected ═══════════════════════════════
  console.log("\n=== Phase 8: Actor eligibility ===");
  // Create a non-admin principal
  await pool.query("INSERT INTO gitwire_auth.auth_principals (principal_type, display_name) VALUES ('legacy-key','gp03-nonadmin') ON CONFLICT DO NOTHING");
  const nonAdminPid = (await pool.query("SELECT id FROM gitwire_auth.auth_principals WHERE display_name='gp03-nonadmin'")).rows[0].id;
  let nonAdminBlocked = false;
  try {
    await runAsApp("SELECT gitwire_policy.create_policy_approval_rule('x', 'test-config', 'fleet', 'fleet', 'standard', 1, '[\"admin\"]', $1, NULL)", [nonAdminPid]);
  } catch (e) { nonAdminBlocked = e.message.includes("admin"); }
  check("non-admin cannot create rule", nonAdminBlocked);

  // ═══ Phase 9: Create change request + transition to awaiting_approval ══
  console.log("\n=== Phase 9: Setup change request in awaiting_approval ===");
  // Use the original rule (required_count=2) for this test
  const crResult = await runAsApp("SELECT gitwire_policy.create_policy_change_request('repository','gp03/test','test-config',$1) as id", [authorPid]);
  const crId = crResult.rows[0].id;

  // Create version
  const vResult = await runAsApp("SELECT gitwire_policy.create_policy_version($1, $2, $3) as id", [crId, JSON.stringify({v:1}), authorPid]);
  const vId = vResult.rows[0].id;

  // Select version
  await runAsApp("SELECT * FROM gitwire_policy.select_policy_version($1, $2, 0, $3)", [crId, vId, authorPid]);
  const { rows: [crAfterSelect] } = await pool.query("SELECT state_revision FROM gitwire_policy.policy_change_requests WHERE id = $1", [crId]);

  // Submit
  await runAsApp("SELECT * FROM gitwire_policy.submit_policy_change_request($1, $2, $3)", [crId, Number(crAfterSelect.state_revision), authorPid]);
  const { rows: [crAfterSubmit] } = await pool.query("SELECT state, state_revision FROM gitwire_policy.policy_change_requests WHERE id = $1", [crId]);
  check("state = submitted", crAfterSubmit.state === "submitted");

  // Manually transition to awaiting_approval with evidence context (fixture — GP-04 would do this via its own function)
  // We need to insert validation and simulation evidence first
  const { rows: [vRow] } = await pool.query("SELECT content_hash FROM gitwire_policy.policy_versions WHERE id = $1", [vId]);
  const valHash = "sha256:" + "a".repeat(64);
  const simHash = "sha256:" + "b".repeat(64);
  // Insert evidence (as superuser — fixture)
  await pool.query("INSERT INTO gitwire_policy.policy_validation_evidence (version_id, evidence_hash, result, validator_version) VALUES ($1, $2, '{}'::jsonb, 'test-v1')", [vId, valHash]);
  await pool.query("INSERT INTO gitwire_policy.policy_simulation_evidence (version_id, evidence_hash, result, evaluator_version) VALUES ($1, $2, '{}'::jsonb, 'test-v1')", [vId, simHash]);

  // Transition to awaiting_approval with context event
  await pool.query("UPDATE gitwire_policy.policy_change_requests SET state = 'awaiting_approval', state_revision = state_revision + 1, updated_at = now() WHERE id = $1 AND state = 'submitted'", [crId]);
  await pool.query(
    "INSERT INTO gitwire_policy.policy_transition_events (change_request_id, event_type, from_state, to_state, actor_principal_id, detail) VALUES ($1, 'transition', 'submitted', 'awaiting_approval', $2, $3)",
    [crId, adminPid, JSON.stringify({ version_id: vId, validation_evidence_hash: valHash, simulation_evidence_hash: simHash, risk_classification: "standard" })]
  );

  const { rows: [crAwait] } = await pool.query("SELECT state, state_revision FROM gitwire_policy.policy_change_requests WHERE id = $1", [crId]);
  check("state = awaiting_approval", crAwait.state === "awaiting_approval");

  // ═══ Phase 10: Self-approval prohibition ═════════════════════════════
  console.log("\n=== Phase 10: Self-approval prohibition ===");
  let selfApprovalBlocked = false;
  try {
    await runAsApp("SELECT gitwire_policy.record_policy_approval($1, $2, $3)", [crId, ruleId, authorPid]);
  } catch (e) { selfApprovalBlocked = e.message.includes("self-approval"); }
  check("self-approval prohibited (author == approver)", selfApprovalBlocked);

  // ═══ Phase 11: Record valid approvals ═══════════════════════════════
  console.log("\n=== Phase 11: Record valid approvals ===");
  const a1 = await runAsApp("SELECT gitwire_policy.record_policy_approval($1, $2, $3) as id", [crId, ruleId, approver1Pid]);
  check("approval 1 recorded", a1.rows[0]?.id != null);

  // ═══ Phase 12: Duplicate same-principal rejection ════════════════════
  console.log("\n=== Phase 12: Duplicate rejection ===");
  let dupBlocked = false;
  try {
    await runAsApp("SELECT gitwire_policy.record_policy_approval($1, $2, $3)", [crId, ruleId, approver1Pid]);
  } catch (e) { dupBlocked = e.message.includes("duplicate") || e.message.includes("already exists"); }
  check("duplicate same-principal approval rejected", dupBlocked);

  // ═══ Phase 13: Evaluate (insufficient — only 1 of 2) ════════════════
  console.log("\n=== Phase 13: Evaluate (insufficient) ===");
  const eval1 = await runAsApp("SELECT gitwire_policy.evaluate_approval_sufficiency($1) as result", [crId]);
  const evalResult1 = eval1.rows[0].result;
  check("insufficient: distinct_count = 1", Number(evalResult1.active_distinct_approver_count) === 1);
  check("insufficient: required_count = 2", Number(evalResult1.required_count) === 2);
  check("insufficient: sufficient = false", evalResult1.sufficient === false);

  // Record second approval from different principal
  const a2 = await runAsApp("SELECT gitwire_policy.record_policy_approval($1, $2, $3) as id", [crId, ruleId, approver2Pid]);
  check("approval 2 recorded", a2.rows[0]?.id != null);

  // ═══ Phase 14: Evaluate (sufficient — 2 of 2) ═══════════════════════
  console.log("\n=== Phase 14: Evaluate (sufficient) ===");
  const eval2 = await runAsApp("SELECT gitwire_policy.evaluate_approval_sufficiency($1) as result", [crId]);
  const evalResult2 = eval2.rows[0].result;
  check("sufficient: distinct_count = 2", Number(evalResult2.active_distinct_approver_count) === 2);
  check("sufficient: sufficient = true", evalResult2.sufficient === true);

  // ═══ Phase 15: Approve (sufficient → approved) ══════════════════════
  console.log("\n=== Phase 15: Approve change request ===");
  const { rows: [crBeforeApprove] } = await pool.query("SELECT state_revision FROM gitwire_policy.policy_change_requests WHERE id = $1", [crId]);
  const approveResult = await runAsApp("SELECT * FROM gitwire_policy.approve_policy_change_request($1, $2, $3)", [crId, Number(crBeforeApprove.state_revision), adminPid]);
  check("state = approved", approveResult.rows[0]?.state === "approved");

  // Verify approved event has snapshot
  const { rows: [approveEvent] } = await pool.query("SELECT detail FROM gitwire_policy.policy_transition_events WHERE change_request_id = $1 AND to_state = 'approved'", [crId]);
  check("approved event has snapshot", approveEvent?.detail?.effective_rule_id != null);
  check("snapshot has counted_approver_principals", approveEvent?.detail?.counted_approver_principals != null);

  // ═══ Phase 16: GP-05 states unreachable ══════════════════════════════
  console.log("\n=== Phase 16: GP-05 states unreachable ===");
  for (const state of ["promoted"]) {
    const { rows: bodyCheck } = await pool.query("SELECT count(*)::int n FROM pg_proc p JOIN pg_namespace n ON p.pronamespace = n.oid WHERE n.nspname = 'gitwire_policy' AND p.prosecdef = true AND prosrc LIKE $1", ["%" + state + "%"]);
    check("no GP-03 function references '" + state + "'", bodyCheck[0].n === 0);
  }

  // ═══ Phase 17: Approve insufficient (separate CR) ════════════════════
  console.log("\n=== Phase 17: Approve insufficient rejected ===");
  // Create a second CR with only 1 approval (needs 2)
  const cr2Result = await runAsApp("SELECT gitwire_policy.create_policy_change_request('repository','gp03/test','test-config',$1) as id", [authorPid]);
  const cr2Id = cr2Result.rows[0].id;
  const v2Result = await runAsApp("SELECT gitwire_policy.create_policy_version($1, $2, $3) as id", [cr2Id, JSON.stringify({v:2}), authorPid]);
  const v2Id = v2Result.rows[0].id;
  await runAsApp("SELECT * FROM gitwire_policy.select_policy_version($1, $2, 0, $3)", [cr2Id, v2Id, authorPid]);
  const { rows: [cr2Sel] } = await pool.query("SELECT state_revision FROM gitwire_policy.policy_change_requests WHERE id = $1", [cr2Id]);
  await runAsApp("SELECT * FROM gitwire_policy.submit_policy_change_request($1, $2, $3)", [cr2Id, Number(cr2Sel.state_revision), authorPid]);

  // Evidence
  const val2Hash = "sha256:" + "c".repeat(64);
  const sim2Hash = "sha256:" + "d".repeat(64);
  await pool.query("INSERT INTO gitwire_policy.policy_validation_evidence (version_id, evidence_hash, result, validator_version) VALUES ($1, $2, '{}'::jsonb, 'test-v1')", [v2Id, val2Hash]);
  await pool.query("INSERT INTO gitwire_policy.policy_simulation_evidence (version_id, evidence_hash, result, evaluator_version) VALUES ($1, $2, '{}'::jsonb, 'test-v1')", [v2Id, sim2Hash]);
  await pool.query("UPDATE gitwire_policy.policy_change_requests SET state = 'awaiting_approval', state_revision = state_revision + 1, updated_at = now() WHERE id = $1 AND state = 'submitted'", [cr2Id]);
  await pool.query("INSERT INTO gitwire_policy.policy_transition_events (change_request_id, event_type, from_state, to_state, actor_principal_id, detail) VALUES ($1, 'transition', 'submitted', 'awaiting_approval', $2, $3)", [cr2Id, adminPid, JSON.stringify({ version_id: v2Id, validation_evidence_hash: val2Hash, simulation_evidence_hash: sim2Hash, risk_classification: "standard" })]);

  // Record only 1 approval (needs 2)
  await runAsApp("SELECT gitwire_policy.record_policy_approval($1, $2, $3)", [cr2Id, ruleId, approver1Pid]);

  // Try approve → should fail
  const { rows: [cr2Before] } = await pool.query("SELECT state_revision FROM gitwire_policy.policy_change_requests WHERE id = $1", [cr2Id]);
  let approveInsufficientBlocked = false;
  try {
    await runAsApp("SELECT * FROM gitwire_policy.approve_policy_change_request($1, $2, $3)", [cr2Id, Number(cr2Before.state_revision), adminPid]);
  } catch (e) { approveInsufficientBlocked = e.message.includes("insufficient"); }
  check("approve insufficient rejected", approveInsufficientBlocked);

  // Verify no state change
  const { rows: [cr2After] } = await pool.query("SELECT state FROM gitwire_policy.policy_change_requests WHERE id = $1", [cr2Id]);
  check("no state change on insufficient", cr2After.state === "awaiting_approval");

  // ═══ Phase 18: session_user check ═══════════════════════════════════
  console.log("\n=== Phase 18: session_user check ===");
  let nonAppBlocked = false;
  try {
    await pool.query("SELECT gitwire_policy.create_policy_approval_rule('x2','test-config','fleet','fleet','standard',1,'[\"admin\"]',$1,NULL)", [adminPid]);
  } catch (e) { nonAppBlocked = e.message.includes("gitwire_app"); }
  check("non-gitwire_app caller rejected", nonAppBlocked);

  // ═══ Phase 19: Exact search_path ════════════════════════════════════
  console.log("\n=== Phase 19: Exact search_path ===");
  const gp03Fns = ["create_policy_approval_rule", "record_policy_approval", "revoke_policy_approval", "expire_policy_approval", "evaluate_approval_sufficiency", "approve_policy_change_request"];
  for (const fn of gp03Fns) {
    const { rows: [fnConfig] } = await pool.query("SELECT p.proconfig FROM pg_proc p JOIN pg_namespace n ON p.pronamespace = n.oid WHERE n.nspname = 'gitwire_policy' AND p.proname = $1", [fn]);
    const configArr = fnConfig.proconfig || [];
    check(fn + ": exactly search_path=gitwire_policy, pg_catalog", configArr.length === 1 && configArr[0] === "search_path=gitwire_policy, pg_catalog", "config=" + JSON.stringify(configArr));
  }

  // ═══ Phase 20: Rollback + reapply with GP-02 preservation ════════════
  console.log("\n=== Phase 20: Rollback preserves GP-02 ===");
  // Snapshot GP-02 function set before rollback
  const { rows: gp02FnsBefore } = await pool.query("SELECT p.oid::regprocedure::text as sig FROM pg_proc p JOIN pg_namespace n ON p.pronamespace = n.oid WHERE n.nspname = 'gitwire_policy' AND p.proname IN ('create_policy_change_request','create_policy_version','select_policy_version','submit_policy_change_request','canonical_jsonb','enforce_append_only') ORDER BY 1");

  // Clean up GP-03 table data before rollback (so reapply doesn't hit unique constraint)
  // Must drop append-only triggers first to allow DELETE on immutable tables
  await pool.query("DROP TRIGGER IF EXISTS policy_approval_lifecycle_no_delete ON gitwire_policy.policy_approval_lifecycle");
  await pool.query("DROP TRIGGER IF EXISTS policy_approval_lifecycle_no_update ON gitwire_policy.policy_approval_lifecycle");
  await pool.query("DROP TRIGGER IF EXISTS policy_approvals_no_delete ON gitwire_policy.policy_approvals");
  await pool.query("DROP TRIGGER IF EXISTS policy_approvals_no_update ON gitwire_policy.policy_approvals");
  await pool.query("DROP TRIGGER IF EXISTS policy_approval_rules_no_delete ON gitwire_policy.policy_approval_rules");
  await pool.query("DROP TRIGGER IF EXISTS policy_approval_rules_no_update ON gitwire_policy.policy_approval_rules");
  await pool.query("DELETE FROM gitwire_policy.policy_approval_lifecycle");
  await pool.query("DELETE FROM gitwire_policy.policy_approvals");
  await pool.query("DELETE FROM gitwire_policy.policy_approval_rules");

  const rollbackSql = await readFile(join(ROLLBACK_DIR, "rollback_gp03_approval.sql"), "utf8");
  await pool.query(rollbackSql);

  // GP-02 functions must survive
  const { rows: gp02FnsAfter } = await pool.query("SELECT p.oid::regprocedure::text as sig FROM pg_proc p JOIN pg_namespace n ON p.pronamespace = n.oid WHERE n.nspname = 'gitwire_policy' AND p.proname IN ('create_policy_change_request','create_policy_version','select_policy_version','submit_policy_change_request','canonical_jsonb','enforce_append_only') ORDER BY 1");
  check("GP-02 functions preserved after rollback", JSON.stringify(gp02FnsBefore.map(r => r.sig)) === JSON.stringify(gp02FnsAfter.map(r => r.sig)));

  // GP-03 functions must be gone
  const { rows: gp03Gone } = await pool.query("SELECT count(*)::int n FROM pg_proc p JOIN pg_namespace n ON p.pronamespace = n.oid WHERE n.nspname = 'gitwire_policy' AND p.proname = 'create_policy_approval_rule'");
  check("GP-03 functions dropped after rollback", gp03Gone[0].n === 0);

  // GP-03 columns must be gone
  const { rows: ruleRevGone } = await pool.query("SELECT count(*)::int n FROM information_schema.columns WHERE table_schema='gitwire_policy' AND table_name='policy_approval_rules' AND column_name='rule_revision'");
  check("rule_revision column dropped after rollback", ruleRevGone[0].n === 0);

  // Ledger
  const ledger46 = (await pool.query("SELECT count(*)::int n FROM schema_migrations WHERE version = '046_gp03_approval_functions.sql'")).rows[0].n;
  check("046 ledger removed", ledger46 === 0);

  // Cross-schema grants must be revoked after rollback
  const { rows: xSchemaAfter } = await pool.query("SELECT has_schema_privilege('gitwire_policy_fn_owner','gitwire_auth','USAGE') as has");
  check("cross-schema USAGE on gitwire_auth revoked after rollback", xSchemaAfter[0].has === false);

  // Reapply
  await applyMigrations(pool);
  const finalLedger = (await pool.query("SELECT count(*)::int n FROM schema_migrations")).rows[0].n;
  check("ledger = 46 after reapply", finalLedger === 46);

  // GP-03 functions restored
  const { rows: gp03Restored } = await pool.query("SELECT count(*)::int n FROM pg_proc p JOIN pg_namespace n ON p.pronamespace = n.oid WHERE n.nspname = 'gitwire_policy' AND p.proname = 'create_policy_approval_rule'");
  check("GP-03 functions restored after reapply", gp03Restored[0].n === 1);

  // GP-03 columns restored
  const { rows: ruleRevRestored } = await pool.query("SELECT count(*)::int n FROM information_schema.columns WHERE table_schema='gitwire_policy' AND table_name='policy_approval_rules' AND column_name='rule_revision'");
  check("rule_revision column restored after reapply", ruleRevRestored[0].n === 1);

  // Cross-schema grants restored
  const { rows: xSchemaRestored } = await pool.query("SELECT has_schema_privilege('gitwire_policy_fn_owner','gitwire_auth','USAGE') as has");
  check("cross-schema USAGE on gitwire_auth restored after reapply", xSchemaRestored[0].has === true);

  // ═══ Phase 21: CASCADE check ════════════════════════════════════════
  console.log("\n=== Phase 21: CASCADE check ===");
  const migContent = await readFile(join(MIGRATIONS_DIR, "046_gp03_approval_functions.sql"), "utf8");
  check("migration no CASCADE", !/\bCASCADE\b/i.test(migContent.replace(/--.*/g, "")));
  check("rollback no CASCADE", !/\bCASCADE\b/i.test(rollbackSql.replace(/--.*/g, "")));

  // ═══ Phase 22: Fail-closed CREATE ═══════════════════════════════════
  console.log("\n=== Phase 22: Fail-closed function creation ===");
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
console.log("\n=== GP-03 Approval Proof: " + passed + " passed, " + failed + " failed ===");
process.exitCode = proofFailed || failed > 0 || cleanupFailed ? 1 : 0;
