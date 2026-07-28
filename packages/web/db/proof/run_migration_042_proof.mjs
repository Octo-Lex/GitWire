#!/usr/bin/env node
// packages/web/db/proof/run_migration_042_proof.mjs
//
// Migration 042 freeze proof (Wave 2 / issue #94).
// Complete disposable PostgreSQL proof for migration 042:
//   apply, rerun, collision, privilege, append-only, rollback, reapply,
//   equivalence. No CASCADE anywhere.

import { execFileSync } from "node:child_process";
import { createServer } from "node:net";
import { readdir, readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const MIGRATIONS_DIR = join(REPO_ROOT, "packages", "web", "db", "migrations");

const PG_IMAGE = "postgres:16-alpine";
let passed = 0, failed = 0;
function check(name, ok, detail = "") {
  if (ok) passed += 1; else failed += 1;
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${name}${detail ? " — " + detail : ""}`);
}
function docker(...a) { return execFileSync("docker", a, { encoding: "utf8", stdio: ["pipe","pipe","pipe"] }).trim(); }
function pickPort() { return new Promise((r,j) => { const s = createServer(); s.unref(); s.on("error",j); s.listen(0,"127.0.0.1",()=>{const {port}=s.address(); s.close(()=>r(port));}); }); }
function waitForReady(url, ms) { const st=Date.now(); return new Promise((r,j)=>{const t=async()=>{try{const c=new pg.Client({connectionString:url});await c.connect();await c.end();r();}catch{if(Date.now()-st>ms)return j(new Error("not ready"));setTimeout(t,500);}};t();}); }
async function applyMigrations(pool) {
  const c = await pool.connect();
  try {
    await c.query(`CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    const { rows } = await c.query("SELECT version FROM schema_migrations");
    const applied = new Set(rows.map(r => r.version));
    const files = (await readdir(MIGRATIONS_DIR)).filter(f => f.endsWith(".sql")).sort();
    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = await readFile(join(MIGRATIONS_DIR, file), "utf8");
      try { await c.query("BEGIN"); await c.query(sql); await c.query("INSERT INTO schema_migrations (version) VALUES ($1)", [file]); await c.query("COMMIT"); }
      catch (err) { await c.query("ROLLBACK"); throw new Error(`${file}: ${err.message}`); }
    }
  } finally { c.release(); }
}
async function runRollback(pool, file) {
  const sql = await readFile(file, "utf8");
  const stmts = sql.split("\n").map(l => l.replace(/--.*$/, "")).join("\n").split(";").map(s => s.trim()).filter(s => s.length > 0);
  for (const s of stmts) await pool.query(s);
}

