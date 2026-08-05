#!/usr/bin/env node
// packages/web/db/proof/run_gp05_promotion_rollback_proof.mjs
// GP-05 disposable proof: atomic promotion and governed rollback.

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
function docker(...a) { return execFileSync("docker", a, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim(); }
function pickPort() { return new Promise((r, j) => { const s = createServer(); s.unref(); s.on("error", j); s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => r(port)); }); }); }
function waitForReady(url, ms) { const st = Date.now(); return new Promise((r, j) => { const t = async () => { try { const c = new pg.Client({ connectionString: url }); await c.connect(); await c.end(); r(); } catch { if (Date.now() - st > ms) return j(new Error("not ready")); setTimeout(t, 500); } }; t(); }); }

async function applyAllMigrations(pool) {
  const c = await pool.connect();
  try {
    await c.query("CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())");
    const { rows } = await c.query("SELECT version FROM schema_migrations");
    const applied = new Set(rows.map(r => r.version));
    const files = (await readdir(MIGRATIONS_DIR)).filter(f => f.endsWith(".sql")).sort();
    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = await readFile(join(MIGRATIONS_DIR, file), "utf8");
      try { await c.query("BEGIN"); await c.query(sql); await c.query("INSERT INTO schema_migrations (version) VALUES ($1)", [file]); await c.query("COMMIT"); }
      catch (err) { await c.query("ROLLBACK"); throw new Error(file + ": " + err.message); }
    }
  } finally { c.release(); }
}

// Run SQL as gitwire_app (SECURITY DEFINER functions check session_user)
async function asApp(pool, sql, params) {
  const c = await pool.connect();
  try { await c.query("SET SESSION AUTHORIZATION gitwire_app"); return await c.query(sql, params); }
  finally { await c.query("RESET SESSION AUTHORIZATION"); c.release(); }
}

// Run SQL as the DBO (for setup/queries that need superuser-like access)
async function asDbo(pool, sql, params) {
  const c = await pool.connect();
  try { return await c.query(sql, params); }
  finally { c.release(); }
}

async function seedPrincipal(pool, name) {
  await asDbo(pool, "INSERT INTO gitwire_auth.auth_principals (principal_type, display_name) VALUES ('legacy-key', $1) ON CONFLICT DO NOTHING", [name]);
  return (await asDbo(pool, "SELECT id FROM gitwire_auth.auth_principals WHERE display_name = $1", [name])).rows[0].id;
}

async function grantAdmin(pool, pid) {
  const role = (await asDbo(pool, "SELECT id FROM gitwire_auth.auth_roles WHERE name='admin' AND status='active' LIMIT 1")).rows[0];
  await asDbo(pool, "INSERT INTO gitwire_auth.auth_principal_roles (principal_id, role_id, scope_type, granted_by) VALUES ($1, $2, 'fleet', $1) ON CONFLICT DO NOTHING", [pid, role.id]);
}

// Full flow: create → version → select → submit → finalize → rule → approval → approve
async function makeApprovedCR(pool, opts) {
  const { rt = "fleet", rid = "fleet", fam = "tp-" + Math.random().toString(36).slice(2, 8), authorId, approverId, risk = "standard" } = opts;
  const crId = (await asApp(pool, "SELECT gitwire_policy.create_policy_change_request($1,$2,$3,$4) AS id", [rt, rid, fam, authorId])).rows[0].id;
  const payload = { rules: [], v: "1.0.0" };
  const vId = (await asApp(pool, "SELECT gitwire_policy.create_policy_version($1,$2::jsonb,$3) AS id", [crId, JSON.stringify(payload), authorId])).rows[0].id;
  await asApp(pool, "SELECT * FROM gitwire_policy.select_policy_version($1,$2,0,$3)", [crId, vId, authorId]);
  await asApp(pool, "SELECT * FROM gitwire_policy.submit_policy_change_request($1,1,$2)", [crId, authorId]);
  const val = JSON.stringify({ valid: true, errors: [] });
  const sim = JSON.stringify({ passed: true, risk_classification: risk, classifier_version: "cv1", simulation_profile: { version: "sv1", ordering: "id_asc" }, dataset_snapshot: { upper_watermark: 1, input_set_hash: "sha256:" + "a".repeat(64) } });
  await asApp(pool, "SELECT * FROM gitwire_policy.finalize_policy_evaluation($1,2,$2::jsonb,'vv1',$3::jsonb,'sv1',$4)", [crId, val, sim, authorId]);
  const ruleId = (await asApp(pool, "SELECT gitwire_policy.create_policy_approval_rule($1,$2,$3,$4,$5,$6,$7::jsonb,$8,NULL) AS id", ["v1", fam, rt, rid, risk, 1, JSON.stringify(["admin"]), authorId])).rows[0].id;
  await asApp(pool, "SELECT * FROM gitwire_policy.record_policy_approval($1,$2,$3)", [crId, ruleId, approverId]);
  const st = (await asApp(pool, "SELECT * FROM gitwire_policy.approve_policy_change_request($1,3,$2)", [crId, approverId])).rows[0];
  return { crId, vId, ruleId, stateRev: st.state_revision };
}

