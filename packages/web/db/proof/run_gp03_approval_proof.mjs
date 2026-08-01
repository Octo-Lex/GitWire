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
import { fileURLToPath, pathToFileURL } from "node:url";
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
  // Detail must include state_revision (post-transition) + version_id (GP-04→GP-03 contract)
  await pool.query("UPDATE gitwire_policy.policy_change_requests SET state = 'awaiting_approval', state_revision = state_revision + 1, updated_at = now() WHERE id = $1 AND state = 'submitted'", [crId]);
  const { rows: [crAwaitPre] } = await pool.query("SELECT state_revision FROM gitwire_policy.policy_change_requests WHERE id = $1", [crId]);
  await pool.query(
    "INSERT INTO gitwire_policy.policy_transition_events (change_request_id, event_type, from_state, to_state, actor_principal_id, detail) VALUES ($1, 'transition', 'submitted', 'awaiting_approval', $2, $3)",
    [crId, adminPid, JSON.stringify({ version_id: vId, state_revision: Number(crAwaitPre.state_revision), validation_evidence_hash: valHash, simulation_evidence_hash: simHash, risk_classification: "standard" })]
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
  const { rows: [cr2AwaitPre] } = await pool.query("SELECT state_revision FROM gitwire_policy.policy_change_requests WHERE id = $1", [cr2Id]);
  await pool.query("INSERT INTO gitwire_policy.policy_transition_events (change_request_id, event_type, from_state, to_state, actor_principal_id, detail) VALUES ($1, 'transition', 'submitted', 'awaiting_approval', $2, $3)", [cr2Id, adminPid, JSON.stringify({ version_id: v2Id, state_revision: Number(cr2AwaitPre.state_revision), validation_evidence_hash: val2Hash, simulation_evidence_hash: sim2Hash, risk_classification: "standard" })]);

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

  // ═══ Phase 19b: Cross-repository denial (R1/R2) ═════════════════════
  console.log("\n=== Phase 19b: Cross-repository scope denial ===");
  {
    // Create a second repo under a DIFFERENT installation
    await pool.query("INSERT INTO installations (github_id, account_login, account_type) VALUES (99010, 'gp03other', 'Organization') ON CONFLICT DO NOTHING");
    await pool.query("INSERT INTO repositories (github_id, installation_id, full_name, owner, name, private, default_branch, language, stars, open_issues, open_prs) VALUES (99012, 99010, 'gp03other/test', 'gp03other', 'test', false, 'main', 'x', 0, 0, 0) ON CONFLICT DO NOTHING");
    // An approver with an installation-scoped role for 99001 (gp03) — NOT 99010
    await pool.query("INSERT INTO gitwire_auth.auth_principals (principal_type, display_name) VALUES ('legacy-key','gp03-install-approver') ON CONFLICT DO NOTHING");
    const installApproverPid = (await pool.query("SELECT id FROM gitwire_auth.auth_principals WHERE display_name='gp03-install-approver'")).rows[0].id;
    await pool.query("INSERT INTO gitwire_auth.auth_principal_roles (principal_id, role_id, scope_type, scope_id, granted_by) SELECT $1, r.id, 'installation', 99001, $1 FROM gitwire_auth.auth_roles r WHERE r.name='admin' ON CONFLICT DO NOTHING", [installApproverPid]);
    // A repo rule for gp03other/test requiring the role
    const otherRule = await runAsApp("SELECT gitwire_policy.create_policy_approval_rule('v-other', 'test-config', 'repository', 'gp03other/test', 'standard', 1, '[\"admin\"]', $1, NULL) as id", [adminPid]);
    const otherRuleId = otherRule.rows[0].id;
    // Build a CR for gp03other/test in awaiting_approval
    const otherCr = await runAsApp("SELECT gitwire_policy.create_policy_change_request('repository','gp03other/test','test-config',$1) as id", [authorPid]);
    const otherCrId = otherCr.rows[0].id;
    const otherVer = await runAsApp("SELECT gitwire_policy.create_policy_version($1, $2, $3) as id", [otherCrId, JSON.stringify({v:99}), authorPid]);
    const otherVid = otherVer.rows[0].id;
    await runAsApp("SELECT * FROM gitwire_policy.select_policy_version($1, $2, 0, $3)", [otherCrId, otherVid, authorPid]);
    const { rows: [otherSel] } = await pool.query("SELECT state_revision FROM gitwire_policy.policy_change_requests WHERE id = $1", [otherCrId]);
    await runAsApp("SELECT * FROM gitwire_policy.submit_policy_change_request($1, $2, $3)", [otherCrId, Number(otherSel.state_revision), authorPid]);
    const otherValHash = "sha256:" + "e".repeat(64);
    const otherSimHash = "sha256:" + "f".repeat(64);
    await pool.query("INSERT INTO gitwire_policy.policy_validation_evidence (version_id, evidence_hash, result, validator_version) VALUES ($1, $2, '{}'::jsonb, 'test-v1')", [otherVid, otherValHash]);
    await pool.query("INSERT INTO gitwire_policy.policy_simulation_evidence (version_id, evidence_hash, result, evaluator_version) VALUES ($1, $2, '{}'::jsonb, 'test-v1')", [otherVid, otherSimHash]);
    await pool.query("UPDATE gitwire_policy.policy_change_requests SET state = 'awaiting_approval', state_revision = state_revision + 1, updated_at = now() WHERE id = $1 AND state = 'submitted'", [otherCrId]);
    const { rows: [otherAwait] } = await pool.query("SELECT state_revision FROM gitwire_policy.policy_change_requests WHERE id = $1", [otherCrId]);
    await pool.query("INSERT INTO gitwire_policy.policy_transition_events (change_request_id, event_type, from_state, to_state, actor_principal_id, detail) VALUES ($1, 'transition', 'submitted', 'awaiting_approval', $2, $3)", [otherCrId, adminPid, JSON.stringify({ version_id: otherVid, state_revision: Number(otherAwait.state_revision), validation_evidence_hash: otherValHash, simulation_evidence_hash: otherSimHash, risk_classification: "standard" })]);
    // The install-approver (installation 99001) must NOT be able to approve gp03other/test (installation 99010)
    let crossRepoBlocked = false;
    try {
      await runAsApp("SELECT gitwire_policy.record_policy_approval($1, $2, $3)", [otherCrId, otherRuleId, installApproverPid]);
    } catch (e) { crossRepoBlocked = e.message.includes("scope-applicable") || e.message.includes("role"); }
    check("cross-repository installation-scoped approver denied", crossRepoBlocked);
  }

  // ═══ Phase 19c: Wrong-installation, expired-assignment, disabled-principal denial ══
  console.log("\n=== Phase 19c: Authority currency denials ===");
  {
    // Wrong-installation: approver with installation 99001 trying the OTHER repo (same as 19b but explicit message check)
    // Expired-assignment: fleet admin whose assignment expired in the past
    await pool.query("INSERT INTO gitwire_auth.auth_principals (principal_type, display_name) VALUES ('legacy-key','gp03-expired-approver') ON CONFLICT DO NOTHING");
    const expiredPid = (await pool.query("SELECT id FROM gitwire_auth.auth_principals WHERE display_name='gp03-expired-approver'")).rows[0].id;
    await pool.query("INSERT INTO gitwire_auth.auth_principal_roles (principal_id, role_id, scope_type, expires_at, granted_by) SELECT $1, r.id, 'fleet', now() - interval '1 hour', $1 FROM gitwire_auth.auth_roles r WHERE r.name='admin' ON CONFLICT DO NOTHING", [expiredPid]);
    // Disabled principal
    await pool.query("INSERT INTO gitwire_auth.auth_principals (principal_type, display_name, status) VALUES ('legacy-key','gp03-disabled-approver', 'disabled') ON CONFLICT DO NOTHING");
    const disabledPid = (await pool.query("SELECT id FROM gitwire_auth.auth_principals WHERE display_name='gp03-disabled-approver'")).rows[0].id;
    await pool.query("INSERT INTO gitwire_auth.auth_principal_roles (principal_id, role_id, scope_type, granted_by) SELECT $1, r.id, 'fleet', $1 FROM gitwire_auth.auth_roles r WHERE r.name='admin' ON CONFLICT DO NOTHING", [disabledPid]);

    // Use cr2 (still awaiting_approval from Phase 17, but it has 1 approval). Build a fresh CR for clean test.
    const crX = await runAsApp("SELECT gitwire_policy.create_policy_change_request('repository','gp03/test','test-config',$1) as id", [authorPid]);
    const crXId = crX.rows[0].id;
    const vX = await runAsApp("SELECT gitwire_policy.create_policy_version($1, $2, $3) as id", [crXId, JSON.stringify({v:50}), authorPid]);
    const vXId = vX.rows[0].id;
    await runAsApp("SELECT * FROM gitwire_policy.select_policy_version($1, $2, 0, $3)", [crXId, vXId, authorPid]);
    const { rows: [selX] } = await pool.query("SELECT state_revision FROM gitwire_policy.policy_change_requests WHERE id = $1", [crXId]);
    await runAsApp("SELECT * FROM gitwire_policy.submit_policy_change_request($1, $2, $3)", [crXId, Number(selX.state_revision), authorPid]);
    const xVal = "sha256:" + "1".repeat(64);
    const xSim = "sha256:" + "2".repeat(64);
    await pool.query("INSERT INTO gitwire_policy.policy_validation_evidence (version_id, evidence_hash, result, validator_version) VALUES ($1, $2, '{}'::jsonb, 'test-v1')", [vXId, xVal]);
    await pool.query("INSERT INTO gitwire_policy.policy_simulation_evidence (version_id, evidence_hash, result, evaluator_version) VALUES ($1, $2, '{}'::jsonb, 'test-v1')", [vXId, xSim]);
    await pool.query("UPDATE gitwire_policy.policy_change_requests SET state = 'awaiting_approval', state_revision = state_revision + 1, updated_at = now() WHERE id = $1 AND state = 'submitted'", [crXId]);
    const { rows: [awaitX] } = await pool.query("SELECT state_revision FROM gitwire_policy.policy_change_requests WHERE id = $1", [crXId]);
    await pool.query("INSERT INTO gitwire_policy.policy_transition_events (change_request_id, event_type, from_state, to_state, actor_principal_id, detail) VALUES ($1, 'transition', 'submitted', 'awaiting_approval', $2, $3)", [crXId, adminPid, JSON.stringify({ version_id: vXId, state_revision: Number(awaitX.state_revision), validation_evidence_hash: xVal, simulation_evidence_hash: xSim, risk_classification: "standard" })]);

    let expiredBlocked = false;
    try { await runAsApp("SELECT gitwire_policy.record_policy_approval($1, $2, $3)", [crXId, ruleId, expiredPid]); }
    catch (e) { expiredBlocked = e.message.includes("scope-applicable") || e.message.includes("active") || e.message.includes("role"); }
    check("expired-assignment approver denied", expiredBlocked);

    let disabledBlocked = false;
    try { await runAsApp("SELECT gitwire_policy.record_policy_approval($1, $2, $3)", [crXId, ruleId, disabledPid]); }
    catch (e) { disabledBlocked = e.message.includes("active"); }
    check("disabled principal denied", disabledBlocked);
  }

  // ═══ Phase 19d: Stale + ambiguous context (R3 fail-closed) ═══════════
  console.log("\n=== Phase 19d: Context binding fail-closed ===");
  {
    // Stale context: event state_revision does NOT match current
    const crS = await runAsApp("SELECT gitwire_policy.create_policy_change_request('repository','gp03/test','test-config',$1) as id", [authorPid]);
    const crSId = crS.rows[0].id;
    const vS = await runAsApp("SELECT gitwire_policy.create_policy_version($1, $2, $3) as id", [crSId, JSON.stringify({v:60}), authorPid]);
    const vSId = vS.rows[0].id;
    await runAsApp("SELECT * FROM gitwire_policy.select_policy_version($1, $2, 0, $3)", [crSId, vSId, authorPid]);
    const { rows: [selS] } = await pool.query("SELECT state_revision FROM gitwire_policy.policy_change_requests WHERE id = $1", [crSId]);
    await runAsApp("SELECT * FROM gitwire_policy.submit_policy_change_request($1, $2, $3)", [crSId, Number(selS.state_revision), authorPid]);
    const sVal = "sha256:" + "3".repeat(64);
    const sSim = "sha256:" + "4".repeat(64);
    await pool.query("INSERT INTO gitwire_policy.policy_validation_evidence (version_id, evidence_hash, result, validator_version) VALUES ($1, $2, '{}'::jsonb, 'test-v1')", [vSId, sVal]);
    await pool.query("INSERT INTO gitwire_policy.policy_simulation_evidence (version_id, evidence_hash, result, evaluator_version) VALUES ($1, $2, '{}'::jsonb, 'test-v1')", [vSId, sSim]);
    await pool.query("UPDATE gitwire_policy.policy_change_requests SET state = 'awaiting_approval', state_revision = state_revision + 1, updated_at = now() WHERE id = $1 AND state = 'submitted'", [crSId]);
    const { rows: [awaitS] } = await pool.query("SELECT state_revision FROM gitwire_policy.policy_change_requests WHERE id = $1", [crSId]);
    // Emit a STALE event (wrong state_revision: current+99)
    await pool.query("INSERT INTO gitwire_policy.policy_transition_events (change_request_id, event_type, from_state, to_state, actor_principal_id, detail) VALUES ($1, 'transition', 'submitted', 'awaiting_approval', $2, $3)", [crSId, adminPid, JSON.stringify({ version_id: vSId, state_revision: Number(awaitS.state_revision) + 99, validation_evidence_hash: sVal, simulation_evidence_hash: sSim, risk_classification: "standard" })]);
    let staleBlocked = false;
    try { await runAsApp("SELECT gitwire_policy.record_policy_approval($1, $2, $3)", [crSId, ruleId, approver1Pid]); }
    catch (e) { staleBlocked = e.message.includes("context") || e.message.includes("match"); }
    check("stale context (mismatched state_revision) rejected", staleBlocked);

    // Ambiguous context: insert TWO valid awaiting_approval events that BOTH match
    // the current state_revision + version_id. (A stale event does not count toward
    // ambiguity since the fix counts only events matching current state.)
    await pool.query("INSERT INTO gitwire_policy.policy_transition_events (change_request_id, event_type, from_state, to_state, actor_principal_id, detail) VALUES ($1, 'transition', 'submitted', 'awaiting_approval', $2, $3)", [crSId, adminPid, JSON.stringify({ version_id: vSId, state_revision: Number(awaitS.state_revision), validation_evidence_hash: sVal, simulation_evidence_hash: sSim, risk_classification: "standard" })]);
    await pool.query("INSERT INTO gitwire_policy.policy_transition_events (change_request_id, event_type, from_state, to_state, actor_principal_id, detail) VALUES ($1, 'transition', 'submitted', 'awaiting_approval', $2, $3)", [crSId, adminPid, JSON.stringify({ version_id: vSId, state_revision: Number(awaitS.state_revision), validation_evidence_hash: sVal, simulation_evidence_hash: sSim, risk_classification: "standard" })]);
    let ambiguousBlocked = false;
    try { await runAsApp("SELECT gitwire_policy.record_policy_approval($1, $2, $3)", [crSId, ruleId, approver1Pid]); }
    catch (e) { ambiguousBlocked = e.message.includes("ambiguous"); }
    check("ambiguous context (two events matching current state) rejected", ambiguousBlocked);
  }

  // ═══ Phase 19d2: F1 — unauthorized approver does NOT inflate sufficiency ══
  console.log("\n=== Phase 19d2: F1 unauthorized-approver exclusion ===");
  {
    // Build a CR with a 1-approval rule (precedence-config family, fleet scope).
    // Record a VALID approval (fleet approver) AND a second approval by an
    // approver who subsequently becomes DISABLED. The disabled approver must NOT
    // count toward distinct approvers.
    const f1Rule = await runAsApp("SELECT gitwire_policy.create_policy_approval_rule('v-f1', 'f1-config', 'fleet', 'fleet', 'standard', 2, '[\"admin\"]', $1, NULL) as id", [adminPid]);
    const f1RuleId = f1Rule.rows[0].id;
    const crF1 = await runAsApp("SELECT gitwire_policy.create_policy_change_request('repository','gp03/test','f1-config',$1) as id", [authorPid]);
    const crF1Id = crF1.rows[0].id;
    const vF1 = await runAsApp("SELECT gitwire_policy.create_policy_version($1, $2, $3) as id", [crF1Id, JSON.stringify({v:111}), authorPid]);
    const vF1Id = vF1.rows[0].id;
    await runAsApp("SELECT * FROM gitwire_policy.select_policy_version($1, $2, 0, $3)", [crF1Id, vF1Id, authorPid]);
    const { rows: [selF1] } = await pool.query("SELECT state_revision FROM gitwire_policy.policy_change_requests WHERE id = $1", [crF1Id]);
    await runAsApp("SELECT * FROM gitwire_policy.submit_policy_change_request($1, $2, $3)", [crF1Id, Number(selF1.state_revision), authorPid]);
    const f1Val = "sha256:" + "a1".repeat(32);
    const f1Sim = "sha256:" + "b1".repeat(32);
    await pool.query("INSERT INTO gitwire_policy.policy_validation_evidence (version_id, evidence_hash, result, validator_version) VALUES ($1, $2, '{}'::jsonb, 'test-v1')", [vF1Id, f1Val]);
    await pool.query("INSERT INTO gitwire_policy.policy_simulation_evidence (version_id, evidence_hash, result, evaluator_version) VALUES ($1, $2, '{}'::jsonb, 'test-v1')", [vF1Id, f1Sim]);
    await pool.query("UPDATE gitwire_policy.policy_change_requests SET state = 'awaiting_approval', state_revision = state_revision + 1, updated_at = now() WHERE id = $1 AND state = 'submitted'", [crF1Id]);
    const { rows: [awaitF1] } = await pool.query("SELECT state_revision FROM gitwire_policy.policy_change_requests WHERE id = $1", [crF1Id]);
    await pool.query("INSERT INTO gitwire_policy.policy_transition_events (change_request_id, event_type, from_state, to_state, actor_principal_id, detail) VALUES ($1, 'transition', 'submitted', 'awaiting_approval', $2, $3)", [crF1Id, adminPid, JSON.stringify({ version_id: vF1Id, state_revision: Number(awaitF1.state_revision), validation_evidence_hash: f1Val, simulation_evidence_hash: f1Sim, risk_classification: "standard" })]);

    // A principal who is currently active (so record succeeds), then gets disabled
    await pool.query("INSERT INTO gitwire_auth.auth_principals (principal_type, display_name) VALUES ('legacy-key','gp03-f1-toDisable') ON CONFLICT DO NOTHING");
    const toDisablePid = (await pool.query("SELECT id FROM gitwire_auth.auth_principals WHERE display_name='gp03-f1-toDisable'")).rows[0].id;
    await pool.query("INSERT INTO gitwire_auth.auth_principal_roles (principal_id, role_id, scope_type, granted_by) SELECT $1, r.id, 'fleet', $1 FROM gitwire_auth.auth_roles r WHERE r.name='admin' ON CONFLICT DO NOTHING", [toDisablePid]);
    // Record a valid approval from approver1 AND from toDisable (both currently active)
    await runAsApp("SELECT gitwire_policy.record_policy_approval($1, $2, $3)", [crF1Id, f1RuleId, approver1Pid]);
    await runAsApp("SELECT gitwire_policy.record_policy_approval($1, $2, $3)", [crF1Id, f1RuleId, toDisablePid]);

    // Evaluate — should be sufficient (2 active distinct approvers)
    let ev1 = (await runAsApp("SELECT gitwire_policy.evaluate_approval_sufficiency($1) as j", [crF1Id])).rows[0].j;
    check("F1: sufficient before disable (2 active approvers)", ev1.sufficient === true && ev1.active_distinct_approver_count === 2, "count=" + ev1.active_distinct_approver_count);

    // Now DISABLE the second approver
    await pool.query("UPDATE gitwire_auth.auth_principals SET status = 'disabled' WHERE id = $1", [toDisablePid]);
    // Evaluate — the disabled approver must NOT count; count drops to 1, insufficient
    let ev2 = (await runAsApp("SELECT gitwire_policy.evaluate_approval_sufficiency($1) as j", [crF1Id])).rows[0].j;
    check("F1: disabled approver excluded from count (drops to 1)", ev2.active_distinct_approver_count === 1, "count=" + ev2.active_distinct_approver_count);
    check("F1: insufficient after disable (1 valid approver, need 2)", ev2.sufficient === false, "sufficient=" + ev2.sufficient);
  }

  // ═══ Phase 19d3: F4 — disabled former approver cannot self-revoke ══════
  console.log("\n=== Phase 19d3: F4 disabled-approver self-revoke denied ===");
  {
    const f4Rule = await runAsApp("SELECT gitwire_policy.create_policy_approval_rule('v-f4', 'f4-config', 'fleet', 'fleet', 'standard', 1, '[\"admin\"]', $1, NULL) as id", [adminPid]);
    const f4RuleId = f4Rule.rows[0].id;
    const crF4 = await runAsApp("SELECT gitwire_policy.create_policy_change_request('repository','gp03/test','f4-config',$1) as id", [authorPid]);
    const crF4Id = crF4.rows[0].id;
    const vF4 = await runAsApp("SELECT gitwire_policy.create_policy_version($1, $2, $3) as id", [crF4Id, JSON.stringify({v:114}), authorPid]);
    const vF4Id = vF4.rows[0].id;
    await runAsApp("SELECT * FROM gitwire_policy.select_policy_version($1, $2, 0, $3)", [crF4Id, vF4Id, authorPid]);
    const { rows: [selF4] } = await pool.query("SELECT state_revision FROM gitwire_policy.policy_change_requests WHERE id = $1", [crF4Id]);
    await runAsApp("SELECT * FROM gitwire_policy.submit_policy_change_request($1, $2, $3)", [crF4Id, Number(selF4.state_revision), authorPid]);
    const f4Val = "sha256:" + "a4".repeat(32);
    const f4Sim = "sha256:" + "b4".repeat(32);
    await pool.query("INSERT INTO gitwire_policy.policy_validation_evidence (version_id, evidence_hash, result, validator_version) VALUES ($1, $2, '{}'::jsonb, 'test-v1')", [vF4Id, f4Val]);
    await pool.query("INSERT INTO gitwire_policy.policy_simulation_evidence (version_id, evidence_hash, result, evaluator_version) VALUES ($1, $2, '{}'::jsonb, 'test-v1')", [vF4Id, f4Sim]);
    await pool.query("UPDATE gitwire_policy.policy_change_requests SET state = 'awaiting_approval', state_revision = state_revision + 1, updated_at = now() WHERE id = $1 AND state = 'submitted'", [crF4Id]);
    const { rows: [awaitF4] } = await pool.query("SELECT state_revision FROM gitwire_policy.policy_change_requests WHERE id = $1", [crF4Id]);
    await pool.query("INSERT INTO gitwire_policy.policy_transition_events (change_request_id, event_type, from_state, to_state, actor_principal_id, detail) VALUES ($1, 'transition', 'submitted', 'awaiting_approval', $2, $3)", [crF4Id, adminPid, JSON.stringify({ version_id: vF4Id, state_revision: Number(awaitF4.state_revision), validation_evidence_hash: f4Val, simulation_evidence_hash: f4Sim, risk_classification: "standard" })]);

    // A principal who records an approval, then is disabled
    await pool.query("INSERT INTO gitwire_auth.auth_principals (principal_type, display_name) VALUES ('legacy-key','gp03-f4-selfRev') ON CONFLICT DO NOTHING");
    const selfRevPid = (await pool.query("SELECT id FROM gitwire_auth.auth_principals WHERE display_name='gp03-f4-selfRev'")).rows[0].id;
    await pool.query("INSERT INTO gitwire_auth.auth_principal_roles (principal_id, role_id, scope_type, granted_by) SELECT $1, r.id, 'fleet', $1 FROM gitwire_auth.auth_roles r WHERE r.name='admin' ON CONFLICT DO NOTHING", [selfRevPid]);
    const apprF4 = await runAsApp("SELECT gitwire_policy.record_policy_approval($1, $2, $3) as id", [crF4Id, f4RuleId, selfRevPid]);
    const apprF4Id = apprF4.rows[0].id;

    // Disable the approver
    await pool.query("UPDATE gitwire_auth.auth_principals SET status = 'disabled' WHERE id = $1", [selfRevPid]);
    // The disabled former approver must NOT be able to self-revoke
    let selfRevokeBlocked = false;
    try { await runAsApp("SELECT gitwire_policy.revoke_policy_approval($1, $2, $3, $4)", [apprF4Id, 0, selfRevPid, "self-revoke-after-disable"]); }
    catch (e) { selfRevokeBlocked = e.message.includes("active") || e.message.includes("role") || e.message.includes("current"); }
    check("F4: disabled former approver cannot self-revoke", selfRevokeBlocked);
    // A fleet admin CAN still revoke it
    await runAsApp("SELECT gitwire_policy.revoke_policy_approval($1, $2, $3, $4)", [apprF4Id, 0, adminPid, "admin-revoke"]);
    const { rows: [lfF4] } = await pool.query("SELECT to_status FROM gitwire_policy.policy_approval_lifecycle WHERE approval_id = $1 ORDER BY lifecycle_revision DESC LIMIT 1", [apprF4Id]);
    check("F4: fleet admin can revoke the same approval", lfF4.to_status === "revoked");
  }

  // ═══ Phase 19d4: F1 — unrelated-role approver does NOT inflate count ══
  console.log("\n=== Phase 19d4: F1 unrelated-role exclusion ===");
  {
    // A rule requiring 'admin'. Record approvals from an admin AND from a
    // principal who has only an active 'operator' role (unrelated). The operator
    // approval must NOT count toward distinct approvers or required_count.
    const uRule = await runAsApp("SELECT gitwire_policy.create_policy_approval_rule('v-unrel', 'unrel-config', 'fleet', 'fleet', 'standard', 2, '[\"admin\"]', $1, NULL) as id", [adminPid]);
    const uRuleId = uRule.rows[0].id;
    const crU = await runAsApp("SELECT gitwire_policy.create_policy_change_request('repository','gp03/test','unrel-config',$1) as id", [authorPid]);
    const crUId = crU.rows[0].id;
    const vU = await runAsApp("SELECT gitwire_policy.create_policy_version($1, $2, $3) as id", [crUId, JSON.stringify({v:121}), authorPid]);
    const vUId = vU.rows[0].id;
    await runAsApp("SELECT * FROM gitwire_policy.select_policy_version($1, $2, 0, $3)", [crUId, vUId, authorPid]);
    const { rows: [selU] } = await pool.query("SELECT state_revision FROM gitwire_policy.policy_change_requests WHERE id = $1", [crUId]);
    await runAsApp("SELECT * FROM gitwire_policy.submit_policy_change_request($1, $2, $3)", [crUId, Number(selU.state_revision), authorPid]);
    const uVal = "sha256:" + "d1".repeat(32);
    const uSim = "sha256:" + "e1".repeat(32);
    await pool.query("INSERT INTO gitwire_policy.policy_validation_evidence (version_id, evidence_hash, result, validator_version) VALUES ($1, $2, '{}'::jsonb, 'test-v1')", [vUId, uVal]);
    await pool.query("INSERT INTO gitwire_policy.policy_simulation_evidence (version_id, evidence_hash, result, evaluator_version) VALUES ($1, $2, '{}'::jsonb, 'test-v1')", [vUId, uSim]);
    await pool.query("UPDATE gitwire_policy.policy_change_requests SET state = 'awaiting_approval', state_revision = state_revision + 1, updated_at = now() WHERE id = $1 AND state = 'submitted'", [crUId]);
    const { rows: [awaitU] } = await pool.query("SELECT state_revision FROM gitwire_policy.policy_change_requests WHERE id = $1", [crUId]);
    await pool.query("INSERT INTO gitwire_policy.policy_transition_events (change_request_id, event_type, from_state, to_state, actor_principal_id, detail) VALUES ($1, 'transition', 'submitted', 'awaiting_approval', $2, $3)", [crUId, adminPid, JSON.stringify({ version_id: vUId, state_revision: Number(awaitU.state_revision), validation_evidence_hash: uVal, simulation_evidence_hash: uSim, risk_classification: "standard" })]);
    // Record the admin approval (counts)
    await runAsApp("SELECT gitwire_policy.record_policy_approval($1, $2, $3)", [crUId, uRuleId, approver1Pid]);
    // Record approval from a principal holding ONLY an unrelated active role (operator).
    // Note: record_policy_approval requires a required role, so this approval cannot
    // be recorded by the operator. To test sufficiency counting specifically, insert
    // the approval directly as a fixture (simulating a recorded approval), then verify
    // the operator is EXCLUDED from the count because their role is not 'admin'.
    await pool.query("INSERT INTO gitwire_auth.auth_principals (principal_type, display_name) VALUES ('legacy-key','gp03-unrel-op') ON CONFLICT DO NOTHING");
    const unrelPid = (await pool.query("SELECT id FROM gitwire_auth.auth_principals WHERE display_name='gp03-unrel-op'")).rows[0].id;
    // Ensure 'operator' role exists and is active
    await pool.query("INSERT INTO gitwire_auth.auth_roles (name, description, is_builtin, status) VALUES ('operator','test','f','active') ON CONFLICT (name) DO NOTHING");
    const opRoleId = (await pool.query("SELECT id FROM gitwire_auth.auth_roles WHERE name='operator'")).rows[0].id;
    await pool.query("INSERT INTO gitwire_auth.auth_principal_roles (principal_id, role_id, scope_type, granted_by) VALUES ($1, $2, 'fleet', $1) ON CONFLICT DO NOTHING", [unrelPid, opRoleId]);
    // Insert an approval from the unrelated operator (fixture: directly, since record rejects them)
    const uRuleHash = (await pool.query("SELECT rule_hash FROM gitwire_policy.policy_approval_rules WHERE id = $1", [uRuleId])).rows[0].rule_hash;
    const { rows: [vUrow] } = await pool.query("SELECT content_hash FROM gitwire_policy.policy_versions WHERE id = $1", [vUId]);
    await pool.query("INSERT INTO gitwire_policy.policy_approvals (version_id, content_hash, validation_evidence_hash, simulation_evidence_hash, approval_rule_id, approval_rule_hash, risk_classification, approver_principal_id, resource_scope_type, resource_scope_id) VALUES ($1,$2,$3,$4,$5,$6,'standard',$7,'repository','gp03/test')", [vUId, vUrow.content_hash, uVal, uSim, uRuleId, uRuleHash, unrelPid]);
    await pool.query("INSERT INTO gitwire_policy.policy_approval_lifecycle (approval_id, lifecycle_revision, from_status, to_status, actor_principal_id, reason_code) SELECT id, 0, NULL, 'active', $1, 'fixture' FROM gitwire_policy.policy_approvals WHERE approver_principal_id = $1 AND version_id = $2", [unrelPid, vUId]);
    // Evaluate: the operator must NOT count. count should be 1 (only the admin).
    let evU = (await runAsApp("SELECT gitwire_policy.evaluate_approval_sufficiency($1) as j", [crUId])).rows[0].j;
    check("F1: unrelated-role approver excluded from count (count=1 not 2)", evU.active_distinct_approver_count === 1, "count=" + evU.active_distinct_approver_count);
    check("F1: represented_roles excludes unrelated role", !(evU.represented_roles || []).includes("operator"), "roles=" + JSON.stringify(evU.represented_roles));
  }

  // ═══ Phase 19d5: F2 — retired-role self-revocation denied ═════════════
  console.log("\n=== Phase 19d5: F2 retired-role self-revoke denied ===");
  {
    const r2Rule = await runAsApp("SELECT gitwire_policy.create_policy_approval_rule('v-f2', 'f2-config', 'fleet', 'fleet', 'standard', 1, '[\"admin\"]', $1, NULL) as id", [adminPid]);
    const r2RuleId = r2Rule.rows[0].id;
    const crR2 = await runAsApp("SELECT gitwire_policy.create_policy_change_request('repository','gp03/test','f2-config',$1) as id", [authorPid]);
    const crR2Id = crR2.rows[0].id;
    const vR2 = await runAsApp("SELECT gitwire_policy.create_policy_version($1, $2, $3) as id", [crR2Id, JSON.stringify({v:122}), authorPid]);
    const vR2Id = vR2.rows[0].id;
    await runAsApp("SELECT * FROM gitwire_policy.select_policy_version($1, $2, 0, $3)", [crR2Id, vR2Id, authorPid]);
    const { rows: [selR2] } = await pool.query("SELECT state_revision FROM gitwire_policy.policy_change_requests WHERE id = $1", [crR2Id]);
    await runAsApp("SELECT * FROM gitwire_policy.submit_policy_change_request($1, $2, $3)", [crR2Id, Number(selR2.state_revision), authorPid]);
    const r2Val = "sha256:" + "c2".repeat(32);
    const r2Sim = "sha256:" + "d2".repeat(32);
    await pool.query("INSERT INTO gitwire_policy.policy_validation_evidence (version_id, evidence_hash, result, validator_version) VALUES ($1, $2, '{}'::jsonb, 'test-v1')", [vR2Id, r2Val]);
    await pool.query("INSERT INTO gitwire_policy.policy_simulation_evidence (version_id, evidence_hash, result, evaluator_version) VALUES ($1, $2, '{}'::jsonb, 'test-v1')", [vR2Id, r2Sim]);
    await pool.query("UPDATE gitwire_policy.policy_change_requests SET state = 'awaiting_approval', state_revision = state_revision + 1, updated_at = now() WHERE id = $1 AND state = 'submitted'", [crR2Id]);
    const { rows: [awaitR2] } = await pool.query("SELECT state_revision FROM gitwire_policy.policy_change_requests WHERE id = $1", [crR2Id]);
    await pool.query("INSERT INTO gitwire_policy.policy_transition_events (change_request_id, event_type, from_state, to_state, actor_principal_id, detail) VALUES ($1, 'transition', 'submitted', 'awaiting_approval', $2, $3)", [crR2Id, adminPid, JSON.stringify({ version_id: vR2Id, state_revision: Number(awaitR2.state_revision), validation_evidence_hash: r2Val, simulation_evidence_hash: r2Sim, risk_classification: "standard" })]);
    // A principal who records an approval via a dedicated role, then has that
    // role RETIRED (with no other active role assignment). A retired role must
    // not satisfy the current-authority self-revoke check.
    await pool.query("INSERT INTO gitwire_auth.auth_principals (principal_type, display_name) VALUES ('legacy-key','gp03-f2-retire') ON CONFLICT DO NOTHING");
    const retirePid = (await pool.query("SELECT id FROM gitwire_auth.auth_principals WHERE display_name='gp03-f2-retire'")).rows[0].id;
    // Dedicated active role assigned ONLY to this principal
    await pool.query("INSERT INTO gitwire_auth.auth_roles (name, description, is_builtin, status) VALUES ('gp03-f2role','f2','f','active') ON CONFLICT (name) DO NOTHING");
    const f2RoleId = (await pool.query("SELECT id FROM gitwire_auth.auth_roles WHERE name='gp03-f2role'")).rows[0].id;
    await pool.query("INSERT INTO gitwire_auth.auth_principal_roles (principal_id, role_id, scope_type, granted_by) VALUES ($1, $2, 'fleet', $1) ON CONFLICT DO NOTHING", [retirePid, f2RoleId]);

    const crR2b = await runAsApp("SELECT gitwire_policy.create_policy_change_request('repository','gp03/test','f2b-config',$1) as id", [authorPid]);
    const crR2bId = crR2b.rows[0].id;
    // Rule requiring gp03-f2role (so retirePid can record while the role is active)
    const r2bRule = await runAsApp("SELECT gitwire_policy.create_policy_approval_rule('v-f2b', 'f2b-config', 'fleet', 'fleet', 'standard', 1, '[\"gp03-f2role\"]', $1, NULL) as id", [adminPid]);
    const r2bRuleId = r2bRule.rows[0].id;
    const vR2b = await runAsApp("SELECT gitwire_policy.create_policy_version($1, $2, $3) as id", [crR2bId, JSON.stringify({v:123}), authorPid]);
    const vR2bId = vR2b.rows[0].id;
    await runAsApp("SELECT * FROM gitwire_policy.select_policy_version($1, $2, 0, $3)", [crR2bId, vR2bId, authorPid]);
    const { rows: [selR2b] } = await pool.query("SELECT state_revision FROM gitwire_policy.policy_change_requests WHERE id = $1", [crR2bId]);
    await runAsApp("SELECT * FROM gitwire_policy.submit_policy_change_request($1, $2, $3)", [crR2bId, Number(selR2b.state_revision), authorPid]);
    const r2bVal = "sha256:" + "c2".repeat(32);
    const r2bSim = "sha256:" + "d2".repeat(32);
    await pool.query("INSERT INTO gitwire_policy.policy_validation_evidence (version_id, evidence_hash, result, validator_version) VALUES ($1, $2, '{}'::jsonb, 'test-v1')", [vR2bId, r2bVal]);
    await pool.query("INSERT INTO gitwire_policy.policy_simulation_evidence (version_id, evidence_hash, result, evaluator_version) VALUES ($1, $2, '{}'::jsonb, 'test-v1')", [vR2bId, r2bSim]);
    await pool.query("UPDATE gitwire_policy.policy_change_requests SET state = 'awaiting_approval', state_revision = state_revision + 1, updated_at = now() WHERE id = $1 AND state = 'submitted'", [crR2bId]);
    const { rows: [awaitR2b] } = await pool.query("SELECT state_revision FROM gitwire_policy.policy_change_requests WHERE id = $1", [crR2bId]);
    await pool.query("INSERT INTO gitwire_policy.policy_transition_events (change_request_id, event_type, from_state, to_state, actor_principal_id, detail) VALUES ($1, 'transition', 'submitted', 'awaiting_approval', $2, $3)", [crR2bId, adminPid, JSON.stringify({ version_id: vR2bId, state_revision: Number(awaitR2b.state_revision), validation_evidence_hash: r2bVal, simulation_evidence_hash: r2bSim, risk_classification: "standard" })]);
    const apprR2b = await runAsApp("SELECT gitwire_policy.record_policy_approval($1, $2, $3) as id", [crR2bId, r2bRuleId, retirePid]);
    const apprR2bId = apprR2b.rows[0].id;
    // Retire the role (the principal's ONLY assignment is now to a retired role)
    await pool.query("UPDATE gitwire_auth.auth_roles SET status='retired' WHERE id = $1", [f2RoleId]);
    // The approver (active principal, non-revoked assignment to a now-RETIRED role) must NOT self-revoke
    let retiredSelfRevokeBlocked = false;
    try { await runAsApp("SELECT gitwire_policy.revoke_policy_approval($1, $2, $3, $4)", [apprR2bId, 0, retirePid, "retired-role-self-revoke"]); }
    catch (e) { retiredSelfRevokeBlocked = e.message.includes("active") || e.message.includes("role") || e.message.includes("current"); }
    check("F2: retired-role self-revoke denied", retiredSelfRevokeBlocked);
  }

  // ═══ Phase 19d6: F3 — revoke/expire after approve rejected ════════════
  console.log("\n=== Phase 19d6: F3 post-approve lifecycle rejection ===");
  {
    // Build a CR, get 2 approvals, APPROVE it, then attempt revoke + expire on
    // a counted approval. Both must be rejected (CR is approved, not awaiting_approval).
    const crA = await runAsApp("SELECT gitwire_policy.create_policy_change_request('repository','gp03/test','test-config',$1) as id", [authorPid]);
    const crAId = crA.rows[0].id;
    const vA = await runAsApp("SELECT gitwire_policy.create_policy_version($1, $2, $3) as id", [crAId, JSON.stringify({v:130}), authorPid]);
    const vAId = vA.rows[0].id;
    await runAsApp("SELECT * FROM gitwire_policy.select_policy_version($1, $2, 0, $3)", [crAId, vAId, authorPid]);
    const { rows: [selA] } = await pool.query("SELECT state_revision FROM gitwire_policy.policy_change_requests WHERE id = $1", [crAId]);
    await runAsApp("SELECT * FROM gitwire_policy.submit_policy_change_request($1, $2, $3)", [crAId, Number(selA.state_revision), authorPid]);
    const aVal = "sha256:" + "a3".repeat(32);
    const aSim = "sha256:" + "b3".repeat(32);
    await pool.query("INSERT INTO gitwire_policy.policy_validation_evidence (version_id, evidence_hash, result, validator_version) VALUES ($1, $2, '{}'::jsonb, 'test-v1')", [vAId, aVal]);
    await pool.query("INSERT INTO gitwire_policy.policy_simulation_evidence (version_id, evidence_hash, result, evaluator_version) VALUES ($1, $2, '{}'::jsonb, 'test-v1')", [vAId, aSim]);
    await pool.query("UPDATE gitwire_policy.policy_change_requests SET state = 'awaiting_approval', state_revision = state_revision + 1, updated_at = now() WHERE id = $1 AND state = 'submitted'", [crAId]);
    const { rows: [awaitA] } = await pool.query("SELECT state_revision FROM gitwire_policy.policy_change_requests WHERE id = $1", [crAId]);
    await pool.query("INSERT INTO gitwire_policy.policy_transition_events (change_request_id, event_type, from_state, to_state, actor_principal_id, detail) VALUES ($1, 'transition', 'submitted', 'awaiting_approval', $2, $3)", [crAId, adminPid, JSON.stringify({ version_id: vAId, state_revision: Number(awaitA.state_revision), validation_evidence_hash: aVal, simulation_evidence_hash: aSim, risk_classification: "standard" })]);
    await runAsApp("SELECT gitwire_policy.record_policy_approval($1, $2, $3)", [crAId, ruleId, approver1Pid]);
    const apprA2 = await runAsApp("SELECT gitwire_policy.record_policy_approval($1, $2, $3) as id", [crAId, ruleId, approver2Pid]);
    const apprA2Id = apprA2.rows[0].id;
    // Approve the CR (uses the rule with required_count=2)
    const { rows: [crABefore] } = await pool.query("SELECT state_revision FROM gitwire_policy.policy_change_requests WHERE id = $1", [crAId]);
    await runAsApp("SELECT * FROM gitwire_policy.approve_policy_change_request($1, $2, $3)", [crAId, Number(crABefore.state_revision), adminPid]);
    // Now revoke must be rejected (CR is approved)
    let postApproveRevokeBlocked = false;
    try { await runAsApp("SELECT gitwire_policy.revoke_policy_approval($1, $2, $3, $4)", [apprA2Id, 0, approver2Pid, "post-approve"]); }
    catch (e) { postApproveRevokeBlocked = e.message.includes("awaiting_approval") || e.message.includes("state"); }
    check("F3: revoke after approve rejected (CR not awaiting_approval)", postApproveRevokeBlocked);
    // Expire must also be rejected (even if we had a TTL approval, the state check fails first)
    let postApproveExpireBlocked = false;
    try { await runAsApp("SELECT gitwire_policy.expire_policy_approval($1, $2, $3)", [apprA2Id, 0, adminPid]); }
    catch (e) { postApproveExpireBlocked = e.message.includes("awaiting_approval") || e.message.includes("state"); }
    check("F3: expire after approve rejected (CR not awaiting_approval)", postApproveExpireBlocked);
  }

  // ═══ Phase 19d7: F5 — malformed numeric context (bigint overflow) ═════
  console.log("\n=== Phase 19d7: F5 numeric context bounds ===");
  {
    // An event whose state_revision is a 50-digit number must produce a
    // controlled malformed-context rejection, NOT a bigint-out-of-range cast error.
    const crO = await runAsApp("SELECT gitwire_policy.create_policy_change_request('repository','gp03/test','test-config',$1) as id", [authorPid]);
    const crOId = crO.rows[0].id;
    const vO = await runAsApp("SELECT gitwire_policy.create_policy_version($1, $2, $3) as id", [crOId, JSON.stringify({v:131}), authorPid]);
    const vOId = vO.rows[0].id;
    await runAsApp("SELECT * FROM gitwire_policy.select_policy_version($1, $2, 0, $3)", [crOId, vOId, authorPid]);
    const { rows: [selO] } = await pool.query("SELECT state_revision FROM gitwire_policy.policy_change_requests WHERE id = $1", [crOId]);
    await runAsApp("SELECT * FROM gitwire_policy.submit_policy_change_request($1, $2, $3)", [crOId, Number(selO.state_revision), authorPid]);
    const oVal = "sha256:" + "f5".repeat(32);
    const oSim = "sha256:" + "a5".repeat(32);
    await pool.query("INSERT INTO gitwire_policy.policy_validation_evidence (version_id, evidence_hash, result, validator_version) VALUES ($1, $2, '{}'::jsonb, 'test-v1')", [vOId, oVal]);
    await pool.query("INSERT INTO gitwire_policy.policy_simulation_evidence (version_id, evidence_hash, result, evaluator_version) VALUES ($1, $2, '{}'::jsonb, 'test-v1')", [vOId, oSim]);
    await pool.query("UPDATE gitwire_policy.policy_change_requests SET state = 'awaiting_approval', state_revision = state_revision + 1, updated_at = now() WHERE id = $1 AND state = 'submitted'", [crOId]);
    const { rows: [awaitO] } = await pool.query("SELECT state_revision FROM gitwire_policy.policy_change_requests WHERE id = $1", [crOId]);
    // Insert an event with a 50-digit state_revision (will NOT match the {1,19} regex)
    await pool.query("INSERT INTO gitwire_policy.policy_transition_events (change_request_id, event_type, from_state, to_state, actor_principal_id, detail) VALUES ($1, 'transition', 'submitted', 'awaiting_approval', $2, $3)", [crOId, adminPid, JSON.stringify({ version_id: vOId, state_revision: "9".repeat(50), validation_evidence_hash: oVal, simulation_evidence_hash: oSim, risk_classification: "standard" })]);
    let overflowControlled = false;
    try { await runAsApp("SELECT gitwire_policy.record_policy_approval($1, $2, $3)", [crOId, ruleId, approver1Pid]); }
    catch (e) {
      // Must be the controlled no-context rejection, NOT a bigint-out-of-range cast error
      overflowControlled = (e.message.includes("context") || e.message.includes("match")) && !e.message.toLowerCase().includes("out of range");
    }
    check("F5: overlong numeric state_revision -> controlled rejection (no cast error)", overflowControlled);
  }

  // ═══ Phase 19e: Superseded-rule rejection + repo→org→fleet precedence ══
  console.log("\n=== Phase 19e: Effective rule (superseded + precedence) ===");
  {
    // Repository rule for gp03/test in a DISTINCT family (precedence-config) so it
    // does not shadow the fleet rule used by later test-config phases.
    const repoRule = await runAsApp("SELECT gitwire_policy.create_policy_approval_rule('v-repo', 'precedence-config', 'repository', 'gp03/test', 'standard', 2, '[\"admin\"]', $1, NULL) as id", [adminPid]);
    const repoRuleId = repoRule.rows[0].id;
    // Also create a fleet rule in precedence-config so repo wins over fleet fallback
    const fleetPrecedenceRule = await runAsApp("SELECT gitwire_policy.create_policy_approval_rule('v-fleet-prec', 'precedence-config', 'fleet', 'fleet', 'standard', 1, '[\"admin\"]', $1, NULL) as id", [adminPid]);
    const fleetPrecedenceRuleId = fleetPrecedenceRule.rows[0].id;
    // Create a CR; the effective rule should be repoRule (specificity > fleet)
    const crP = await runAsApp("SELECT gitwire_policy.create_policy_change_request('repository','gp03/test','precedence-config',$1) as id", [authorPid]);
    const crPId = crP.rows[0].id;
    const vP = await runAsApp("SELECT gitwire_policy.create_policy_version($1, $2, $3) as id", [crPId, JSON.stringify({v:70}), authorPid]);
    const vPId = vP.rows[0].id;
    await runAsApp("SELECT * FROM gitwire_policy.select_policy_version($1, $2, 0, $3)", [crPId, vPId, authorPid]);
    const { rows: [selP] } = await pool.query("SELECT state_revision FROM gitwire_policy.policy_change_requests WHERE id = $1", [crPId]);
    await runAsApp("SELECT * FROM gitwire_policy.submit_policy_change_request($1, $2, $3)", [crPId, Number(selP.state_revision), authorPid]);
    const pVal = "sha256:" + "5".repeat(64);
    const pSim = "sha256:" + "6".repeat(64);
    await pool.query("INSERT INTO gitwire_policy.policy_validation_evidence (version_id, evidence_hash, result, validator_version) VALUES ($1, $2, '{}'::jsonb, 'test-v1')", [vPId, pVal]);
    await pool.query("INSERT INTO gitwire_policy.policy_simulation_evidence (version_id, evidence_hash, result, evaluator_version) VALUES ($1, $2, '{}'::jsonb, 'test-v1')", [vPId, pSim]);
    await pool.query("UPDATE gitwire_policy.policy_change_requests SET state = 'awaiting_approval', state_revision = state_revision + 1, updated_at = now() WHERE id = $1 AND state = 'submitted'", [crPId]);
    const { rows: [awaitP] } = await pool.query("SELECT state_revision FROM gitwire_policy.policy_change_requests WHERE id = $1", [crPId]);
    await pool.query("INSERT INTO gitwire_policy.policy_transition_events (change_request_id, event_type, from_state, to_state, actor_principal_id, detail) VALUES ($1, 'transition', 'submitted', 'awaiting_approval', $2, $3)", [crPId, adminPid, JSON.stringify({ version_id: vPId, state_revision: Number(awaitP.state_revision), validation_evidence_hash: pVal, simulation_evidence_hash: pSim, risk_classification: "standard" })]);

    // Supplying the FLEET precedence rule (less-specific) for a repo request whose
    // effective rule is the repoRule must be rejected (R4 effective-rule recompute).
    let supersededBlocked = false;
    try { await runAsApp("SELECT gitwire_policy.record_policy_approval($1, $2, $3)", [crPId, fleetPrecedenceRuleId, approver1Pid]); }
    catch (e) { supersededBlocked = e.message.includes("effective") || e.message.includes("superseded") || e.message.includes("scope") || e.message.includes("family"); }
    check("superseded/less-specific rule id rejected (R4)", supersededBlocked);

    // Evaluate should select repoRule as effective
    const ev = await runAsApp("SELECT gitwire_policy.evaluate_approval_sufficiency($1) as j", [crPId]);
    const effRuleId = ev.rows[0].j.effective_rule_id;
    check("effective rule = repository rule (precedence)", effRuleId === repoRuleId);
  }

  // ═══ Phase 19f: Concurrency — concurrent duplicate approval ══════════
  console.log("\n=== Phase 19f: Concurrent duplicate approval ===");
  {
    // Two concurrent record_policy_approval for the SAME principal+CR+rule.
    // Exactly one must succeed; the other must be rejected (duplicate).
    const crC = await runAsApp("SELECT gitwire_policy.create_policy_change_request('repository','gp03/test','test-config',$1) as id", [authorPid]);
    const crCId = crC.rows[0].id;
    const vC = await runAsApp("SELECT gitwire_policy.create_policy_version($1, $2, $3) as id", [crCId, JSON.stringify({v:80}), authorPid]);
    const vCId = vC.rows[0].id;
    await runAsApp("SELECT * FROM gitwire_policy.select_policy_version($1, $2, 0, $3)", [crCId, vCId, authorPid]);
    const { rows: [selC] } = await pool.query("SELECT state_revision FROM gitwire_policy.policy_change_requests WHERE id = $1", [crCId]);
    await runAsApp("SELECT * FROM gitwire_policy.submit_policy_change_request($1, $2, $3)", [crCId, Number(selC.state_revision), authorPid]);
    const cVal = "sha256:" + "7".repeat(64);
    const cSim = "sha256:" + "8".repeat(64);
    await pool.query("INSERT INTO gitwire_policy.policy_validation_evidence (version_id, evidence_hash, result, validator_version) VALUES ($1, $2, '{}'::jsonb, 'test-v1')", [vCId, cVal]);
    await pool.query("INSERT INTO gitwire_policy.policy_simulation_evidence (version_id, evidence_hash, result, evaluator_version) VALUES ($1, $2, '{}'::jsonb, 'test-v1')", [vCId, cSim]);
    await pool.query("UPDATE gitwire_policy.policy_change_requests SET state = 'awaiting_approval', state_revision = state_revision + 1, updated_at = now() WHERE id = $1 AND state = 'submitted'", [crCId]);
    const { rows: [awaitC] } = await pool.query("SELECT state_revision FROM gitwire_policy.policy_change_requests WHERE id = $1", [crCId]);
    await pool.query("INSERT INTO gitwire_policy.policy_transition_events (change_request_id, event_type, from_state, to_state, actor_principal_id, detail) VALUES ($1, 'transition', 'submitted', 'awaiting_approval', $2, $3)", [crCId, adminPid, JSON.stringify({ version_id: vCId, state_revision: Number(awaitC.state_revision), validation_evidence_hash: cVal, simulation_evidence_hash: cSim, risk_classification: "standard" })]);

    // Fire two concurrent attempts (distinct connections, each SET SESSION AUTHORIZATION)
    const attempt = async () => {
      const c = await pool.connect();
      try {
        await c.query("SET SESSION AUTHORIZATION gitwire_app");
        await c.query("BEGIN");
        await c.query("SELECT gitwire_policy.record_policy_approval($1, $2, $3)", [crCId, ruleId, approver1Pid]);
        await c.query("COMMIT");
        return "ok";
      } catch (e) {
        try { await c.query("ROLLBACK"); } catch {}
        return e.message.includes("duplicate") || e.message.includes("already exists") ? "dup" : "err:" + e.message.slice(0, 40);
      } finally {
        try { await c.query("RESET SESSION AUTHORIZATION"); } catch {}
        c.release();
      }
    };
    const [r1, r2] = await Promise.all([attempt(), attempt()]);
    const oks = [r1, r2].filter(r => r === "ok").length;
    const dups = [r1, r2].filter(r => r === "dup").length;
    check("concurrent dup approval: exactly one succeeded", oks === 1, "results=" + JSON.stringify([r1, r2]));
    check("concurrent dup approval: other rejected as duplicate", dups === 1 || (oks === 1 && (r1 === "dup" || r2 === "dup")), "results=" + JSON.stringify([r1, r2]));
  }

  // ═══ Phase 19g: Concurrency — two lifecycle mutations, same expected rev ══
  console.log("\n=== Phase 19g: Concurrent lifecycle CAS (same expected revision) ===");
  {
    // Set up: one approval (lifecycle rev 0). Two concurrent revokes with expected=0.
    // Exactly one must succeed; the other must get a CAS mismatch (the winner bumps to 1).
    const crL = await runAsApp("SELECT gitwire_policy.create_policy_change_request('repository','gp03/test','test-config',$1) as id", [authorPid]);
    const crLId = crL.rows[0].id;
    const vL = await runAsApp("SELECT gitwire_policy.create_policy_version($1, $2, $3) as id", [crLId, JSON.stringify({v:81}), authorPid]);
    const vLId = vL.rows[0].id;
    await runAsApp("SELECT * FROM gitwire_policy.select_policy_version($1, $2, 0, $3)", [crLId, vLId, authorPid]);
    const { rows: [selL] } = await pool.query("SELECT state_revision FROM gitwire_policy.policy_change_requests WHERE id = $1", [crLId]);
    await runAsApp("SELECT * FROM gitwire_policy.submit_policy_change_request($1, $2, $3)", [crLId, Number(selL.state_revision), authorPid]);
    const lVal = "sha256:" + "9".repeat(64);
    const lSim = "sha256:" + "a".repeat(64);
    await pool.query("INSERT INTO gitwire_policy.policy_validation_evidence (version_id, evidence_hash, result, validator_version) VALUES ($1, $2, '{}'::jsonb, 'test-v1')", [vLId, lVal]);
    await pool.query("INSERT INTO gitwire_policy.policy_simulation_evidence (version_id, evidence_hash, result, evaluator_version) VALUES ($1, $2, '{}'::jsonb, 'test-v1')", [vLId, lSim]);
    await pool.query("UPDATE gitwire_policy.policy_change_requests SET state = 'awaiting_approval', state_revision = state_revision + 1, updated_at = now() WHERE id = $1 AND state = 'submitted'", [crLId]);
    const { rows: [awaitL] } = await pool.query("SELECT state_revision FROM gitwire_policy.policy_change_requests WHERE id = $1", [crLId]);
    await pool.query("INSERT INTO gitwire_policy.policy_transition_events (change_request_id, event_type, from_state, to_state, actor_principal_id, detail) VALUES ($1, 'transition', 'submitted', 'awaiting_approval', $2, $3)", [crLId, adminPid, JSON.stringify({ version_id: vLId, state_revision: Number(awaitL.state_revision), validation_evidence_hash: lVal, simulation_evidence_hash: lSim, risk_classification: "standard" })]);
    const appr = await runAsApp("SELECT gitwire_policy.record_policy_approval($1, $2, $3) as id", [crLId, ruleId, approver1Pid]);
    const apprId = appr.rows[0].id;

    const revokeAttempt = async () => {
      const c = await pool.connect();
      try {
        await c.query("SET SESSION AUTHORIZATION gitwire_app");
        await c.query("BEGIN");
        await c.query("SELECT gitwire_policy.revoke_policy_approval($1, $2, $3, $4)", [apprId, 0, adminPid, "concurrent-test"]);
        await c.query("COMMIT");
        return "ok";
      } catch (e) {
        try { await c.query("ROLLBACK"); } catch {}
        return e.message.includes("CAS failed") || e.message.includes("revision mismatch") ? "cas" : "err:" + e.message.slice(0, 40);
      } finally {
        try { await c.query("RESET SESSION AUTHORIZATION"); } catch {}
        c.release();
      }
    };
    const [r1, r2] = await Promise.all([revokeAttempt(), revokeAttempt()]);
    const oks = [r1, r2].filter(r => r === "ok").length;
    const cass = [r1, r2].filter(r => r === "cas").length;
    check("concurrent lifecycle CAS: exactly one revoked", oks === 1, "results=" + JSON.stringify([r1, r2]));
    check("concurrent lifecycle CAS: other got CAS mismatch", cass === 1 || (oks === 1 && (r1 === "cas" || r2 === "cas")), "results=" + JSON.stringify([r1, r2]));

    // Verify final lifecycle state
    const { rows: [lf] } = await pool.query("SELECT to_status, lifecycle_revision FROM gitwire_policy.policy_approval_lifecycle WHERE approval_id = $1 ORDER BY lifecycle_revision DESC LIMIT 1", [apprId]);
    check("concurrent lifecycle CAS: final state revoked @ rev 1", lf.to_status === "revoked" && Number(lf.lifecycle_revision) === 1, "status=" + lf.to_status + " rev=" + lf.lifecycle_revision);
  }

  // ═══ Phase 19h: Stale lifecycle CAS rejection (non-concurrent) ════════
  console.log("\n=== Phase 19h: Stale lifecycle CAS rejection ===");
  {
    // Build an approval, revoke it (rev 0 -> 1), then attempt a SECOND revoke with expected=0 (stale)
    const crH = await runAsApp("SELECT gitwire_policy.create_policy_change_request('repository','gp03/test','test-config',$1) as id", [authorPid]);
    const crHId = crH.rows[0].id;
    const vH = await runAsApp("SELECT gitwire_policy.create_policy_version($1, $2, $3) as id", [crHId, JSON.stringify({v:82}), authorPid]);
    const vHId = vH.rows[0].id;
    await runAsApp("SELECT * FROM gitwire_policy.select_policy_version($1, $2, 0, $3)", [crHId, vHId, authorPid]);
    const { rows: [selH] } = await pool.query("SELECT state_revision FROM gitwire_policy.policy_change_requests WHERE id = $1", [crHId]);
    await runAsApp("SELECT * FROM gitwire_policy.submit_policy_change_request($1, $2, $3)", [crHId, Number(selH.state_revision), authorPid]);
    const hVal = "sha256:" + "b".repeat(64);
    const hSim = "sha256:" + "c".repeat(64);
    await pool.query("INSERT INTO gitwire_policy.policy_validation_evidence (version_id, evidence_hash, result, validator_version) VALUES ($1, $2, '{}'::jsonb, 'test-v1')", [vHId, hVal]);
    await pool.query("INSERT INTO gitwire_policy.policy_simulation_evidence (version_id, evidence_hash, result, evaluator_version) VALUES ($1, $2, '{}'::jsonb, 'test-v1')", [vHId, hSim]);
    await pool.query("UPDATE gitwire_policy.policy_change_requests SET state = 'awaiting_approval', state_revision = state_revision + 1, updated_at = now() WHERE id = $1 AND state = 'submitted'", [crHId]);
    const { rows: [awaitH] } = await pool.query("SELECT state_revision FROM gitwire_policy.policy_change_requests WHERE id = $1", [crHId]);
    await pool.query("INSERT INTO gitwire_policy.policy_transition_events (change_request_id, event_type, from_state, to_state, actor_principal_id, detail) VALUES ($1, 'transition', 'submitted', 'awaiting_approval', $2, $3)", [crHId, adminPid, JSON.stringify({ version_id: vHId, state_revision: Number(awaitH.state_revision), validation_evidence_hash: hVal, simulation_evidence_hash: hSim, risk_classification: "standard" })]);
    const apprH = await runAsApp("SELECT gitwire_policy.record_policy_approval($1, $2, $3) as id", [crHId, ruleId, approver1Pid]);
    const apprHId = apprH.rows[0].id;
    // First revoke succeeds (expected=0)
    await runAsApp("SELECT gitwire_policy.revoke_policy_approval($1, $2, $3, $4)", [apprHId, 0, adminPid, "first-revoke"]);
    // Second revoke with STALE expected=0 must fail with CAS mismatch
    let staleCasBlocked = false;
    try { await runAsApp("SELECT gitwire_policy.revoke_policy_approval($1, $2, $3, $4)", [apprHId, 0, adminPid, "stale-revoke"]); }
    catch (e) { staleCasBlocked = e.message.includes("CAS failed") || e.message.includes("revision mismatch"); }
    check("stale lifecycle CAS rejected (expected=0 after rev bumped to 1)", staleCasBlocked);
    // No gap created: lifecycle revisions should be 0,1 (no 2)
    const { rows: revs } = await pool.query("SELECT lifecycle_revision FROM gitwire_policy.policy_approval_lifecycle WHERE approval_id = $1 ORDER BY lifecycle_revision", [apprHId]);
    check("no lifecycle revision gap created", revs.map(r => Number(r.lifecycle_revision)).join(",") === "0,1", "revs=" + JSON.stringify(revs));
  }

  // ═══ Phase 19i: Expire execution (system-scope automation path, R1) ══
  console.log("\n=== Phase 19i: Expire execution (system automation) ===");
  {
    // System principal with system-scoped admin (the ONLY path that may use system scope)
    await pool.query("INSERT INTO gitwire_auth.auth_principals (principal_type, display_name) VALUES ('system','gp03-system') ON CONFLICT DO NOTHING");
    const systemPid = (await pool.query("SELECT id FROM gitwire_auth.auth_principals WHERE display_name='gp03-system'")).rows[0].id;
    await pool.query("INSERT INTO gitwire_auth.auth_principal_roles (principal_id, role_id, scope_type, granted_by) SELECT $1, r.id, 'system', $1 FROM gitwire_auth.auth_roles r WHERE r.name='admin' ON CONFLICT DO NOTHING", [systemPid]);

    // Create a TTL rule (1-second TTL) so an approval can be expired
    const ttlRule = await runAsApp("SELECT gitwire_policy.create_policy_approval_rule('v-ttl', 'test-config', 'fleet', 'fleet', 'elevated', 1, '[\"admin\"]', $1, 1) as id", [adminPid]);
    const ttlRuleId = ttlRule.rows[0].id;

    const crT = await runAsApp("SELECT gitwire_policy.create_policy_change_request('repository','gp03/test','test-config',$1) as id", [authorPid]);
    const crTId = crT.rows[0].id;
    const vT = await runAsApp("SELECT gitwire_policy.create_policy_version($1, $2, $3) as id", [crTId, JSON.stringify({v:90}), authorPid]);
    const vTId = vT.rows[0].id;
    await runAsApp("SELECT * FROM gitwire_policy.select_policy_version($1, $2, 0, $3)", [crTId, vTId, authorPid]);
    const { rows: [selT] } = await pool.query("SELECT state_revision FROM gitwire_policy.policy_change_requests WHERE id = $1", [crTId]);
    await runAsApp("SELECT * FROM gitwire_policy.submit_policy_change_request($1, $2, $3)", [crTId, Number(selT.state_revision), authorPid]);
    const tVal = "sha256:" + "d".repeat(64);
    const tSim = "sha256:" + "e".repeat(64);
    await pool.query("INSERT INTO gitwire_policy.policy_validation_evidence (version_id, evidence_hash, result, validator_version) VALUES ($1, $2, '{}'::jsonb, 'test-v1')", [vTId, tVal]);
    await pool.query("INSERT INTO gitwire_policy.policy_simulation_evidence (version_id, evidence_hash, result, evaluator_version) VALUES ($1, $2, '{}'::jsonb, 'test-v1')", [vTId, tSim]);
    await pool.query("UPDATE gitwire_policy.policy_change_requests SET state = 'awaiting_approval', state_revision = state_revision + 1, updated_at = now() WHERE id = $1 AND state = 'submitted'", [crTId]);
    const { rows: [awaitT] } = await pool.query("SELECT state_revision FROM gitwire_policy.policy_change_requests WHERE id = $1", [crTId]);
    await pool.query("INSERT INTO gitwire_policy.policy_transition_events (change_request_id, event_type, from_state, to_state, actor_principal_id, detail) VALUES ($1, 'transition', 'submitted', 'awaiting_approval', $2, $3)", [crTId, adminPid, JSON.stringify({ version_id: vTId, state_revision: Number(awaitT.state_revision), validation_evidence_hash: tVal, simulation_evidence_hash: tSim, risk_classification: "elevated" })]);

    // Record the TTL approval
    const apprT = await runAsApp("SELECT gitwire_policy.record_policy_approval($1, $2, $3) as id", [crTId, ttlRuleId, approver1Pid]);
    const apprTId = apprT.rows[0].id;

    // Attempt expire BEFORE TTL elapses -> rejected (not expired yet)
    let notYetExpiredBlocked = false;
    try { await runAsApp("SELECT gitwire_policy.expire_policy_approval($1, $2, $3)", [apprTId, 0, systemPid]); }
    catch (e) { notYetExpiredBlocked = e.message.includes("not expired") || e.message.includes("expires_at > now"); }
    check("expire before TTL elapses rejected", notYetExpiredBlocked);

    // Wait for TTL to elapse
    await new Promise(r => setTimeout(r, 1200));

    // A non-system principal (fleet admin) can also expire
    await runAsApp("SELECT gitwire_policy.expire_policy_approval($1, $2, $3)", [apprTId, 0, adminPid]);
    const { rows: [lfT] } = await pool.query("SELECT to_status, lifecycle_revision FROM gitwire_policy.policy_approval_lifecycle WHERE approval_id = $1 ORDER BY lifecycle_revision DESC LIMIT 1", [apprTId]);
    check("expired approval lifecycle = expired @ rev 1", lfT.to_status === "expired" && Number(lfT.lifecycle_revision) === 1, "status=" + lfT.to_status + " rev=" + lfT.lifecycle_revision);

    // System principal CANNOT approve a change request (system scope is not approval authority)
    let systemApproveBlocked = false;
    try {
      // Need a second elevated approval to be sufficient, but first prove system can't approve at all:
      await runAsApp("SELECT gitwire_policy.record_policy_approval($1, $2, $3)", [crTId, ttlRuleId, systemPid]);
    } catch (e) { systemApproveBlocked = e.message.includes("scope-applicable") || e.message.includes("role") || e.message.includes("active"); }
    // systemPid is active with system-scoped admin, but system scope is NOT approval authority for record_policy_approval
    check("system principal cannot record approval (not approval authority)", systemApproveBlocked);
  }

  // ═══ Phase 19j: Concurrent revoke-vs-approve race (R8) ════════════════
  console.log("\n=== Phase 19j: Concurrent revoke vs approve ===");
  {
    // CONCURRENT: an approver revokes one approval while an admin attempts approve.
    // Both run in parallel on separate connections. Because revoke and approve both
    // lock the same change-request row FOR UPDATE, they serialize: whichever wins
    // the lock runs first. If revoke wins, approve sees count=1 -> insufficient.
    // If approve wins, it transitions to approved (count=2 at that instant) and the
    // later revoke still operates on its approval. Either outcome is consistent; the
    // invariant is that no torn state results (CR is either awaiting_approval with
    // a revoked approval, or approved with both approvals intact).
    const crR = await runAsApp("SELECT gitwire_policy.create_policy_change_request('repository','gp03/test','test-config',$1) as id", [authorPid]);
    const crRId = crR.rows[0].id;
    const vR = await runAsApp("SELECT gitwire_policy.create_policy_version($1, $2, $3) as id", [crRId, JSON.stringify({v:91}), authorPid]);
    const vRId = vR.rows[0].id;
    await runAsApp("SELECT * FROM gitwire_policy.select_policy_version($1, $2, 0, $3)", [crRId, vRId, authorPid]);
    const { rows: [selR] } = await pool.query("SELECT state_revision FROM gitwire_policy.policy_change_requests WHERE id = $1", [crRId]);
    await runAsApp("SELECT * FROM gitwire_policy.submit_policy_change_request($1, $2, $3)", [crRId, Number(selR.state_revision), authorPid]);
    const rVal = "sha256:" + "f".repeat(64);
    const rSim = "sha256:" + "1".repeat(64);
    await pool.query("INSERT INTO gitwire_policy.policy_validation_evidence (version_id, evidence_hash, result, validator_version) VALUES ($1, $2, '{}'::jsonb, 'test-v1')", [vRId, rVal]);
    await pool.query("INSERT INTO gitwire_policy.policy_simulation_evidence (version_id, evidence_hash, result, evaluator_version) VALUES ($1, $2, '{}'::jsonb, 'test-v1')", [vRId, rSim]);
    await pool.query("UPDATE gitwire_policy.policy_change_requests SET state = 'awaiting_approval', state_revision = state_revision + 1, updated_at = now() WHERE id = $1 AND state = 'submitted'", [crRId]);
    const { rows: [awaitR] } = await pool.query("SELECT state_revision FROM gitwire_policy.policy_change_requests WHERE id = $1", [crRId]);
    await pool.query("INSERT INTO gitwire_policy.policy_transition_events (change_request_id, event_type, from_state, to_state, actor_principal_id, detail) VALUES ($1, 'transition', 'submitted', 'awaiting_approval', $2, $3)", [crRId, adminPid, JSON.stringify({ version_id: vRId, state_revision: Number(awaitR.state_revision), validation_evidence_hash: rVal, simulation_evidence_hash: rSim, risk_classification: "standard" })]);
    // Record the 2 approvals needed for the fleet rule (required_count=2)
    await runAsApp("SELECT gitwire_policy.record_policy_approval($1, $2, $3)", [crRId, ruleId, approver1Pid]);
    const apprR2 = await runAsApp("SELECT gitwire_policy.record_policy_approval($1, $2, $3) as id", [crRId, ruleId, approver2Pid]);
    const apprR2Id = apprR2.rows[0].id;
    const revBefore = Number((await pool.query("SELECT state_revision FROM gitwire_policy.policy_change_requests WHERE id = $1", [crRId])).rows[0].state_revision);

    const doRevoke = async () => {
      const c = await pool.connect();
      try { await c.query("SET SESSION AUTHORIZATION gitwire_app"); await c.query("BEGIN");
        await c.query("SELECT gitwire_policy.revoke_policy_approval($1,$2,$3,$4)", [apprR2Id, 0, approver2Pid, "concurrent-revoke"]);
        await c.query("COMMIT"); return "revoked"; }
      catch (e) { try { await c.query("ROLLBACK"); } catch {} return "revoke-err:" + e.message.slice(0,30); }
      finally { try { await c.query("RESET SESSION AUTHORIZATION"); } catch {} c.release(); }
    };
    const doApprove = async () => {
      const c = await pool.connect();
      try { await c.query("SET SESSION AUTHORIZATION gitwire_app"); await c.query("BEGIN");
        await c.query("SELECT * FROM gitwire_policy.approve_policy_change_request($1,$2,$3)", [crRId, revBefore, adminPid]);
        await c.query("COMMIT"); return "approved"; }
      catch (e) { try { await c.query("ROLLBACK"); } catch {} return e.message.includes("insufficient") || e.message.includes("CAS") ? "approve-blocked:" + e.message.slice(0,20) : "approve-err:" + e.message.slice(0,30); }
      finally { try { await c.query("RESET SESSION AUTHORIZATION"); } catch {} c.release(); }
    };
    const [rr, ar] = await Promise.all([doRevoke(), doApprove()]);
    // After the race, verify a CONSISTENT end state (no torn result).
    const { rows: [endState] } = await pool.query("SELECT state FROM gitwire_policy.policy_change_requests WHERE id = $1", [crRId]);
    const { rows: [endAppr2] } = await pool.query("SELECT to_status FROM gitwire_policy.policy_approval_lifecycle WHERE approval_id = $1 ORDER BY lifecycle_revision DESC LIMIT 1", [apprR2Id]);
    const consistent = (endState.state === "approved" && endAppr2.to_status === "active")
      || (endState.state === "awaiting_approval" && endAppr2.to_status === "revoked");
    check("concurrent revoke-vs-approve: consistent end state (no torn result)", consistent, "state=" + endState.state + " appr2=" + endAppr2.to_status + " results=" + JSON.stringify([rr, ar]));
  }

  // ═══ Phase 19j2: Concurrent expire-vs-approve race (R8) ═══════════════
  console.log("\n=== Phase 19j2: Concurrent expire vs approve ===");
  {
    // A TTL approval that has expired, raced against approve. Both lock the CR;
    // consistent end state required (approved only if approval still counts, or
    // awaiting_approval with the approval expired/excluded).
    const ttlRule = await runAsApp("SELECT gitwire_policy.create_policy_approval_rule('v-ttl2', 'ttl2-config', 'fleet', 'fleet', 'elevated', 1, '[\"admin\"]', $1, 1) as id", [adminPid]);
    const ttlRuleId = ttlRule.rows[0].id;
    const crE = await runAsApp("SELECT gitwire_policy.create_policy_change_request('repository','gp03/test','ttl2-config',$1) as id", [authorPid]);
    const crEId = crE.rows[0].id;
    const vE = await runAsApp("SELECT gitwire_policy.create_policy_version($1, $2, $3) as id", [crEId, JSON.stringify({v:120}), authorPid]);
    const vEId = vE.rows[0].id;
    await runAsApp("SELECT * FROM gitwire_policy.select_policy_version($1, $2, 0, $3)", [crEId, vEId, authorPid]);
    const { rows: [selE] } = await pool.query("SELECT state_revision FROM gitwire_policy.policy_change_requests WHERE id = $1", [crEId]);
    await runAsApp("SELECT * FROM gitwire_policy.submit_policy_change_request($1, $2, $3)", [crEId, Number(selE.state_revision), authorPid]);
    const eVal = "sha256:" + "e1".repeat(32);
    const eSim = "sha256:" + "f1".repeat(32);
    await pool.query("INSERT INTO gitwire_policy.policy_validation_evidence (version_id, evidence_hash, result, validator_version) VALUES ($1, $2, '{}'::jsonb, 'test-v1')", [vEId, eVal]);
    await pool.query("INSERT INTO gitwire_policy.policy_simulation_evidence (version_id, evidence_hash, result, evaluator_version) VALUES ($1, $2, '{}'::jsonb, 'test-v1')", [vEId, eSim]);
    await pool.query("UPDATE gitwire_policy.policy_change_requests SET state = 'awaiting_approval', state_revision = state_revision + 1, updated_at = now() WHERE id = $1 AND state = 'submitted'", [crEId]);
    const { rows: [awaitE] } = await pool.query("SELECT state_revision FROM gitwire_policy.policy_change_requests WHERE id = $1", [crEId]);
    await pool.query("INSERT INTO gitwire_policy.policy_transition_events (change_request_id, event_type, from_state, to_state, actor_principal_id, detail) VALUES ($1, 'transition', 'submitted', 'awaiting_approval', $2, $3)", [crEId, adminPid, JSON.stringify({ version_id: vEId, state_revision: Number(awaitE.state_revision), validation_evidence_hash: eVal, simulation_evidence_hash: eSim, risk_classification: "elevated" })]);
    const apprE = await runAsApp("SELECT gitwire_policy.record_policy_approval($1, $2, $3) as id", [crEId, ttlRuleId, approver1Pid]);
    const apprEId = apprE.rows[0].id;
    // Wait for the 1-second TTL to elapse so expire is eligible
    await new Promise(r => setTimeout(r, 1200));
    const apprEBefore = 0;
    const evBefore = Number((await pool.query("SELECT state_revision FROM gitwire_policy.policy_change_requests WHERE id = $1", [crEId])).rows[0].state_revision);

    const doExpire = async () => {
      const c = await pool.connect();
      try { await c.query("SET SESSION AUTHORIZATION gitwire_app"); await c.query("BEGIN");
        await c.query("SELECT gitwire_policy.expire_policy_approval($1,$2,$3)", [apprEId, apprEBefore, adminPid]);
        await c.query("COMMIT"); return "expired"; }
      catch (e) { try { await c.query("ROLLBACK"); } catch {} return "expire-err:" + e.message.slice(0,30); }
      finally { try { await c.query("RESET SESSION AUTHORIZATION"); } catch {} c.release(); }
    };
    const doApproveE = async () => {
      const c = await pool.connect();
      try { await c.query("SET SESSION AUTHORIZATION gitwire_app"); await c.query("BEGIN");
        await c.query("SELECT * FROM gitwire_policy.approve_policy_change_request($1,$2,$3)", [crEId, evBefore, adminPid]);
        await c.query("COMMIT"); return "approved"; }
      catch (e) { try { await c.query("ROLLBACK"); } catch {} return e.message.includes("insufficient") || e.message.includes("CAS") ? "approve-blocked" : "approve-err:" + e.message.slice(0,30); }
      finally { try { await c.query("RESET SESSION AUTHORIZATION"); } catch {} c.release(); }
    };
    const [er, ar] = await Promise.all([doExpire(), doApproveE()]);
    const { rows: [endStateE] } = await pool.query("SELECT state FROM gitwire_policy.policy_change_requests WHERE id = $1", [crEId]);
    const { rows: [endApprE] } = await pool.query("SELECT to_status FROM gitwire_policy.policy_approval_lifecycle WHERE approval_id = $1 ORDER BY lifecycle_revision DESC LIMIT 1", [apprEId]);
    // If expire won, the approval is excluded -> approve insufficient -> awaiting_approval.
    // If approve won first, the approval was still active at evaluate time -> approved.
    const consistent = (endStateE.state === "approved" && endApprE.to_status === "active")
      || (endStateE.state === "awaiting_approval" && endApprE.to_status === "expired");
    check("concurrent expire-vs-approve: consistent end state", consistent, "state=" + endStateE.state + " apprE=" + endApprE.to_status + " results=" + JSON.stringify([er, ar]));
  }

  // ═══ Phase 19k: HTTP observer + 409 mapping + observer-bypass-denial (R8) ══
  console.log("\n=== Phase 19k: HTTP observer coverage + 409 mapping ===");
  {
    // Configure the runtime DB singleton to point at the disposable container,
    // then build a minimal Express app mounting the governedPolicyRouter behind
    // a stub apiKeyAuth that sets req.auth (so observeAuthorize can compute a
    // decision). This makes REAL HTTP calls exercising the route handlers.
    const toUrl = (p) => pathToFileURL(p).href;
    const runtimeMod = await import(toUrl(join(REPO_ROOT, "packages", "runtime", "src", "index.js")));
    const setConfig = (await import(toUrl(join(REPO_ROOT, "packages", "runtime", "compat", "_init.js")))).setConfig;
    // The real app connects AS gitwire_app (the low-privilege role). Grant it LOGIN
    // + a password and point the runtime pool at it, so service-layer function calls
    // pass the session_user='gitwire_app' guard the SECURITY DEFINER functions enforce.
    await pool.query("ALTER ROLE gitwire_app WITH LOGIN PASSWORD 'gp03-app-only'");
    // In production gitwire_app has INSERT on the observe-only decision log; grant it
    // here so observeAuthorize's best-effort logging doesn't emit permission errors.
    await pool.query("GRANT INSERT ON gitwire_auth.auth_decision_log TO gitwire_app");
    const appDbUrl = "postgresql://gitwire_app:gp03-app-only@127.0.0.1:" + pgPort + "/proofdb";
    setConfig({ db: { url: appDbUrl }, logger: { info: () => {}, warn: () => {}, error: () => {} }, redis: { url: null }, github: { appId: null, privateKey: null } });

    const { default: express } = await import("express");
    const { governedPolicyRouter } = await import(toUrl(join(REPO_ROOT, "packages", "web", "src", "routes", "governedPolicy.js")));
    const httpApp = express();
    httpApp.use(express.json());
    // Stub apiKeyAuth: set req.auth to the fleet admin principal so observeAuthorize runs
    httpApp.use("/api/policy", (req, res, next) => {
      req.auth = { principalId: adminPid, permissions: ["policy_approval_rule:read","policy_approval:read","policy_approval:evaluate","policy_approval:revoke","policy_approval:create","policy_change_request:approve"] };
      next();
    }, governedPolicyRouter);
    const request = (await import("supertest")).default;

    // GET /approval-rules — observeAuthorize runs (records a decision) and returns 200
    const getRules = await request(httpApp).get("/api/policy/approval-rules");
    check("HTTP GET /approval-rules returns 200", getRules.status === 200, "status=" + getRules.status);

    // Build a dedicated CR (awaiting_approval) for the evaluate + revoke tests in this scope
    const crK = await runAsApp("SELECT gitwire_policy.create_policy_change_request('repository','gp03/test','test-config',$1) as id", [authorPid]);
    const crKId = crK.rows[0].id;
    const vK = await runAsApp("SELECT gitwire_policy.create_policy_version($1, $2, $3) as id", [crKId, JSON.stringify({v:95}), authorPid]);
    const vKId = vK.rows[0].id;
    await runAsApp("SELECT * FROM gitwire_policy.select_policy_version($1, $2, 0, $3)", [crKId, vKId, authorPid]);
    const { rows: [selK] } = await pool.query("SELECT state_revision FROM gitwire_policy.policy_change_requests WHERE id = $1", [crKId]);
    await runAsApp("SELECT * FROM gitwire_policy.submit_policy_change_request($1, $2, $3)", [crKId, Number(selK.state_revision), authorPid]);
    const kVal = "sha256:" + "0".repeat(64);
    const kSim = "sha256:" + "1".repeat(64);
    await pool.query("INSERT INTO gitwire_policy.policy_validation_evidence (version_id, evidence_hash, result, validator_version) VALUES ($1, $2, '{}'::jsonb, 'test-v1')", [vKId, kVal]);
    await pool.query("INSERT INTO gitwire_policy.policy_simulation_evidence (version_id, evidence_hash, result, evaluator_version) VALUES ($1, $2, '{}'::jsonb, 'test-v1')", [vKId, kSim]);
    await pool.query("UPDATE gitwire_policy.policy_change_requests SET state = 'awaiting_approval', state_revision = state_revision + 1, updated_at = now() WHERE id = $1 AND state = 'submitted'", [crKId]);
    const { rows: [awaitK] } = await pool.query("SELECT state_revision FROM gitwire_policy.policy_change_requests WHERE id = $1", [crKId]);
    await pool.query("INSERT INTO gitwire_policy.policy_transition_events (change_request_id, event_type, from_state, to_state, actor_principal_id, detail) VALUES ($1, 'transition', 'submitted', 'awaiting_approval', $2, $3)", [crKId, adminPid, JSON.stringify({ version_id: vKId, state_revision: Number(awaitK.state_revision), validation_evidence_hash: kVal, simulation_evidence_hash: kSim, risk_classification: "standard" })]);
    // Record one approval so the CR has an active approval for the stale-revoke test
    const apprK = await runAsApp("SELECT gitwire_policy.record_policy_approval($1, $2, $3) as id", [crKId, ruleId, approver1Pid]);
    const apprKId = apprK.rows[0].id;

    // GET /change-requests/:id/approvals/evaluate — observeAuthorize runs
    const evalResp = await request(httpApp).get("/api/policy/change-requests/" + crKId + "/approvals/evaluate");
    check("HTTP GET /evaluate returns 200", evalResp.status === 200, "status=" + evalResp.status + " body=" + JSON.stringify(evalResp.body).slice(0,200));

    // revoke/expire 409 mapping: supply a stale lifecycle revision -> 409 (not 500)
    const staleRevoke = await request(httpApp).post("/api/policy/approvals/" + apprKId + "/revoke").send({ expectedLifecycleRevision: 99999, reason: "stale-http-test" });
    check("HTTP revoke stale revision -> 409", staleRevoke.status === 409, "status=" + staleRevoke.status);

    // Observer-bypass-denial: even if observeAuthorize would deny (principal lacks the
    // permission), the route proceeds (observe-only), but the DB function independently
    // enforces actor eligibility. Prove a principal WITHOUT the admin role cannot record
    // an approval via HTTP — the DB rejects it regardless of the observer decision.
    const noRoleApp = express();
    noRoleApp.use(express.json());
    // Stub: principal with NO permissions (observeAuthorize will compute deny, but observe-only)
    noRoleApp.use("/api/policy", (req, res, next) => {
      req.auth = { principalId: nonAdminPid, permissions: [] };
      next();
    }, governedPolicyRouter);
    const denyRecord = await request(noRoleApp).post("/api/policy/change-requests/" + crKId + "/approvals").send({ approvalRuleId: ruleId });
    // The DB function rejects the non-admin approver; observe-only did not bypass it.
    check("observer denial does not bypass DB write auth (non-admin record rejected)", denyRecord.status >= 400 && denyRecord.status < 500, "status=" + denyRecord.status);

    // Approval-list GET: returns 200 with the recorded approval
    const apprList = await request(httpApp).get("/api/policy/change-requests/" + crKId + "/approvals");
    check("HTTP GET /approvals list returns 200", apprList.status === 200, "status=" + apprList.status);

    // Stale-expire HTTP 409 path: expire with a stale lifecycle revision -> 409
    const staleExpire = await request(httpApp).post("/api/policy/approvals/" + apprKId + "/expire").send({ expectedLifecycleRevision: 99999 });
    check("HTTP expire stale revision -> 409", staleExpire.status === 409, "status=" + staleExpire.status);

    // Observer-decision-recorded: ALL THREE GET routes ran observeAuthorize, each
    // recording a decision to auth_decision_log. Confirm a row was inserted for each
    // of the three distinct permission tokens.
    const evalDecisions = Number((await pool.query("SELECT count(*)::int n FROM gitwire_auth.auth_decision_log WHERE permission = 'policy_approval:evaluate'")).rows[0].n);
    const rulesDecisions = Number((await pool.query("SELECT count(*)::int n FROM gitwire_auth.auth_decision_log WHERE permission = 'policy_approval_rule:read'")).rows[0].n);
    const apprDecisions = Number((await pool.query("SELECT count(*)::int n FROM gitwire_auth.auth_decision_log WHERE permission = 'policy_approval:read'")).rows[0].n);
    check("observer decision recorded: /evaluate (policy_approval:evaluate)", evalDecisions > 0, "count=" + evalDecisions);
    check("observer decision recorded: /approval-rules (policy_approval_rule:read)", rulesDecisions > 0, "count=" + rulesDecisions);
    check("observer decision recorded: /approvals list (policy_approval:read)", apprDecisions > 0, "count=" + apprDecisions);

    // Clean up runtime singleton so it doesn't affect later phases
    try { if (runtimeMod.shutdownRuntime) await runtimeMod.shutdownRuntime(); } catch {}
  }

  // ═══ Phase 20: Rollback + reapply in a SEPARATE clean database ═══════
  // Per binding decision: use a separate clean rollback/reapply DB rather than
  // dropping GP-01 append-only triggers in the primary fixture DB.
  console.log("\n=== Phase 20: Rollback preserves GP-02 (isolated DB) ===");
  const rollbackSql = await readFile(join(ROLLBACK_DIR, "rollback_gp03_approval.sql"), "utf8");
  {
    const rbPort = await pickPort();
    const rbName = "gp03-rb-" + rbPort;
    const rbCid = docker("run", "-d", "--rm", "--name", rbName, "-p", "127.0.0.1:" + rbPort + ":5432", "-e", "POSTGRES_USER=proof", "-e", "POSTGRES_PASSWORD=proof-only", "-e", "POSTGRES_DB=proofdb", "postgres:16-alpine");
    const rbUrl = "postgresql://proof:proof-only@127.0.0.1:" + rbPort + "/proofdb";
    try {
      await waitForReady(rbUrl, 60_000);
      const rbPool = new pg.Pool({ connectionString: rbUrl });
      await applyMigrations(rbPool);

      // Capture the full ACL + all 16 triggers BEFORE rollback
      const allTriggers = ["policy_versions_no_update","policy_versions_no_delete","policy_validation_evidence_no_update","policy_validation_evidence_no_delete","policy_simulation_evidence_no_update","policy_simulation_evidence_no_delete","policy_approval_rules_no_update","policy_approval_rules_no_delete","policy_approvals_no_update","policy_approvals_no_delete","policy_approval_lifecycle_no_update","policy_approval_lifecycle_no_delete","policy_promotion_records_no_update","policy_promotion_records_no_delete","policy_transition_events_no_update","policy_transition_events_no_delete"];
      const { rows: trigBefore } = await rbPool.query("SELECT tgname FROM pg_trigger WHERE tgrelid IN ('gitwire_policy.policy_versions'::regclass,'gitwire_policy.policy_validation_evidence'::regclass,'gitwire_policy.policy_simulation_evidence'::regclass,'gitwire_policy.policy_approval_rules'::regclass,'gitwire_policy.policy_approvals'::regclass,'gitwire_policy.policy_approval_lifecycle'::regclass,'gitwire_policy.policy_promotion_records'::regclass,'gitwire_policy.policy_transition_events'::regclass) AND NOT tgisinternal ORDER BY tgname");
      const trigBeforeNames = trigBefore.map(t => t.tgname).sort();

      const { rows: gp02FnsBefore } = await rbPool.query("SELECT p.oid::regprocedure::text as sig FROM pg_proc p JOIN pg_namespace n ON p.pronamespace = n.oid WHERE n.nspname = 'gitwire_policy' AND p.proname IN ('create_policy_change_request','create_policy_version','select_policy_version','submit_policy_change_request','canonical_jsonb','enforce_append_only') ORDER BY 1");

      // Run rollback (no data cleanup needed — fresh DB has no GP-03 rows; triggers
      // are NOT dropped here, only functions/constraints/columns/grants/ledger)
      await rbPool.query(rollbackSql);

      // GP-02 functions survive
      const { rows: gp02FnsAfter } = await rbPool.query("SELECT p.oid::regprocedure::text as sig FROM pg_proc p JOIN pg_namespace n ON p.pronamespace = n.oid WHERE n.nspname = 'gitwire_policy' AND p.proname IN ('create_policy_change_request','create_policy_version','select_policy_version','submit_policy_change_request','canonical_jsonb','enforce_append_only') ORDER BY 1");
      check("GP-02 functions preserved after rollback", JSON.stringify(gp02FnsBefore.map(r => r.sig)) === JSON.stringify(gp02FnsAfter.map(r => r.sig)));

      // GP-03 functions gone
      const gp03Gone = (await rbPool.query("SELECT count(*)::int n FROM pg_proc p JOIN pg_namespace n ON p.pronamespace = n.oid WHERE n.nspname = 'gitwire_policy' AND p.proname IN ('create_policy_approval_rule','record_policy_approval','revoke_policy_approval','expire_policy_approval','evaluate_approval_sufficiency','approve_policy_change_request')")).rows[0].n;
      check("all 6 GP-03 functions dropped after rollback", gp03Gone === 0);

      // GP-03 columns gone
      const ruleRevGone = (await rbPool.query("SELECT count(*)::int n FROM information_schema.columns WHERE table_schema='gitwire_policy' AND table_name='policy_approval_rules' AND column_name='rule_revision'")).rows[0].n;
      check("rule_revision column dropped after rollback", ruleRevGone === 0);

      // Ledger removed
      const ledger46 = (await rbPool.query("SELECT count(*)::int n FROM schema_migrations WHERE version = '046_gp03_approval_functions.sql'")).rows[0].n;
      check("046 ledger removed", ledger46 === 0);

      // Cross-schema grants revoked
      const xSchemaAfter = (await rbPool.query("SELECT has_schema_privilege('gitwire_policy_fn_owner','gitwire_auth','USAGE') as has")).rows[0].has;
      check("cross-schema USAGE on gitwire_auth revoked after rollback", xSchemaAfter === false);

      // public.repositories + public.installations grants revoked (binding adjustment 1)
      const repoGrantAfter = (await rbPool.query("SELECT has_column_privilege('gitwire_policy_fn_owner','public.repositories','github_id','SELECT') as has")).rows[0].has;
      check("public.repositories grant revoked after rollback", repoGrantAfter === false);
      const installGrantAfter = (await rbPool.query("SELECT has_column_privilege('gitwire_policy_fn_owner','public.installations','account_login','SELECT') as has")).rows[0].has;
      check("public.installations grant revoked after rollback", installGrantAfter === false);

      // ALL 16 append-only triggers preserved through rollback (not dropped)
      const { rows: trigAfter } = await rbPool.query("SELECT tgname FROM pg_trigger WHERE tgrelid IN ('gitwire_policy.policy_versions'::regclass,'gitwire_policy.policy_validation_evidence'::regclass,'gitwire_policy.policy_simulation_evidence'::regclass,'gitwire_policy.policy_approval_rules'::regclass,'gitwire_policy.policy_approvals'::regclass,'gitwire_policy.policy_approval_lifecycle'::regclass,'gitwire_policy.policy_promotion_records'::regclass,'gitwire_policy.policy_transition_events'::regclass) AND NOT tgisinternal ORDER BY tgname");
      const trigAfterNames = trigAfter.map(t => t.tgname).sort();
      check("all 16 append-only triggers preserved through rollback", JSON.stringify(trigBeforeNames) === JSON.stringify(trigAfterNames) && trigBeforeNames.length === 16, "count=" + trigAfterNames.length);

      // Reapply
      await applyMigrations(rbPool);
      const finalLedger = (await rbPool.query("SELECT count(*)::int n FROM schema_migrations")).rows[0].n;
      check("ledger = 46 after reapply", finalLedger === 46);

      // GP-03 functions restored
      const gp03Restored = (await rbPool.query("SELECT count(*)::int n FROM pg_proc p JOIN pg_namespace n ON p.pronamespace = n.oid WHERE n.nspname = 'gitwire_policy' AND p.proname IN ('create_policy_approval_rule','record_policy_approval','revoke_policy_approval','expire_policy_approval','evaluate_approval_sufficiency','approve_policy_change_request')")).rows[0].n;
      check("all 6 GP-03 functions restored after reapply", gp03Restored === 6);

      // GP-03 columns restored
      const ruleRevRestored = (await rbPool.query("SELECT count(*)::int n FROM information_schema.columns WHERE table_schema='gitwire_policy' AND table_name='policy_approval_rules' AND column_name='rule_revision'")).rows[0].n;
      check("rule_revision column restored after reapply", ruleRevRestored === 1);

      // Cross-schema grants restored
      const xSchemaRestored = (await rbPool.query("SELECT has_schema_privilege('gitwire_policy_fn_owner','gitwire_auth','USAGE') as has")).rows[0].has;
      check("cross-schema USAGE on gitwire_auth restored after reapply", xSchemaRestored === true);

      // public.repositories + public.installations grants restored
      const repoGrantRestored = (await rbPool.query("SELECT has_column_privilege('gitwire_policy_fn_owner','public.repositories','github_id','SELECT') as has")).rows[0].has;
      check("public.repositories grant restored after reapply", repoGrantRestored === true);
      const installGrantRestored = (await rbPool.query("SELECT has_column_privilege('gitwire_policy_fn_owner','public.installations','account_login','SELECT') as has")).rows[0].has;
      check("public.installations grant restored after reapply", installGrantRestored === true);

      // All 16 triggers STILL present after reapply
      const { rows: trigReapply } = await rbPool.query("SELECT tgname FROM pg_trigger WHERE tgrelid IN ('gitwire_policy.policy_versions'::regclass,'gitwire_policy.policy_validation_evidence'::regclass,'gitwire_policy.policy_simulation_evidence'::regclass,'gitwire_policy.policy_approval_rules'::regclass,'gitwire_policy.policy_approvals'::regclass,'gitwire_policy.policy_approval_lifecycle'::regclass,'gitwire_policy.policy_promotion_records'::regclass,'gitwire_policy.policy_transition_events'::regclass) AND NOT tgisinternal ORDER BY tgname");
      const trigReapplyNames = trigReapply.map(t => t.tgname).sort();
      check("all 16 append-only triggers preserved through rollback+reapply", JSON.stringify(trigBeforeNames) === JSON.stringify(trigReapplyNames) && trigReapplyNames.length === 16);

      // Exact ACL equivalence: reapply must reproduce the COMPLETE grant/owner set
      // as a fresh apply. Compare schema usage, table grants, column grants,
      // function EXECUTE grants, and function owners — across the whole gitwire_policy
      // schema + the cross-schema grants 046 adds.
      const aclQuery = `
        (SELECT 'TABLE' AS kind, grantee, table_schema||'.'||table_name AS obj, string_agg(privilege_type, ',' ORDER BY privilege_type) AS priv
         FROM information_schema.role_table_grants
         WHERE table_schema IN ('gitwire_policy') AND grantee IN ('gitwire_app','gitwire_policy_fn_owner')
         GROUP BY grantee, table_schema, table_name
         ORDER BY 1,2,3,4)
        UNION ALL
        (SELECT 'TABLE' AS kind, grantee, table_schema||'.'||table_name AS obj, string_agg(privilege_type, ',' ORDER BY privilege_type) AS priv
         FROM information_schema.role_table_grants
         WHERE table_schema IN ('gitwire_auth') AND grantee IN ('gitwire_policy_fn_owner')
           AND table_name IN ('auth_principals','auth_roles','auth_principal_roles')
         GROUP BY grantee, table_schema, table_name
         ORDER BY 1,2,3,4)
        UNION ALL
        (SELECT 'COLUMN' AS kind, grantee, table_schema||'.'||table_name||'.'||column_name AS obj, privilege_type AS priv
         FROM information_schema.role_column_grants
         WHERE table_schema IN ('public') AND grantee IN ('gitwire_policy_fn_owner')
           AND table_name IN ('repositories','installations')
         ORDER BY 1,2,3,4)
        ORDER BY 1,2,3,4`;
      const { rows: rbAcl } = await rbPool.query(aclQuery);
      const { rows: priAcl } = await pool.query(aclQuery);
      check("exact ACL equivalence (tables + columns): reapply == fresh apply", JSON.stringify(rbAcl) === JSON.stringify(priAcl), "rb=" + rbAcl.length + " pri=" + priAcl.length);

      // Function EXECUTE grants + owners equivalence (all 10 SECURITY DEFINER fns).
      // Use has_function_privilege (authoritative) rather than aclexplode.
      const fnQuery = "SELECT p.proname, pg_get_userbyid(p.proowner) AS owner, has_function_privilege('gitwire_app', p.oid, 'EXECUTE') AS app_exec FROM pg_proc p JOIN pg_namespace n ON p.pronamespace=n.oid WHERE n.nspname='gitwire_policy' AND p.proname IN ('create_policy_change_request','create_policy_version','select_policy_version','submit_policy_change_request','create_policy_approval_rule','record_policy_approval','revoke_policy_approval','expire_policy_approval','evaluate_approval_sufficiency','approve_policy_change_request') ORDER BY p.proname";
      const { rows: rbFns } = await rbPool.query(fnQuery);
      const { rows: priFns } = await pool.query(fnQuery);
      check("exact function owner + EXECUTE-grant equivalence: reapply == fresh apply", JSON.stringify(rbFns) === JSON.stringify(priFns), "rb=" + rbFns.length + " pri=" + priFns.length);
      // All 10 functions owned by gitwire_policy_fn_owner and executable by gitwire_app
      const allOwned = rbFns.every(f => f.owner === "gitwire_policy_fn_owner");
      const allExec = rbFns.every(f => f.app_exec === true);
      check("all 10 functions OWNER gitwire_policy_fn_owner", allOwned);
      check("all 10 functions EXECUTE granted to gitwire_app", allExec);

      // Schema USAGE grant equivalence
      const rbUsage = (await rbPool.query("SELECT has_schema_privilege('gitwire_policy_fn_owner','gitwire_auth','USAGE') as h")).rows[0].h;
      const priUsage = (await pool.query("SELECT has_schema_privilege('gitwire_policy_fn_owner','gitwire_auth','USAGE') as h")).rows[0].h;
      check("schema USAGE equivalence: reapply == fresh apply", rbUsage === priUsage);

      await rbPool.end();
    } finally {
      try { docker("rm", "-f", rbCid); } catch {}
    }
  }

  // ═══ Phase 20b: Collision gates — forward migration must FAIL on pre-existing objects ══
  console.log("\n=== Phase 20b: Forward migration collision gates ===");
  {
    const colPort = await pickPort();
    const colName = "gp03-col-" + colPort;
    const colCid = docker("run", "-d", "--rm", "--name", colName, "-p", "127.0.0.1:" + colPort + ":5432", "-e", "POSTGRES_USER=proof", "-e", "POSTGRES_PASSWORD=proof-only", "-e", "POSTGRES_DB=proofdb", "postgres:16-alpine");
    const colUrl = "postgresql://proof:proof-only@127.0.0.1:" + colPort + "/proofdb";
    try {
      await waitForReady(colUrl, 60_000);
      const colPool = new pg.Pool({ connectionString: colUrl });
      await applyMigrations(colPool);
      // Now 046 is applied. Re-running 046 raw must FAIL (pre-existing objects).
      const mig046 = await readFile(join(MIGRATIONS_DIR, "046_gp03_approval_functions.sql"), "utf8");
      let wholeMigCollision = false;
      try { await colPool.query(mig046); } catch (e) { wholeMigCollision = /already exists|cannot change|duplicate/i.test(e.message); }
      check("forward migration fails on pre-existing objects (whole re-run)", wholeMigCollision);
      await colPool.end();
    } finally {
      try { docker("rm", "-f", colCid); } catch {}
    }
  }

  // ═══ Phase 20c: Granular collision gates (column, constraint, function) ══
  // Each sub-test uses a FRESH container so a partial-migration failure in one
  // does not corrupt the state of another (the rollback script assumes a full
  // 046-applied state, which a partial failure violates).
  console.log("\n=== Phase 20c: Granular forward-migration collision gates ===");
  const mig046 = await readFile(join(MIGRATIONS_DIR, "046_gp03_approval_functions.sql"), "utf8");
  for (const [label, preApplyDDL, matchRe] of [
    ["COLUMN", "ALTER TABLE gitwire_policy.policy_approval_rules ADD COLUMN rule_revision bigint NOT NULL DEFAULT 0", /already exists/i],
    ["CONSTRAINT", "ALTER TABLE gitwire_policy.policy_approval_rules ADD CONSTRAINT par_self_approval_check CHECK (self_approval_prohibited = true)", /already exists/i],
    ["FUNCTION", "CREATE FUNCTION gitwire_policy.record_policy_approval(uuid, uuid, uuid) RETURNS uuid LANGUAGE sql AS $$ SELECT NULL::uuid $$", /already exists|cannot change/i],
  ]) {
    const colPort = await pickPort();
    const colName = "gp03-col-" + label.toLowerCase() + "-" + colPort;
    const colCid = docker("run", "-d", "--rm", "--name", colName, "-p", "127.0.0.1:" + colPort + ":5432", "-e", "POSTGRES_USER=proof", "-e", "POSTGRES_PASSWORD=proof-only", "-e", "POSTGRES_DB=proofdb", "postgres:16-alpine");
    const colUrl = "postgresql://proof:proof-only@127.0.0.1:" + colPort + "/proofdb";
    try {
      await waitForReady(colUrl, 60_000);
      const colPool = new pg.Pool({ connectionString: colUrl });
      // Apply migrations 001-045 only (stop before 046) by applying all then
      // rolling back 046 to a clean pre-046 state.
      await applyMigrations(colPool);
      await colPool.query("DELETE FROM schema_migrations WHERE version = '046_gp03_approval_functions.sql'");
      await colPool.query(await readFile(join(ROLLBACK_DIR, "rollback_gp03_approval.sql"), "utf8"));
      // Pre-apply the colliding object, then run the full 046 migration -> must fail
      await colPool.query(preApplyDDL);
      let collided = false;
      try { await colPool.query(mig046); } catch (e) { collided = matchRe.test(e.message); }
      check("collision gate: pre-existing " + label + " aborts migration", collided);
      await colPool.end();
    } finally {
      try { docker("rm", "-f", colCid); } catch {}
    }
  }

  // ═══ Phase 21: CASCADE check ════════════════════════════════════════
  console.log("\n=== Phase 21: CASCADE check ===");
  const migContent = await readFile(join(MIGRATIONS_DIR, "046_gp03_approval_functions.sql"), "utf8");
  check("migration no CASCADE", !/\bCASCADE\b/i.test(migContent.replace(/--.*/g, "")));
  check("rollback no CASCADE", !/\bCASCADE\b/i.test(rollbackSql.replace(/--.*/g, "")));

  // ═══ Phase 22: Fail-closed CREATE ═══════════════════════════════════
  console.log("\n=== Phase 22: Fail-closed function creation ===");
  check("migration uses plain CREATE FUNCTION", !/CREATE\s+OR\s+REPLACE/i.test(migContent));
  // Forward migration must be fail-closed: no IF NOT EXISTS / DROP IF EXISTS / OR REPLACE
  check("migration no ADD COLUMN IF NOT EXISTS", !/ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS/i.test(migContent));
  check("migration no ADD CONSTRAINT IF NOT EXISTS", !/ADD\s+CONSTRAINT\s+IF\s+NOT\s+EXISTS/i.test(migContent));
  check("migration no DROP ... IF EXISTS", !/DROP\s+(COLUMN|CONSTRAINT|FUNCTION)\s+IF\s+EXISTS/i.test(migContent));

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
console.log("forced process exit: yes (runtime HTTP pools remain open after observer phase)");
console.log("\n=== GP-03 Approval Proof: " + passed + " passed, " + failed + " failed ===");
process.exit(proofFailed || failed > 0 || cleanupFailed ? 1 : 0);
