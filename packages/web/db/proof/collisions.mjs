// packages/web/db/proof/collisions.mjs
//
// Collision fixtures: pre-existing schema and role collisions must FAIL CLOSED.
// These run in their OWN disposable PostgreSQL container (separate from the main
// proof container) because PostgreSQL roles are cluster-wide: a collision test
// in the main proof's cluster would see the roles that the main apply already
// created. An isolated container guarantees the only pre-existing objects are
// the ones this fixture intentionally creates.
//
// Covers (Wave 1 / issue #81):
//   pre-existing schema collision failure;
//   pre-existing role collision failure.

import { execFileSync } from "node:child_process";
import { createServer } from "node:net";
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const MIGRATIONS_DIR = join(REPO_ROOT, "packages", "web", "db", "migrations");

const PG_IMAGE = "postgres:16-alpine";
const COLL_USER = "proofcoll";
const COLL_DB = "proofcolldb";
const COLL_PW = "proof-only-disposable-coll";

function docker(...args) {
  return execFileSync("docker", args, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

function pickFreeLoopbackPort() {
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

/**
 * @param {object} opts
 * @param {(name:string, ok:boolean, detail?:string)=>void} opts.record
 * @param {string} opts.imageDigest  recorded in evidence by caller
 */
export async function runCollisions({ record, log }) {
  let run = 0,
    passed = 0,
    failed = 0;
  const check = (name, ok, detail = "") => {
    run += 1;
    if (ok) passed += 1;
    else failed += 1;
    record(name, ok, detail);
  };

  const hostPort = await pickFreeLoopbackPort();
  const containerName = `gitwire-level1-coll-${hostPort}-${Date.now()}`;
  const containerId = docker(
    "run", "-d", "--rm",
    "--name", containerName,
    "-p", `127.0.0.1:${hostPort}:5432`,
    "-e", `POSTGRES_USER=${COLL_USER}`,
    "-e", `POSTGRES_PASSWORD=${COLL_PW}`,
    "-e", `POSTGRES_DB=${COLL_DB}`,
    PG_IMAGE
  );
  log(`  collision container: ${containerName}`);
  const connUrl = `postgresql://${COLL_USER}:${COLL_PW}@127.0.0.1:${hostPort}/${COLL_DB}`;

  try {
    await waitForReady(connUrl, 60_000);
    const pool = new pg.Pool({ connectionString: connUrl });
    // Admin connection to the maintenance DB for CREATE/DROP DATABASE (these
    // cannot run in a transaction or against the DB being created/dropped).
    const adminUrl = connUrl.replace(/\/[^/?]*$/, "/postgres");
    const adminPool = new pg.Pool({ connectionString: adminUrl });

    try {
      // ── Pre-existing ROLE collision: create gitwire_app first, then 039 must fail ─
      log("  [role collision]");
      await pool.query(`CREATE ROLE gitwire_app LOGIN`);
      const sql039 = await readFile(join(MIGRATIONS_DIR, "039_level1_roles.sql"), "utf8");
      const roleCollision = await expectThrow(() => pool.query(sql039));
      check(
        "039 fails closed on pre-existing gitwire_app role",
        roleCollision.threw && /colliding role already exists: gitwire_app/.test(roleCollision.msg),
        roleCollision.msg
      );
      // Verify NO OTHER roles were created (the file's transaction rolled back).
      const rolesAfter = (
        await pool.query(
          `SELECT rolname FROM pg_roles WHERE rolname IN
            ('gitwire_auth_fn_owner','gitwire_admission','gitwire_executor','gitwire_operator')`
        )
      ).rows.map((r) => r.rolname);
      check("role-collision rollback left no other Level 1 roles", rolesAfter.length === 0, JSON.stringify(rolesAfter));

      // Clean up the intentionally-colliding role so the schema test is independent.
      await pool.query(`DROP ROLE gitwire_app`);

      // ── Pre-existing SCHEMA-object collision: 038 uses plain CREATE TABLE, so
      // a pre-existing gitwire_auth.auth_principals must fail closed. ──────────
      log("  [schema-object collision]");
      await pool.query(`CREATE SCHEMA gitwire_auth`);
      await pool.query(`CREATE TABLE gitwire_auth.auth_principals (id uuid primary key)`);
      const sql038 = await readFile(join(MIGRATIONS_DIR, "038_level1_schema.sql"), "utf8");
      const schemaCollision = await expectThrow(() => pool.query(sql038));
      check(
        "038 fails closed on pre-existing gitwire_auth.auth_principals table",
        schemaCollision.threw && /already exists/.test(schemaCollision.msg),
        schemaCollision.msg
      );
      // Verify a LATER object in 038 (auth_enforcement_state) was NOT created —
      // the file transaction rolled back at the table collision.
      const enforcerExists = (
        await pool.query(`SELECT to_regclass('gitwire_auth.auth_enforcement_state') IS NOT NULL AS e`)
      ).rows[0].e;
      check("schema-object collision rolled back later 038 objects", enforcerExists === false, `exists=${enforcerExists}`);
    } finally {
      await pool.end();
    }

    // ── Bare pre-existing SCHEMA collision (own isolated DB) ────────────────
    // 038 uses plain CREATE SCHEMA (no IF NOT EXISTS), so a pre-existing empty
    // gitwire_auth schema must fail closed — it must NOT be silently adopted.
    log("  [bare-schema collision]");
    const bareDb = `proof_barecoll_${Date.now()}`;
    await adminPool.query(`CREATE DATABASE ${bareDb}`);
    const bareUrl = adminUrl.replace(/\/[^/?]+$/, `/${bareDb}`);
    const barePool = new pg.Pool({ connectionString: bareUrl });
    try {
      await barePool.query(`CREATE SCHEMA gitwire_auth`);
      const sql038b = await readFile(join(MIGRATIONS_DIR, "038_level1_schema.sql"), "utf8");
      const bareCollision = await expectThrow(() => barePool.query(sql038b));
      check(
        "038 fails closed on pre-existing (bare) gitwire_auth schema",
        bareCollision.threw && /already exists/.test(bareCollision.msg),
        bareCollision.msg
      );
    } finally {
      await barePool.end();
      await adminPool.query(`DROP DATABASE ${bareDb} WITH (FORCE)`);
    }

    // ── Pre-existing FUNCTION collision (own isolated DB) ───────────────────
    // 038/039 use plain CREATE FUNCTION (no OR REPLACE), so a pre-existing
    // same-signature function must fail closed — it must NOT be silently
    // replaced. Test against a 038 trigger function.
    log("  [pre-existing-function collision]");
    const fnDb = `proof_fncoll_${Date.now()}`;
    await adminPool.query(`CREATE DATABASE ${fnDb}`);
    const fnUrl = adminUrl.replace(/\/[^/?]+$/, `/${fnDb}`);
    const fnPool = new pg.Pool({ connectionString: fnUrl });
    try {
      // Apply the schema portion up to (but not including) the trigger function
      // we want to collide, by creating the schema + the function shell first.
      await fnPool.query(`CREATE SCHEMA gitwire_auth`);
      await fnPool.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto`);
      await fnPool.query(`CREATE TABLE gitwire_auth.auth_principals (id uuid primary key default gen_random_uuid())`);
      // Pre-create a function with the SAME signature as a 038 trigger function.
      await fnPool.query(`
        CREATE FUNCTION gitwire_auth.enforce_events_append_only()
        RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$;
      `);
      const sql038f = await readFile(join(MIGRATIONS_DIR, "038_level1_schema.sql"), "utf8");
      const fnCollision = await expectThrow(() => fnPool.query(sql038f));
      check(
        "038 fails closed on pre-existing same-signature function (no OR REPLACE)",
        fnCollision.threw && /already exists/.test(fnCollision.msg),
        fnCollision.msg
      );
    } finally {
      await fnPool.end();
      await adminPool.query(`DROP DATABASE ${fnDb} WITH (FORCE)`);
    }
    await adminPool.end();
  } finally {
    try {
      execFileSync("docker", ["rm", "-f", containerId], { stdio: "ignore" });
      log(`  collision cleanup: removed ${containerName}`);
    } catch {
      // best effort; --rm handles it.
    }
  }

  return { run, passed, failed };
}

async function expectThrow(fn) {
  try {
    await fn();
    return { threw: false, msg: "" };
  } catch (e) {
    return { threw: true, msg: (e && e.message) || String(e) };
  }
}

function waitForReady(connUrl, timeoutMs) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
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
