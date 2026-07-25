#!/usr/bin/env node
// packages/web/db/proof/seed_proof.mjs
//
// Seed proof (Wave 1 acceptance gate step 7) and Compose proof (step 8).
//
// Step 7 — Seed proof:
//   * direct isolated re-execution of 040 is idempotent;
//   * canonical drift is rejected (the proof layer asserts the post-state
//     matches the canonical set, and that ON CONFLICT DO NOTHING does NOT
//     overwrite an existing canonical row with drift).
//
// Step 8 — Compose proof:
//   * fresh disposable initialization applies ALL migrations via migrate.js
//     alone (the removed /docker-entrypoint-initdb.d path is not used);
//   * a "volume restart" simulation (same container, stop+start preserving the
//     data directory) preserves both data and migration state, and a second
//     migrate.js run reports everything already applied.
//
// Owns its own disposable container. Cleans up in finally.

import { execFileSync } from "node:child_process";
import { createServer } from "node:net";
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const MIGRATIONS_DIR = join(REPO_ROOT, "packages", "web", "db", "migrations");
const MIGRATE_JS = join(REPO_ROOT, "scripts", "migrate.js");

const PG_IMAGE = "postgres:16-alpine";
const U = "seedproof";
const DB = "seedproofdb";
const PW = "proof-only-disposable-seed";

let passed = 0,
  failed = 0;
