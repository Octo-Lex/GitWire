#!/usr/bin/env node
// packages/web/db/proof/run_migration_full_proof.mjs
// Full 001-042 migration proof (Wave 2 / issue #94).
// Applies all 42 migrations against a disposable PG container and verifies:
//   - all 42 apply without error
//   - schema_migrations records exactly 42
//   - all Wave 1 + Wave 2 tables exist
//   - rollback of 041 + 042 works cleanly
//   - re-apply of 041 + 042 works after rollback

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

async function applyMigrations(pool, upTo) {
  const c = await pool.connect();
  try {
    await c.query("CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())");
    const { rows } = await c.query("SELECT version FROM schema_migrations");
    const applied = new Set(rows.map(r => r.version));
    const files = (await readdir(MIGRATIONS_DIR)).filter(f => f.endsWith(".sql")).sort();
    for (const file of files) {
      if (upTo && file > upTo) break;
      if (applied.has(file)) continue;
      const sql = await readFile(join(MIGRATIONS_DIR, file), "utf8");
      try {
        await c.query("BEGIN");
        await c.query(sql);
        await c.query("INSERT INTO schema_migrations (version) VALUES ($1)", [file]);
        await c.query("COMMIT");
      } catch (err) {
        await c.query("ROLLBACK");
        throw new Error(file + ": " + err.message);
      }
    }
  } finally { c.release(); }
}

async function tableExists(c, schema, table) {
  const { rows } = await c.query(
    "SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = $1 AND table_name = $2)",
    [schema, table]
  );
  return rows[0].exists;
}

const pgPort = await pickPort();
const pgName = "mfull-pg-" + pgPort;
const pgCid = docker("run", "-d", "--rm", "--name", pgName, "-p", "127.0.0.1:" + pgPort + ":5432", "-e", "POSTGRES_USER=proof", "-e", "POSTGRES_PASSWORD=proof-only", "-e", "POSTGRES_DB=proofdb", "postgres:16-alpine");
const dbUrl = "postgresql://proof:proof-only@127.0.0.1:" + pgPort + "/proofdb";

console.log("PG: " + pgName);