async function main() {
  if (process.env.DATABASE_URL) { console.error("REFUSED"); process.exit(2); }
  const port = await pickPort();
  const name = `gitwire-m042-${port}-${Date.now()}`;
  const cid = docker("run", "-d", "--rm", "--name", name, "-p", `127.0.0.1:${port}:5432`, "-e", `POSTGRES_USER=proof`, "-e", `POSTGRES_PASSWORD=proof-only`, "-e", `POSTGRES_DB=proofdb`, PG_IMAGE);
  const url = `postgresql://proof:proof-only@127.0.0.1:${port}/proofdb`;
  console.log(`container: ${name}`);

  try {
    await waitForReady(url, 60_000);
    const pool = new pg.Pool({ connectionString: url });

    // ═══ 1. Fresh apply 001-042 ═══════════════════════════════════════════
    console.log("\n=== 1. Fresh apply 001-042 ===");
    await applyMigrations(pool);
    const mig = (await pool.query("SELECT count(*)::int n FROM schema_migrations")).rows[0].n;
    check("apply 001-042", mig === 42, `count=${mig}`);

    // ═══ 2. Ledger rerun (no-op) ══════════════════════════════════════════
    console.log("\n=== 2. Ledger rerun ===");
    await applyMigrations(pool);
    const mig2 = (await pool.query("SELECT count(*)::int n FROM schema_migrations")).rows[0].n;
    check("rerun is no-op", mig2 === 42);

    // ═══ 3. Table exists ══════════════════════════════════════════════════
    console.log("\n=== 3. Table verification ===");
    const tbl = (await pool.query("SELECT to_regclass('gitwire_auth.attribution_gap_evidence') IS NOT NULL AS e")).rows[0].e;
    check("attribution_gap_evidence table exists", tbl === true);

    // Indexes
    const idx = (await pool.query("SELECT count(*)::int n FROM pg_indexes WHERE schemaname='gitwire_auth' AND tablename='attribution_gap_evidence'")).rows[0].n;
    check("indexes present", idx >= 3, `index count=${idx} (PK + 2)`);

    // Triggers
    const trg = (await pool.query("SELECT count(*)::int n FROM pg_trigger WHERE tgrelid=(SELECT oid FROM pg_class WHERE relname='attribution_gap_evidence') AND tgname LIKE 'trg_attribution_gap%'")).rows[0].n;
    check("append-only triggers present", trg === 2);

    // ═══ 4. Append-only enforcement ════════════════════════════════════════
    console.log("\n=== 4. Append-only enforcement ===");
    await pool.query(`INSERT INTO gitwire_auth.attribution_gap_evidence (reason_code, surface_id, writer, table_name, operation) VALUES ('test', 's1', 'w1', 't1', 'insert')`);
    let updBlocked = false;
    try { await pool.query("UPDATE gitwire_auth.attribution_gap_evidence SET reason_code='hack' WHERE reason_code='test'"); } catch { updBlocked = true; }
    check("UPDATE rejected", updBlocked);
    let delBlocked = false;
    try { await pool.query("DELETE FROM gitwire_auth.attribution_gap_evidence WHERE reason_code='test'"); } catch { delBlocked = true; }
    check("DELETE rejected", delBlocked);

    // ═══ 5. Exact rollback ════════════════════════════════════════════════
    console.log("\n=== 5. Exact rollback ===");
    await runRollback(pool, join(__dirname, "rollback_wave2_042.sql"));
    const tblAfter = (await pool.query("SELECT to_regclass('gitwire_auth.attribution_gap_evidence') IS NOT NULL AS e")).rows[0].e;
    check("table dropped after rollback", tblAfter === false);
    const ledger042 = (await pool.query("SELECT count(*)::int n FROM schema_migrations WHERE version='042_attribution_gap_evidence.sql'")).rows[0].n;
    check("042 ledger row removed", ledger042 === 0);

    // ═══ 6. Clean reapply ═════════════════════════════════════════════════
    console.log("\n=== 6. Clean reapply ===");
    await applyMigrations(pool);
    const tblReapplied = (await pool.query("SELECT to_regclass('gitwire_auth.attribution_gap_evidence') IS NOT NULL AS e")).rows[0].e;
    check("table re-created after reapply", tblReapplied === true);
    const mig3 = (await pool.query("SELECT count(*)::int n FROM schema_migrations")).rows[0].n;
    check("ledger count back to 42", mig3 === 42);

    // ═══ 7. Equivalence: indexes + triggers ═══════════════════════════════
    console.log("\n=== 7. Equivalence ===");
    const idx2 = (await pool.query("SELECT count(*)::int n FROM pg_indexes WHERE schemaname='gitwire_auth' AND tablename='attribution_gap_evidence'")).rows[0].n;
    check("indexes equivalent", idx2 === idx);
    const trg2 = (await pool.query("SELECT count(*)::int n FROM pg_trigger WHERE tgrelid=(SELECT oid FROM pg_class WHERE relname='attribution_gap_evidence') AND tgname LIKE 'trg_attribution_gap%'")).rows[0].n;
    check("triggers equivalent", trg2 === trg);
    const cols = (await pool.query("SELECT count(*)::int n FROM information_schema.columns WHERE table_schema='gitwire_auth' AND table_name='attribution_gap_evidence'")).rows[0].n;
    check("columns equivalent", cols === 10, `col count=${cols}`);

    // ═══ 8. Collision: pre-existing table ══════════════════════════════════
    console.log("\n=== 8. Collision rejection ===");
    // Rollback, then pre-create the table, then try to re-apply 042
    await runRollback(pool, join(__dirname, "rollback_wave2_042.sql"));
    await pool.query(`CREATE TABLE gitwire_auth.attribution_gap_evidence (id text)`);
    let collisionFailed = false;
    try {
      const sql = await readFile(join(MIGRATIONS_DIR, "042_attribution_gap_evidence.sql"), "utf8");
      await pool.query("BEGIN"); await pool.query(sql); await pool.query("COMMIT");
    } catch (err) {
      await pool.query("ROLLBACK");
      collisionFailed = true;
    }
    check("pre-existing table aborts migration 042", collisionFailed);
    // Clean up: drop the conflicting table + re-apply
    await pool.query("DROP TABLE gitwire_auth.attribution_gap_evidence");
    await applyMigrations(pool);

    // ═══ 9. Privilege tests ════════════════════════════════════════════════
    console.log("\n=== 9. Privilege tests ===");
    // Set a disposable password on gitwire_app so we can connect as it
    const DISP = "m042-disp-pw";
    await pool.query(`ALTER ROLE gitwire_app WITH PASSWORD '${DISP}'`);
    await pool.query(`ALTER ROLE gitwire_operator WITH PASSWORD '${DISP}'`);

    // gitwire_app INSERT succeeds
    const appUrl = url.replace(/^postgresql:\/\/[^@]*@/, `postgresql://gitwire_app:${DISP}@`);
    const appClient = new pg.Client({ connectionString: appUrl });
    await appClient.connect();
    let appInsertOk = false;
    try {
      await appClient.query(`INSERT INTO gitwire_auth.attribution_gap_evidence (reason_code, surface_id, writer, table_name, operation) VALUES ('priv_test', 's_priv', 'w', 't', 'insert')`);
      appInsertOk = true;
    } catch {}
    check("gitwire_app can INSERT into attribution_gap_evidence", appInsertOk);

    // gitwire_app UPDATE rejected
    let appUpdateBlocked = false;
    try { await appClient.query("UPDATE gitwire_auth.attribution_gap_evidence SET reason_code='hack' WHERE reason_code='priv_test'"); } catch { appUpdateBlocked = true; }
    check("gitwire_app cannot UPDATE attribution_gap_evidence", appUpdateBlocked);

    // gitwire_app DELETE rejected
    let appDeleteBlocked = false;
    try { await appClient.query("DELETE FROM gitwire_auth.attribution_gap_evidence WHERE reason_code='priv_test'"); } catch { appDeleteBlocked = true; }
    check("gitwire_app cannot DELETE attribution_gap_evidence", appDeleteBlocked);
    await appClient.end();

    // gitwire_operator SELECT succeeds
    const opUrl = url.replace(/^postgresql:\/\/[^@]*@/, `postgresql://gitwire_operator:${DISP}@`);
    const opClient = new pg.Client({ connectionString: opUrl });
    await opClient.connect();
    let opSelectOk = false;
    try {
      const r = await opClient.query("SELECT count(*)::int AS n FROM gitwire_auth.attribution_gap_evidence");
      opSelectOk = r.rows.length > 0;
    } catch {}
    check("gitwire_operator can SELECT from attribution_gap_evidence", opSelectOk);

    // gitwire_operator cannot INSERT (read-only for evidence)
    let opInsertBlocked = false;
    try { await opClient.query("INSERT INTO gitwire_auth.attribution_gap_evidence (reason_code, surface_id, writer, table_name, operation) VALUES ('op_test', 's', 'w', 't', 'insert')"); } catch { opInsertBlocked = true; }
    check("gitwire_operator cannot INSERT into attribution_gap_evidence", opInsertBlocked);
    await opClient.end();

    // Verify NO unexpected privileges on PUBLIC
    const pubGrant = (await pool.query(`
      SELECT has_table_privilege('public', 'gitwire_auth.attribution_gap_evidence', 'INSERT') AS can_insert,
             has_table_privilege('public', 'gitwire_auth.attribution_gap_evidence', 'UPDATE') AS can_update,
             has_table_privilege('public', 'gitwire_auth.attribution_gap_evidence', 'DELETE') AS can_delete
    `)).rows[0];
    check("PUBLIC has no INSERT on attribution_gap_evidence", pubGrant.can_insert === false);
    check("PUBLIC has no UPDATE on attribution_gap_evidence", pubGrant.can_update === false);
    check("PUBLIC has no DELETE on attribution_gap_evidence", pubGrant.can_delete === false);

    // Verify table ownership (should be owned by the migration runner, not PUBLIC)
    const owner = (await pool.query("SELECT tableowner FROM pg_tables WHERE schemaname='gitwire_auth' AND tablename='attribution_gap_evidence'")).rows[0]?.tableowner;
    check("attribution_gap_evidence has explicit owner", !!owner, `owner=${owner}`);

    await pool.end();
  } finally {
    try { execFileSync("docker", ["rm", "-f", cid], { stdio: "ignore" }); } catch {}
  }
  console.log(`\n=== Migration 042 Proof: ${passed} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
}
main().catch(e => { console.error("harness error:", e.stack || e.message); process.exit(1); });