function check(name, ok, detail = "") {
  if (ok) passed += 1;
  else failed += 1;
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${name}${detail ? " — " + detail : ""}`);
}

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
        if (Date.now() - start > timeoutMs) return reject(new Error("not ready"));
        setTimeout(tick, 500);
      }
    };
    tick();
  });
}

async function expectThrow(fn) {
  try {
    await fn();
    return { threw: false, msg: "" };
  } catch (e) {
    return { threw: true, msg: (e && e.message) || String(e) };
  }
}

async function main() {
  if (process.env.DATABASE_URL) {
    console.error("REFUSED: this harness constructs its own disposable DATABASE_URL.");
    process.exit(2);
  }

  const hostPort = await pickFreeLoopbackPort();
  const name = `gitwire-seedproof-${hostPort}-${Date.now()}`;
  // NOTE: created WITHOUT --rm so that the volume-restart test (stop+start)
  // can re-resurrect the same container and its data directory. Cleanup is
  // explicit in the finally block via `docker rm -f`.
  const id = docker(
    "run", "-d", "--name", name,
    "-p", `127.0.0.1:${hostPort}:5432`,
    "-e", `POSTGRES_USER=${U}`, "-e", `POSTGRES_PASSWORD=${PW}`, "-e", `POSTGRES_DB=${DB}`,
    PG_IMAGE
  );
  const url = `postgresql://${U}:${PW}@127.0.0.1:${hostPort}/${DB}`;
  console.log(`container: ${name}`);

  try {
    await waitForReady(url, 60_000);

    // ── COMPOSE PROOF (step 8a): fresh init via migrate.js ALONE ────────────
    // The removed /docker-entrypoint-initdb.d bind mount is not used. We invoke
    // the repository's migrate.js, pointing it at the disposable container.
    console.log("\n--- compose proof 8a: fresh init via migrate.js alone ---");
    const migrateOut = execFileSync(
      process.execPath, [MIGRATE_JS], {
        encoding: "utf8",
        env: { ...process.env, DATABASE_URL: url, PATH: process.env.PATH },
      }
    );
    const appliedLines = migrateOut.split("\n").filter((l) => /^✅/.test(l));
    check("migrate.js applies all 40 migrations", appliedLines.length === 40, `${appliedLines.length} applied`);
    check("migrate.js output uses no /docker-entrypoint-initdb.d path", !/docker-entrypoint-initdb/.test(migrateOut));

    const pool = new pg.Pool({ connectionString: url });
    try {
      const cnt = (await pool.query("SELECT count(*)::int n FROM schema_migrations")).rows[0].n;
      check("schema_migrations has 40 rows after migrate.js", cnt === 40, `count=${cnt}`);

      // Insert a sentinel row to prove volume-restart preserves data.
      await pool.query(
        `INSERT INTO gitwire_auth.auth_principals (principal_type, display_name)
         VALUES ('user','volume-restart-sentinel')`
      );

      // ── SEED PROOF (step 7): direct isolated re-execution of 040 ───────────
      console.log("\n--- seed proof 7: direct 040 re-execution idempotency ---");
      const before = (
        await pool.query(
          `SELECT (SELECT count(*) FROM gitwire_auth.auth_roles) AS roles,
                  (SELECT count(*) FROM gitwire_auth.auth_role_permissions) AS perms,
                  (SELECT state FROM gitwire_auth.auth_bootstrap_state WHERE id=1) AS bs,
                  (SELECT state FROM gitwire_auth.auth_enforcement_state WHERE id=1) AS es`
        )
      ).rows[0];

      const sql040 = await readFile(join(MIGRATIONS_DIR, "040_level1_seed.sql"), "utf8");
      // Direct re-execution (not via migrate.js, which would skip it).
      await pool.query(sql040);
      const after = (
        await pool.query(
          `SELECT (SELECT count(*) FROM gitwire_auth.auth_roles) AS roles,
                  (SELECT count(*) FROM gitwire_auth.auth_role_permissions) AS perms,
                  (SELECT state FROM gitwire_auth.auth_bootstrap_state WHERE id=1) AS bs,
                  (SELECT state FROM gitwire_auth.auth_enforcement_state WHERE id=1) AS es`
        )
      ).rows[0];
      check(
        "direct 040 re-execution is idempotent (counts unchanged)",
        Number(before.roles) === Number(after.roles) &&
          Number(before.perms) === Number(after.perms) &&
          before.bs === after.bs && before.es === after.es,
        `roles ${before.roles}->${after.roles}, perms ${before.perms}->${after.perms}`
      );

      // Canonical drift rejection (true drift): MUTATE a canonical seed row,
      // then run 040 SQL directly, and require it to RAISE. This proves 040's
      // drift-verification DO block detects attribute drift (not just that
      // ON CONFLICT DO NOTHING preserves a row).
      await pool.query(
        `UPDATE gitwire_auth.auth_roles SET description='DRIFTED-DESCRIPTION'
         WHERE name='admin'`
      );
      const driftReject = await expectThrow(() => pool.query(sql040));
      check(
        "040 raises on mutated canonical seed row (drift detection)",
        driftReject.threw && /canonical seed drift detected/.test(driftReject.msg),
        driftReject.msg
      );
      // Restore the canonical description so subsequent checks are valid.
      await pool.query(
        `UPDATE gitwire_auth.auth_roles
         SET description='Full administrative access (fleet scope). Assigned to the bootstrap administrator.'
         WHERE name='admin'`
      );
      // And confirm a clean 040 re-run now succeeds (drift resolved).
      const cleanRerun = await expectThrow(() => pool.query(sql040));
      check("040 succeeds after drift restored", !cleanRerun.threw, cleanRerun.msg);

      // Canonical set matches spec exactly.
      const roles = (await pool.query("SELECT name FROM gitwire_auth.auth_roles WHERE is_builtin ORDER BY name")).rows.map((r) => r.name);
      check("canonical built-in roles == [admin, legacy-key, operator]", JSON.stringify(roles) === JSON.stringify(["admin", "legacy-key", "operator"]), JSON.stringify(roles));
    } finally {
      await pool.end();
    }

    // ── COMPOSE PROOF (step 8b): volume restart preserves data + migrations ─
    console.log("\n--- compose proof 8b: volume restart preserves data + state ---");
    docker("stop", name);
    docker("start", name);
    await waitForReady(url, 60_000);

    const pool2 = new pg.Pool({ connectionString: url });
    try {
      const cnt2 = (await pool2.query("SELECT count(*)::int n FROM schema_migrations")).rows[0].n;
      check("volume restart preserves migration state (40 rows)", cnt2 === 40, `count=${cnt2}`);
      const sentinel = (
        await pool2.query("SELECT count(*)::int n FROM gitwire_auth.auth_principals WHERE display_name='volume-restart-sentinel'")
      ).rows[0].n;
      check("volume restart preserves data (sentinel row present)", sentinel === 1, `sentinel=${sentinel}`);

      // Second migrate.js run on preserved volume: all already applied.
      const migrateOut2 = execFileSync(
        process.execPath, [MIGRATE_JS], {
          encoding: "utf8",
          env: { ...process.env, DATABASE_URL: url, PATH: process.env.PATH },
        }
      );
      check("migrate.js on preserved volume reports all already applied", /already applied/.test(migrateOut2) && !/^✅/m.test(migrateOut2));
    } finally {
      await pool2.end();
    }
  } finally {
    try {
      execFileSync("docker", ["rm", "-f", id], { stdio: "ignore" });
      console.log(`\ncleanup: removed ${name}`);
    } catch {}
  }

  console.log(`\n=== seed+compose RESULT: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error("seed_proof error:", e.stack || e.message);
  process.exit(1);
});