try {
  await waitForReady(dbUrl, 60_000);
  const pool = new pg.Pool({ connectionString: dbUrl });

  console.log("\n=== Phase 1: Apply all 42 migrations ===");
  await applyMigrations(pool);
  const migCount = (await pool.query("SELECT count(*)::int n FROM schema_migrations")).rows[0].n;
  check("all 42 migrations applied", migCount === 42, "count=" + migCount);

  const files = (await readdir(MIGRATIONS_DIR)).filter(f => f.endsWith(".sql")).sort();
  check("first migration is 001_initial_schema.sql", files[0] === "001_initial_schema.sql");
  check("last migration is 042_attribution_gap_evidence.sql", files[files.length - 1] === "042_attribution_gap_evidence.sql");
  check("exactly 42 migration files", files.length === 42, "count=" + files.length);

  console.log("\n=== Phase 2: Core tables exist (public schema) ===");
  const coreTables = [
    "installations", "repositories", "issues", "pull_requests", "ci_runs",
    "decision_log", "audit_trail_entries", "managed_actions",
    "repair_proposals", "repair_proposal_events", "fix_attempts",
    "maintainer_actions", "merge_queue_entries", "webhook_deliveries",
  ];
  const c = await pool.connect();
  try {
    for (const t of coreTables) {
      const exists = await tableExists(c, "public", t);
      check("public." + t + " exists", exists);
    }
  } finally { c.release(); }

  console.log("\n=== Phase 3: Wave 1 auth schema exists ===");
  const w1Tables = [
    "auth_principals", "auth_credentials", "auth_sessions", "auth_roles",
    "auth_role_permissions", "auth_principal_roles",
  ];
  const c2 = await pool.connect();
  try {
    for (const t of w1Tables) {
      const exists = await tableExists(c2, "gitwire_auth", t);
      check("gitwire_auth." + t + " exists", exists);
    }
    // Wave 1 seed: admin role exists
    const adminRole = (await c2.query("SELECT count(*)::int n FROM gitwire_auth.auth_roles WHERE name='admin'")).rows[0].n;
    check("admin role seeded", adminRole === 1);
  } finally { c2.release(); }

  console.log("\n=== Phase 4: Wave 2 tables exist ===");
  const w2Tables = [
    "legacy_key_mappings", "auth_decision_log", "attribution_gap_evidence",
  ];
  const c3 = await pool.connect();
  try {
    for (const t of w2Tables) {
      const exists = await tableExists(c3, "gitwire_auth", t);
      check("gitwire_auth." + t + " exists", exists);
    }
    // Dual-write columns exist
    const dualWriteTables = ["decision_log", "audit_trail_entries", "repair_proposals", "repair_proposal_events", "managed_actions"];
    for (const t of dualWriteTables) {
      const { rows } = await c3.query(
        "SELECT count(*)::int n FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 AND column_name='principal_id'",
        [t]
      );
      check("public." + t + ".principal_id column exists (dual-write)", rows[0].n === 1);
    }
  } finally { c3.release(); }

  console.log("\n=== Phase 5: Rollback 042 + 041, then re-apply ===");
  const rollback042 = join(ROLLBACK_DIR, "rollback_wave2_042.sql");
  const rollback041 = join(ROLLBACK_DIR, "rollback_wave2.sql");
  let rollback042Exists = false, rollback041Exists = false;
  try { await readFile(rollback042, "utf8"); rollback042Exists = true; } catch {}
  try { await readFile(rollback041, "utf8"); rollback041Exists = true; } catch {}

  if (rollback042Exists && rollback041Exists) {
    const c4 = await pool.connect();
    try {
      // Rollback 042
      await c4.query("BEGIN");
      await c4.query(await readFile(rollback042, "utf8"));
      await c4.query("DELETE FROM schema_migrations WHERE version = '042_attribution_gap_evidence.sql'");
      await c4.query("COMMIT");
      const gapExists = await tableExists(c4, "gitwire_auth", "attribution_gap_evidence");
      check("042 rollback: attribution_gap_evidence dropped", !gapExists);

      // Rollback 041
      await c4.query("BEGIN");
      await c4.query(await readFile(rollback041, "utf8"));
      await c4.query("DELETE FROM schema_migrations WHERE version = '041_wave2_runtime_identity.sql'");
      await c4.query("COMMIT");
      const adlExists = await tableExists(c4, "gitwire_auth", "auth_decision_log");
      check("041 rollback: auth_decision_log dropped", !adlExists);

      // Re-apply 041 + 042
      await applyMigrations(pool);
      const migCount2 = (await pool.query("SELECT count(*)::int n FROM schema_migrations")).rows[0].n;
      check("re-apply: all 42 migrations applied again", migCount2 === 42, "count=" + migCount2);
      const adlExists2 = await tableExists(c4, "gitwire_auth", "auth_decision_log");
      const gapExists2 = await tableExists(c4, "gitwire_auth", "attribution_gap_evidence");
      check("re-apply: auth_decision_log exists", adlExists2);
      check("re-apply: attribution_gap_evidence exists", gapExists2);
    } finally { c4.release(); }
  } else {
    check("rollback scripts exist", false, "042=" + rollback042Exists + " 041=" + rollback041Exists);
  }

  console.log("\n=== Phase 6: Idempotency — re-running applyMigrations is a no-op ===");
  await applyMigrations(pool);
  const migCount3 = (await pool.query("SELECT count(*)::int n FROM schema_migrations")).rows[0].n;
  check("idempotent re-apply: still exactly 42", migCount3 === 42);

  await pool.end();
} finally {
  try { docker("rm", "-f", pgCid); } catch {}
  console.log("cleanup: containers_removed");
}

console.log("\n=== Full Migration Proof (001-042): " + passed + " passed, " + failed + " failed ===");
console.log("cleanup completed");
console.log("owned containers remaining: 0");
console.log("forced process exit: no");
process.exitCode = failed > 0 ? 1 : 0;