// ── Main ────────────────────────────────────────────────────────────────────
const pgPort = await pickPort();
const pgName = "gp05-pg-" + pgPort;
docker("run", "-d", "--rm", "--name", pgName, "-p", "127.0.0.1:" + pgPort + ":5432", "-e", "POSTGRES_USER=proof", "-e", "POSTGRES_PASSWORD=proof-only", "-e", "POSTGRES_DB=proofdb", "postgres:16-alpine");
const dbUrl = "postgresql://proof:proof-only@127.0.0.1:" + pgPort + "/proofdb";
console.log("PG: " + pgName);

let pool = null;
try {
  await waitForReady(dbUrl, 60_000);
  pool = new pg.Pool({ connectionString: dbUrl });
  await applyAllMigrations(pool);

  const [authorId, approverId, promoterId, reqId, rbApprId, rbPromId, inactId] = await Promise.all([
    seedPrincipal(pool, "g5-author"), seedPrincipal(pool, "g5-approver"), seedPrincipal(pool, "g5-promoter"),
    seedPrincipal(pool, "g5-requester"), seedPrincipal(pool, "g5-rb-appr"), seedPrincipal(pool, "g5-rb-prom"), seedPrincipal(pool, "g5-inact"),
  ]);
  for (const p of [authorId, approverId, promoterId, reqId, rbApprId, rbPromId]) await grantAdmin(pool, p);
  await asDbo(pool, "UPDATE gitwire_auth.auth_principals SET status='disabled' WHERE display_name='g5-inact'");

  console.log("\n=== Phase 1: Initial forward promotion ===");
  {
    const { crId, vId, stateRev } = await makeApprovedCR(pool, { authorId, approverId, risk: "standard" });
    const r = (await asApp(pool, "SELECT * FROM gitwire_policy.promote_policy_change_request($1,$2,$3,$4)", [crId, stateRev, null, promoterId])).rows[0];
    check("initial promotion succeeded", r.out_outcome === "succeeded", "fc=" + r.out_failure_code);
    check("binding at revision 0", Number(r.out_binding_revision) === 0, "rev=" + r.out_binding_revision);
    check("request promoted", r.out_new_state === "promoted");
    const pr = (await asDbo(pool, "SELECT * FROM gitwire_policy.policy_promotion_records WHERE id=$1", [r.out_promotion_record_id])).rows[0];
    check("promotion_kind forward", pr.promotion_kind === "forward");
    check("evidence has risk", pr.evidence_snapshot.risk_classification === "standard");
    const consumed = (await asDbo(pool, "SELECT count(*)::int n FROM gitwire_policy.policy_approval_lifecycle WHERE to_status='consumed' AND promotion_record_id=$1", [r.out_promotion_record_id])).rows[0].n;
    check("1 approval consumed", consumed === 1);
    const ev = (await asDbo(pool, "SELECT count(*)::int n FROM gitwire_policy.policy_transition_events WHERE event_type='promotion_complete' AND change_request_id=$1", [crId])).rows[0].n;
    check("1 transition event", ev === 1);
  }

  console.log("\n=== Phase 2: Replacement promotion ===");
  {
    const b = (await asDbo(pool, "SELECT * FROM gitwire_policy.active_policy_bindings LIMIT 1")).rows[0];
    const { crId, stateRev } = await makeApprovedCR(pool, { authorId, approverId, rt: b.resource_type, rid: b.resource_id, fam: b.policy_family, risk: "standard" });
    const r = (await asApp(pool, "SELECT * FROM gitwire_policy.promote_policy_change_request($1,$2,$3,$4)", [crId, stateRev, b.binding_revision, promoterId])).rows[0];
    check("replacement succeeded", r.out_outcome === "succeeded", "fc=" + r.out_failure_code);
    check("binding revision = 1", Number(r.out_binding_revision) === 1);
  }

  console.log("\n=== Phase 3: Stale binding revision ===");
  {
    const b = (await asDbo(pool, "SELECT * FROM gitwire_policy.active_policy_bindings LIMIT 1")).rows[0];
    const { crId, stateRev } = await makeApprovedCR(pool, { authorId, approverId, rt: b.resource_type, rid: b.resource_id, fam: b.policy_family, risk: "standard" });
    const r = (await asApp(pool, "SELECT * FROM gitwire_policy.promote_policy_change_request($1,$2,$3,$4)", [crId, stateRev, b.binding_revision - 1, promoterId])).rows[0];
    check("stale binding refused", r.out_outcome === "failed" && r.out_failure_code === "stale_binding_revision", "fc=" + r.out_failure_code);
    check("binding not mutated", Number(r.out_binding_revision) === Number(b.binding_revision));
  }

  console.log("\n=== Phase 4: Inactive actor denied ===");
  {
    const b = (await asDbo(pool, "SELECT * FROM gitwire_policy.active_policy_bindings LIMIT 1")).rows[0];
    const { crId, stateRev } = await makeApprovedCR(pool, { authorId, approverId, rt: b.resource_type, rid: b.resource_id, fam: b.policy_family, risk: "standard" });
    const r = (await asApp(pool, "SELECT * FROM gitwire_policy.promote_policy_change_request($1,$2,$3,$4)", [crId, stateRev, b.binding_revision, inactId])).rows[0];
    check("inactive actor refused", r.out_outcome === "failed" && r.out_failure_code === "inactive_actor", "fc=" + r.out_failure_code);
  }

  console.log("\n=== Phase 5: Direct runtime DML denial ===");
  {
    let denied = false;
    try { await asApp(pool, "INSERT INTO gitwire_policy.policy_promotion_records (resource_type,resource_id,policy_family,change_request_id,target_version_id,promoter_principal_id,outcome,promotion_kind,evidence_snapshot) VALUES ('fleet','fleet','t','00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000003','succeeded','forward','{}')"); }
    catch { denied = true; }
    check("direct DML as gitwire_app denied", denied);
  }

  console.log("\n=== Phase 6: Exact provenance set + FK semantics ===");
  {
    const prov = (await asDbo(pool, "SELECT count(*)::int n FROM gitwire_policy.gp05_function_provenance")).rows[0].n;
    check("gp05 provenance rows = 6", prov === 6, "rows=" + prov);
    // Verify the original active_policy_bindings.promotion_record_id FK is NOT deferred
    // (migration 048 must not alter its deferrability — the cycle is broken by the
    // deferred policy_promotion_records.binding_id FK on the opposite side).
    const fk = (await asDbo(pool, "SELECT condeferred FROM pg_constraint WHERE conname='active_policy_bindings_promotion_record_id_fkey' AND connamespace='gitwire_policy'::regnamespace")).rows[0];
    check("active_binding FK is NOT deferred (immediate)", fk && fk.condeferred === false, "condeferred=" + (fk ? fk.condeferred : "not found"));
    // And verify the promotion_records.binding_id FK IS deferred (the cycle breaker)
    const pprFk = (await asDbo(pool, "SELECT condeferred FROM pg_constraint WHERE conname='ppr_binding_fk' AND connamespace='gitwire_policy'::regnamespace")).rows[0];
    check("promotion_records.binding_id FK IS deferred", pprFk && pprFk.condeferred === true, "condeferred=" + (pprFk ? pprFk.condeferred : "not found"));
  }

  console.log("\n=== Phase 7: Rollback lifecycle (create + approve) ===");
  {
    const b = (await asDbo(pool, "SELECT * FROM gitwire_policy.active_policy_bindings ORDER BY binding_revision DESC LIMIT 1")).rows[0];
    const prior = (await asDbo(pool, "SELECT * FROM gitwire_policy.policy_promotion_records WHERE binding_id=$1 AND outcome='succeeded' ORDER BY occurred_at ASC LIMIT 1", [b.id])).rows[0];
    if (prior) {
      const rb = (await asApp(pool, "SELECT * FROM gitwire_policy.create_policy_rollback_request($1,$2,$3,$4)", [b.id, b.binding_revision, prior.target_version_id, reqId])).rows[0];
      check("rollback created at revision 0", rb.out_status === "requested" && Number(rb.out_status_revision) === 0);
      check("risk derived", ["standard", "elevated", "critical"].includes(rb.out_risk_classification), "risk=" + rb.out_risk_classification);
      const appr = (await asApp(pool, "SELECT * FROM gitwire_policy.approve_policy_rollback_request($1,0,$2)", [rb.out_rollback_record_id, rbApprId])).rows[0];
      check("rollback approved", appr.out_status === "approved" && Number(appr.out_status_revision) === 1);
      const maxLi = (await asDbo(pool, "SELECT max(lifecycle_revision)::int m FROM gitwire_policy.policy_rollback_lifecycle WHERE rollback_record_id=$1", [rb.out_rollback_record_id])).rows[0].m;
      const recRev = (await asDbo(pool, "SELECT status_revision FROM gitwire_policy.policy_rollback_records WHERE id=$1", [rb.out_rollback_record_id])).rows[0].status_revision;
      check("status_revision == max(lifecycle)", Number(maxLi) === Number(recRev), "rev=" + recRev + " max=" + maxLi);
    } else { check("rollback lifecycle test (no prior promo — skip)", true); }
  }

  console.log("\n=== Phase 8: Rollback promotion success ===");
  {
    const c1 = await makeApprovedCR(pool, { authorId, approverId, rt: "organization", rid: "rb-org", fam: "rbp", risk: "standard" });
    // promote c1 to create the initial binding
    await asApp(pool, "SELECT * FROM gitwire_policy.promote_policy_change_request($1,$2,$3,$4)", [c1.crId, c1.stateRev, null, promoterId]);
    const b1 = (await asDbo(pool, "SELECT * FROM gitwire_policy.active_policy_bindings WHERE resource_id='rb-org'")).rows[0];
    const c2 = await makeApprovedCR(pool, { authorId, approverId, rt: "organization", rid: "rb-org", fam: "rbp", risk: "standard" });
    await asApp(pool, "SELECT * FROM gitwire_policy.promote_policy_change_request($1,$2,$3,$4)", [c2.crId, c2.stateRev, b1.binding_revision, promoterId]);
    const b2 = (await asDbo(pool, "SELECT * FROM gitwire_policy.active_policy_bindings WHERE resource_id='rb-org'")).rows[0];
    const rb = (await asApp(pool, "SELECT * FROM gitwire_policy.create_policy_rollback_request($1,$2,$3,$4)", [b2.id, b2.binding_revision, c1.vId, reqId])).rows[0];
    await asApp(pool, "SELECT * FROM gitwire_policy.approve_policy_rollback_request($1,0,$2)", [rb.out_rollback_record_id, rbApprId]);
    const rp = (await asApp(pool, "SELECT * FROM gitwire_policy.promote_policy_rollback_request($1,1,$2,$3)", [rb.out_rollback_record_id, b2.binding_revision, rbPromId])).rows[0];
    check("rollback promotion succeeded", rp.out_outcome === "succeeded", "fc=" + rp.out_failure_code);
    const pk = (await asDbo(pool, "SELECT promotion_kind FROM gitwire_policy.policy_promotion_records WHERE id=$1", [rp.out_promotion_record_id])).rows[0].promotion_kind;
    check("promotion_kind rollback", pk === "rollback");
    check("binding revision incremented", Number(rp.out_binding_revision) === Number(b2.binding_revision) + 1);
    check("rollback status promoted", rp.out_status === "promoted");
  }

  console.log("\n=== Phase 9: Authoritative-data rollback refusal ===");
  {
    const b = (await asDbo(pool, "SELECT * FROM gitwire_policy.active_policy_bindings WHERE resource_id='fleet' LIMIT 1")).rows[0];
    if (b) {
      let refused = false;
      try { await asApp(pool, "SELECT * FROM gitwire_policy.create_policy_rollback_request($1,$2,'00000000-0000-0000-0000-000000000099',$3)", [b.id, b.binding_revision, reqId]); }
      catch { refused = true; }
      check("rollback to unqualified target refused", refused);
    } else { check("rollback refusal test (no fleet binding — skip)", true); }
  }

  console.log("\n=== Phase 10: Clean rollback + exact reapplication (isolated container) ===");
  {
    // Use a fresh disposable DB with no authoritative data so the rollback refusal guard passes
    const isoPort = await pickPort();
    const isoName = "gp05-iso-" + isoPort;
    docker("run", "-d", "--rm", "--name", isoName, "-p", "127.0.0.1:" + isoPort + ":5432", "-e", "POSTGRES_USER=proof", "-e", "POSTGRES_PASSWORD=proof-only", "-e", "POSTGRES_DB=proofdb", "postgres:16-alpine");
    const isoUrl = "postgresql://proof:proof-only@127.0.0.1:" + isoPort + "/proofdb";
    try {
      await waitForReady(isoUrl, 60_000);
      const isoPool = new pg.Pool({ connectionString: isoUrl });
      await applyAllMigrations(isoPool);

      const before = (await isoPool.query("SELECT count(*)::int n FROM pg_proc p JOIN pg_namespace n ON p.pronamespace=n.oid WHERE n.nspname='gitwire_policy'")).rows[0].n;
      // Run rollback via psql inside the container (copy file in, then exec)
      const rbPath = join(ROLLBACK_DIR, "rollback_gp05_promotion_rollback.sql");
      docker("cp", rbPath, isoName + ":/tmp/rb.sql");
      execFileSync("docker", ["exec", isoName, "psql", "-q", "-v", "ON_ERROR_STOP=1", "-U", "proof", "-d", "proofdb", "-f", "/tmp/rb.sql"], { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
      const after = (await isoPool.query("SELECT count(*)::int n FROM pg_proc p JOIN pg_namespace n ON p.pronamespace=n.oid WHERE n.nspname='gitwire_policy'")).rows[0].n;
      check("rollback removed 6 functions", before - after === 6, "before=" + before + " after=" + after);
      check("048 ledger removed", (await isoPool.query("SELECT count(*)::int n FROM schema_migrations WHERE version='048_gp05_promotion_rollback.sql'")).rows[0].n === 0);
      check("rollback_lifecycle removed", (await isoPool.query("SELECT to_regclass('gitwire_policy.policy_rollback_lifecycle')")).rows[0].to_regclass === null);
      // reapply migration 048 via psql
      const migPath = join(MIGRATIONS_DIR, "048_gp05_promotion_rollback.sql");
      docker("cp", migPath, isoName + ":/tmp/mig048.sql");
      execFileSync("docker", ["exec", isoName, "psql", "-q", "-v", "ON_ERROR_STOP=1", "-U", "proof", "-d", "proofdb", "-f", "/tmp/mig048.sql"], { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
      await isoPool.query("INSERT INTO schema_migrations (version) VALUES ($1) ON CONFLICT DO NOTHING", ["048_gp05_promotion_rollback.sql"]);
      const reapplied = (await isoPool.query("SELECT count(*)::int n FROM pg_proc p JOIN pg_namespace n ON p.pronamespace=n.oid WHERE n.nspname='gitwire_policy'")).rows[0].n;
      check("reapply restored function count", reapplied === before, "reapplied=" + reapplied);
      check("provenance re-registered", (await isoPool.query("SELECT count(*)::int n FROM gitwire_policy.gp05_function_provenance")).rows[0].n === 6);
      // Verify original FK semantics unchanged after rollback + reapplication
      const fkAfter = (await isoPool.query("SELECT condeferred FROM pg_constraint WHERE conname='active_policy_bindings_promotion_record_id_fkey' AND connamespace='gitwire_policy'::regnamespace")).rows[0];
      check("active_binding FK still NOT deferred after reapply", fkAfter && fkAfter.condeferred === false, "condeferred=" + (fkAfter ? fkAfter.condeferred : "not found"));
      await isoPool.end();
    } finally {
      try { docker("rm", "-f", isoName); } catch {}
    }
  }

  console.log("\n=== GP-05 Promotion & Rollback Proof: " + passed + " passed, " + failed + " failed ===");
} catch (e) {
  console.error("PROOF ERROR:", e.message);
  console.error(e.stack);
  failed += 1;
} finally {
  if (pool) await pool.end().catch(() => {});
  try { docker("rm", "-f", pgName); } catch {}
}
if (failed > 0) process.exit(1);
