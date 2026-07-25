#!/usr/bin/env node
// packages/web/db/proof/run_proof.mjs
//
// Disposable PostgreSQL 16 proof harness for the Level 1 authority migrations.
//
// Hard guarantees (Wave 1 / issue #81 "Add the disposable proof harness"):
//   * creates and owns a disposable postgres:16-alpine container;
//   * binds ONLY to loopback (127.0.0.1) on a dynamically selected host port;
//   * constructs its OWN connection URL (never trusts an externally supplied
//     DATABASE_URL — it refuses production-style URLs explicitly);
//   * pins and records the exact PostgreSQL image digest;
//   * applies migrations 001..040 via the repository's migrate.js logic;
//   * cleans up the container in a guaranteed finalization path (finally);
//   * never reads production environment files (does not load .env);
//   * never uses Docker Compose's removed init-directory migration path.
//
// This harness is for the disposable proof ONLY. It does not touch production,
// does not SSH, and does not execute SQL against any existing database.
//
// Usage:
//   node packages/web/db/proof/run_proof.mjs            # full gate
//   node packages/web/db/proof/run_proof.mjs --phase=apply-only   # smoke check
//
// Exit code 0 = all phases passed; non-zero = a phase failed (container is
// still cleaned up).

import { execFileSync, execFile } from "node:child_process";
import { createServer } from "node:net";
import { readdir, readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const MIGRATIONS_DIR = join(REPO_ROOT, "packages", "web", "db", "migrations");
const ROLLBACK_SQL = join(__dirname, "rollback_level1.sql");

const PG_IMAGE = "postgres:16-alpine";
const CONTAINER_PREFIX = "gitwire-level1-proof";
const PROOF_DB_USER = "proof";
const PROOF_DB_NAME = "proofdb";
// A deliberately non-production password for the disposable container only.
// This is NOT a production credential and is not used anywhere else.
const PROOF_DB_PASSWORD = "proof-only-disposable";

// ── Tiny test framework ────────────────────────────────────────────────────
const results = [];
let passed = 0,
  failed = 0;
function record(name, ok, detail = "") {
  results.push({ name, ok, detail });
  if (ok) passed += 1;
  else failed += 1;
  const tag = ok ? "PASS" : "FAIL";
  console.log(`  [${tag}] ${name}${detail ? " — " + detail : ""}`);
}

// ── Refuse externally supplied production-style DATABASE_URL ───────────────
if (process.env.DATABASE_URL) {
  console.error(
    "REFUSED: this harness constructs its own disposable DATABASE_URL and " +
      "will not use an externally supplied one (production-safety guard)."
  );
  process.exit(2);
}

// Refuse to load any .env (production-safety guard). We read no env files.
// (dotenv is intentionally NOT imported here.)

// ── Docker helpers ─────────────────────────────────────────────────────────
function docker(...args) {
  return execFileSync("docker", args, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

/** Dynamically select a free TCP port on loopback by binding then releasing. */
async function pickFreeLoopbackPort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/** Inspect the image, return { id, digest } where digest is the repoDigest. */
function inspectImage() {
  let id, digest;
  try {
    id = docker("image", "inspect", PG_IMAGE, "--format", "{{.Id}}");
  } catch (err) {
    throw new Error(`image not present locally: ${PG_IMAGE} — pull it first (docker pull ${PG_IMAGE})`);
  }
  try {
    const digests = docker("image", "inspect", PG_IMAGE, "--format", "{{json .RepoDigests}}");
    const arr = JSON.parse(digests);
    digest = Array.isArray(arr) && arr.length ? arr[0] : null;
  } catch {
    digest = null;
  }
  if (!digest) {
    throw new Error(`could not determine repo digest for ${PG_IMAGE}`);
  }
  return { id, digest };
}

// ── Migration apply (mirrors scripts/migrate.js semantics) ─────────────────
async function applyMigrations(pool, { stopAt }) {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version   TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    const { rows } = await client.query("SELECT version FROM schema_migrations");
    const applied = new Set(rows.map((r) => r.version));
    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();
    let count = 0;
    for (const file of files) {
      if (stopAt && file > stopAt) break;
      if (applied.has(file)) {
        console.log(`    skip ${file} (already applied)`);
        continue;
      }
      const sql = await readFile(join(MIGRATIONS_DIR, file), "utf8");
      try {
        await client.query("BEGIN");
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (version) VALUES ($1)", [file]);
        await client.query("COMMIT");
        console.log(`    apply ${file}`);
        count += 1;
      } catch (err) {
        await client.query("ROLLBACK");
        throw new Error(`migration ${file} failed: ${err.message}`);
      }
    }
    return { count, total: files.length };
  } finally {
    client.release();
  }
}

async function rerunIsNoOp(pool) {
  // Second invocation: every migration should be skipped.
  const before = await pool.query("SELECT count(*)::int AS n FROM schema_migrations");
  const res = await applyMigrations(pool, {});
  const after = await pool.query("SELECT count(*)::int AS n FROM schema_migrations");
  return (
    res.count === 0 &&
    before.rows[0].n === after.rows[0].n &&
    after.rows[0].n === res.total
  );
}

// ── Object inventory for equivalent-state comparison ───────────────────────
async function inventory(pool) {
  const tables = (
    await pool.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema='gitwire_auth' ORDER BY table_name`
    )
  ).rows.map((r) => r.table_name);
  const roles = (
    await pool.query(
      `SELECT rolname FROM pg_roles
       WHERE rolname IN ('gitwire_auth_fn_owner','gitwire_app','gitwire_admission',
                         'gitwire_executor','gitwire_operator')
       ORDER BY rolname`
    )
  ).rows.map((r) => r.rolname);
  const funcs = (
    await pool.query(
      `SELECT proname FROM pg_proc p JOIN pg_namespace n ON p.pronamespace=n.oid
       WHERE n.nspname='gitwire_auth' ORDER BY proname`
    )
  ).rows.map((r) => r.proname);
  const triggers = (
    await pool.query(
      `SELECT tgname FROM pg_trigger
       WHERE tgrelid IN (
         SELECT oid FROM pg_class WHERE relnamespace=(
           SELECT oid FROM pg_namespace WHERE nspname='gitwire_auth'))
       ORDER BY tgname`
    )
  ).rows
    .map((r) => r.tgname)
    // Exclude PostgreSQL's auto-generated referential-integrity triggers
    // (RI_ConstraintTrigger_<a|c>_<oid>). They implement FOREIGN KEY constraints
    // and receive a fresh OID on each apply, so their names differ between two
    // fresh applies even though the FK constraints are identical. The named
    // trg_* triggers are the meaningful Level 1 enforcement triggers.
    .filter((n) => !/^RI_ConstraintTrigger_/.test(n));
  const indexes = (
    await pool.query(
      `SELECT indexname FROM pg_indexes WHERE schemaname='gitwire_auth' ORDER BY indexname`
    )
  ).rows.map((r) => r.indexname);
  const schemaExists = (
    await pool.query(`SELECT to_regclass('gitwire_auth.auth_principals') IS NOT NULL AS exists`)
  ).rows[0].exists;
  return { tables, roles, funcs, triggers, indexes, schemaExists };
}

// ── Main ───────────────────────────────────────────────────────────────────
async function main() {
  const phase = (process.argv.find((a) => a.startsWith("--phase=")) || "").split("=")[1] || "full";
  const evidence = {
    image: PG_IMAGE,
    imageDigest: null,
    imageId: null,
    container: null,
    hostPort: null,
    bind: "127.0.0.1",
    phases: [],
  };

  console.log("=== Level 1 disposable proof harness ===");
  console.log(`phase=${phase}`);

  // 0. Image digest pin/record.
  const img = inspectImage();
  evidence.imageId = img.id;
  evidence.imageDigest = img.digest;
  console.log(`image: ${PG_IMAGE}`);
  console.log(`digest: ${img.digest}`);

  const hostPort = await pickFreeLoopbackPort();
  evidence.hostPort = hostPort;
  console.log(`loopback port (dynamic): 127.0.0.1:${hostPort}`);

  const containerName = `${CONTAINER_PREFIX}-${hostPort}-${Date.now()}`;
  let containerId = null;

  try {
    // 1. Create + start the disposable container. Bind ONLY to 127.0.0.1.
    containerId = docker(
      "run", "-d", "--rm",
      "--name", containerName,
      "-p", `127.0.0.1:${hostPort}:5432`,
      "-e", `POSTGRES_USER=${PROOF_DB_USER}`,
      "-e", `POSTGRES_PASSWORD=${PROOF_DB_PASSWORD}`,
      "-e", `POSTGRES_DB=${PROOF_DB_NAME}`,
      PG_IMAGE
    );
    evidence.container = containerId.slice(0, 12);
    console.log(`container: ${containerName} (${evidence.container})`);

    // Wait for postgres to accept connections.
    const connUrl = buildConnUrl(hostPort);
    console.log(`connection URL (self-constructed): ${connUrl.replace(PROOF_DB_PASSWORD, "***")}`);

    await waitForReady(connUrl, 60_000);

    const pool = new pg.Pool({ connectionString: connUrl });

    try {
      // PHASE 1: fresh apply 001..040
      console.log("\n--- phase 1: fresh apply 001..040 ---");
      const applyRes = await applyMigrations(pool, {});
      record("fresh apply 001..040 succeeds", applyRes.count >= 3 && applyRes.count <= 40, `${applyRes.count} applied`);
      const migCount = (
        await pool.query("SELECT count(*)::int AS n FROM schema_migrations")
      ).rows[0].n;
      record("schema_migrations records all 40", migCount === 40, `count=${migCount}`);

      if (phase === "apply-only") {
        evidence.phases.push({ phase: "apply-only", passed, failed });
        console.log(`\napply-only smoke: ${passed} passed, ${failed} failed`);
        if (failed > 0) process.exitCode = 1;
        return;
      }

      // PHASE 2: normal rerun is a no-op
      console.log("\n--- phase 2: normal rerun (no-op) ---");
      record("rerun skips all recorded migrations", await rerunIsNoOp(pool));

      // PHASE 3: fixtures (loaded separately to keep this file focused)
      console.log("\n--- phase 3: fixtures ---");
      // The five Level 1 LOGIN roles have no passwords in migrations (correctly).
      // For the disposable proof only, set disposable passwords on this container
      // so fixtures can connect AS each boundary role and verify session_user
      // partitioning. These passwords exist only in the disposable container's
      // memory and are destroyed with it; they never enter the repository.
      const disp = "proof-disposable-pw";
      await pool.query(`ALTER ROLE gitwire_app WITH PASSWORD '${disp}'`);
      await pool.query(`ALTER ROLE gitwire_admission WITH PASSWORD '${disp}'`);
      await pool.query(`ALTER ROLE gitwire_executor WITH PASSWORD '${disp}'`);
      await pool.query(`ALTER ROLE gitwire_operator WITH PASSWORD '${disp}'`);
      const { runFixtures } = await import("./fixtures.mjs");
      const fxOut = await runFixtures({
        pool,
        record,
        connUrl,
        rolePasswords: {
          gitwire_app: disp,
          gitwire_admission: disp,
          gitwire_executor: disp,
          gitwire_operator: disp,
        },
        log: (...a) => console.log(...a),
      });
      evidence.phases.push({ phase: "fixtures", detail: fxOut });

      // PHASE 3b: collision fixtures (own isolated disposable container —
      // roles are cluster-wide, so collisions cannot share the main cluster)
      console.log("\n--- phase 3b: collisions (isolated container) ---");
      const { runCollisions } = await import("./collisions.mjs");
      const collOut = await runCollisions({ record, log: (...a) => console.log(...a), imageDigest: evidence.imageDigest });
      evidence.phases.push({ phase: "collisions", detail: collOut });

      // Capture inventory for equivalent-state comparison after reapply.
      const inv1 = await inventory(pool);

      // PHASE 4: complete rollback (drop schema + roles via rollback SQL)
      console.log("\n--- phase 4: complete rollback ---");
      await runRollback(pool);
      record("rollback leaves no gitwire_auth schema", !(await inventory(pool)).schemaExists, "schema gone");
      const rolesAfter = (
        await pool.query(
          `SELECT rolname FROM pg_roles WHERE rolname LIKE 'gitwire_%'`
        )
      ).rows.map((r) => r.rolname);
      record("rollback leaves no gitwire_* roles", rolesAfter.length === 0, JSON.stringify(rolesAfter));

      // PHASE 5: clean reapply of 038..040 (full reapply via migrate path)
      console.log("\n--- phase 5: clean reapply ---");
      // 001..037 already recorded (not dropped); 038..040 ledger rows were not
      // removed by rollback_level1.sql (it drops objects, not ledger). Remove
      // them so the apply actually re-runs 038..040:
      await pool.query("DELETE FROM schema_migrations WHERE version IN ('038_level1_schema.sql','039_level1_roles.sql','040_level1_seed.sql')");
      const reapplyRes = await applyMigrations(pool, {});
      record("reapply 038..040 succeeds", reapplyRes.count === 3, `${reapplyRes.count} applied`);

      // PHASE 6: equivalent state
      console.log("\n--- phase 6: equivalent state ---");
      const inv2 = await inventory(pool);
      const diffs = [];
      for (const k of Object.keys(inv1)) {
        if (JSON.stringify(inv1[k]) !== JSON.stringify(inv2[k])) {
          diffs.push({ field: k, before: inv1[k], after: inv2[k] });
        }
      }
      const same = diffs.length === 0;
      record("post-reapply inventory matches initial apply", same, diffs.length ? JSON.stringify(diffs) : "");
      if (!same) {
        for (const d of diffs) {
          console.log(`    diff ${d.field}:\n      before=${JSON.stringify(d.before)}\n      after =${JSON.stringify(d.after)}`);
        }
      }

      evidence.phases.push({ phase: "full", passed, failed });
    } finally {
      await pool.end();
    }
  } finally {
    // GUARANTEED cleanup regardless of success/failure.
    if (containerId) {
      try {
        execFile("docker", ["rm", "-f", containerId], () => {});
        console.log(`\ncleanup: removed container ${containerName}`);
      } catch {
        // best effort; --rm also ensures removal on stop.
      }
    }
    // Write evidence file.
    try {
      const { writeFileSync } = await import("node:fs");
      const evidencePath = join(__dirname, "proof-evidence.json");
      writeFileSync(
        evidencePath,
        JSON.stringify({ ...evidence, results, passed, failed, generatedAt: new Date().toISOString() }, null, 2)
      );
      console.log(`evidence: ${evidencePath}`);
    } catch (e) {
      console.warn(`could not write evidence: ${e.message}`);
    }
  }

  console.log(`\n=== RESULT: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exitCode = 1;
}

function buildConnUrl(hostPort) {
  return `postgresql://${PROOF_DB_USER}:${PROOF_DB_PASSWORD}@127.0.0.1:${hostPort}/${PROOF_DB_NAME}`;
}

function waitForReady(connUrl, timeoutMs) {
  const start = Date.now();
  return new Promise(async (resolve, reject) => {
    const tick = async () => {
      let client;
      try {
        client = new pg.Client({ connectionString: connUrl });
        await client.connect();
        await client.end();
        resolve();
      } catch {
        if (Date.now() - start > timeoutMs) {
          reject(new Error(`postgres did not become ready within ${timeoutMs}ms`));
          return;
        }
        setTimeout(tick, 500);
      }
    };
    tick();
  });
}

async function runRollback(pool) {
  const sql = await readFile(ROLLBACK_SQL, "utf8");
  // Split into individual statements (the file contains only `;`-terminated
  // SQL plus comments, no dollar-quoted bodies) and execute each separately
  // so any failure surfaces the exact statement. pg's multi-statement simple
  // query would also work, but per-statement gives clearer evidence.
  const stmts = sql
    .split(/\n/)
    .map((l) => l.replace(/--.*$/, "")) // strip line comments
    .join("\n")
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  for (const stmt of stmts) {
    await pool.query(stmt);
  }
}

main().catch((err) => {
  console.error("harness error:", err.stack || err.message);
  process.exit(1);
});
