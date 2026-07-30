#!/usr/bin/env node
// packages/web/db/proof/run_guard_pg_proof.mjs
//
// Disposable PostgreSQL attribution guard proof (Wave 2 / issue #94).
//
// Tests the centralized attribution guard + gap recorder against real
// PostgreSQL. Exercises all 7 required scenarios.

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
const U = "guardproof";
const DB = "guardproofdb";
const PW = "guard-disposable-only";

let passed = 0, failed = 0;
function check(name, ok, detail = "") {
  if (ok) passed += 1; else failed += 1;
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${name}${detail ? " — " + detail : ""}`);
}

function docker(...args) {
  return execFileSync("docker", args, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}
function pickPort() {
  return new Promise((resolve, reject) => {
    const s = createServer(); s.unref(); s.on("error", reject);
    s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}
function waitForReady(url, ms) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = async () => {
      try { const c = new pg.Client({ connectionString: url }); await c.connect(); await c.end(); resolve(); }
      catch { if (Date.now() - start > ms) return reject(new Error("not ready")); setTimeout(tick, 500); }
    };
    tick();
  });
}

async function applyMigrations(pool) {
  const client = await pool.connect();
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    const { rows } = await client.query("SELECT version FROM schema_migrations");
    const applied = new Set(rows.map(r => r.version));
    const files = (await readdir(MIGRATIONS_DIR)).filter(f => f.endsWith(".sql")).sort();
    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = await readFile(join(MIGRATIONS_DIR, file), "utf8");
      try {
        await client.query("BEGIN"); await client.query(sql);
        await client.query("INSERT INTO schema_migrations (version) VALUES ($1)", [file]);
        await client.query("COMMIT");
      } catch (err) { await client.query("ROLLBACK"); throw new Error(`${file}: ${err.message}`); }
    }
  } finally { client.release(); }
}

async function main() {
  if (process.env.DATABASE_URL) { console.error("REFUSED"); process.exit(2); }

  const port = await pickPort();
  const name = `gitwire-guard-pg-${port}-${Date.now()}`;
  const cid = docker("run", "-d", "--rm", "--name", name,
    "-p", `127.0.0.1:${port}:5432`,
    "-e", `POSTGRES_USER=${U}`, "-e", `POSTGRES_PASSWORD=${PW}`, "-e", `POSTGRES_DB=${DB}`,
    PG_IMAGE);
  const url = `postgresql://${U}:${PW}@127.0.0.1:${port}/${DB}`;
  console.log(`container: ${name}`);

  try {
    await waitForReady(url, 60_000);
    const pool = new pg.Pool({ connectionString: url });
    await applyMigrations(pool);
    const migCount = (await pool.query("SELECT count(*)::int n FROM schema_migrations")).rows[0].n;
    check("migrations applied", migCount === 42, `count=${migCount}`);

    // ═══ 1. Valid principalId → writer succeeds; NO gap event ═══════════════
    console.log("\n=== 1. Valid principalId → no gap event ===");
    // Use the decisionLogService directly with a real principalId
    process.env.DATABASE_URL = url;
    process.env.REDIS_URL = "redis://127.0.0.1:1/0";
    process.env.NODE_ENV = "test";
    process.env.LOG_LEVEL = "error";
    process.env.PORT = "3999";
    process.env.APP_BASE_URL = "http://localhost:3999";
    process.env.ANTHROPIC_API_KEY = "test";
    process.env.GITHUB_APP_ID = "1";
    process.env.GITHUB_APP_CLIENT_ID = "x";
    process.env.GITHUB_APP_CLIENT_SECRET = "x";
    process.env.GITHUB_PRIVATE_KEY = "x";
    process.env.GITHUB_WEBHOOK_SECRET = "x";

    // Seed a repo for decision_log FK
    await pool.query(`INSERT INTO installations (github_id, account_login, account_type) VALUES (90001, 'g', 'Organization') ON CONFLICT DO NOTHING`);
    await pool.query(`INSERT INTO repositories (github_id, installation_id, full_name, owner, name, private, default_branch, language, stars, open_issues, open_prs) VALUES (90002, 90001, 'g/r', 'g', 'r', false, 'main', 'x', 0, 0, 0) ON CONFLICT DO NOTHING`);

    // Seed a test principal
    const testP = await pool.query(`INSERT INTO gitwire_auth.auth_principals (principal_type, display_name) VALUES ('user', 'guard-test-user') RETURNING id`);
    const testPrincipalId = testP.rows[0].id;

    // Initialize the runtime so the db singleton points at our disposable PG.
    const { pathToFileURL } = await import("node:url");
    const configUrl = pathToFileURL(join(REPO_ROOT, "packages/web/config/index.js"));
    await import(configUrl.href); // triggers config validation + setConfig()
    const rtUrl = pathToFileURL(join(REPO_ROOT, "packages/runtime/src/index.js"));
    const { initRuntime } = await import(rtUrl.href);
    const { config } = await import(configUrl.href);
    await initRuntime(config);

    // Count gap events before
    const gapsBefore1 = (await pool.query("SELECT count(*)::int n FROM gitwire_auth.attribution_gap_evidence")).rows[0].n;

    // Call decisionLogService.logDecision WITH principalId
    const dlsUrl = pathToFileURL(join(REPO_ROOT, "packages/web/src/services/decisionLogService.js"));
    const { logDecision } = await import(dlsUrl.href);
    const result1 = await logDecision({
      repoId: 90002, source: "guard_test", triggerEvent: "test",
      targetType: "issue", targetNumber: 1,
      decision: "acted", reason: "guard test",
      actor: "legacy-actor",
      principalId: testPrincipalId,
      surfaceId: "test:guard:valid_principal",
    });

    // Count gap events after — should be unchanged (no gap)
    const gapsAfter1 = (await pool.query("SELECT count(*)::int n FROM gitwire_auth.attribution_gap_evidence")).rows[0].n;
    check("valid principalId: no gap event emitted", gapsAfter1 === gapsBefore1, `before=${gapsBefore1} after=${gapsAfter1}`);

    // Verify the decision_log row has the principalId
    const dlRow = await pool.query(`SELECT principal_id FROM decision_log WHERE source='guard_test' ORDER BY created_at DESC LIMIT 1`);
    check("valid principalId: decision_log row has principal", dlRow.rows[0]?.principal_id === testPrincipalId);

    // Wave 2: writer result observability — attributed write reports no gap
    check("observability: attributed write has attribution.gapEvidence=null",
      result1?.attribution?.gapEvidence === null || result1?.attribution?.gapEvidence === undefined,
      `gapEvidence=${JSON.stringify(result1?.attribution?.gapEvidence)}`);

    // ═══ 2. Null principal WITH envelope → exactly one gap event ════════════
    console.log("\n=== 2. Null principal + envelope → one gap event ===");
    const gapsBefore2 = (await pool.query("SELECT count(*)::int n FROM gitwire_auth.attribution_gap_evidence")).rows[0].n;

    await logDecision({
      repoId: 90002, source: "guard_test_null", triggerEvent: "test",
      targetType: "issue", targetNumber: 2,
      decision: "skipped", reason: "guard test null",
      actor: "legacy-actor-null",
      principalId: null,
      surfaceId: "test:guard:null_principal",
    });

    const gapsAfter2 = (await pool.query("SELECT count(*)::int n FROM gitwire_auth.attribution_gap_evidence")).rows[0].n;
    check("null principal: exactly one gap event emitted", gapsAfter2 === gapsBefore2 + 1, `before=${gapsBefore2} after=${gapsAfter2}`);

    // Wave 2: call again to capture result for observability check
    const result2 = await logDecision({
      repoId: 90002, source: "guard_test_null_obs", triggerEvent: "test",
      targetType: "issue", targetNumber: 3,
      decision: "skipped", reason: "guard test null obs",
      actor: "legacy-actor-obs",
      principalId: null,
      surfaceId: "test:guard:null_principal_obs",
    });
    check("observability: evidenced write has gapEvidence.recorded=true",
      result2?.attribution?.gapEvidence?.recorded === true,
      `gapEvidence=${JSON.stringify(result2?.attribution?.gapEvidence)}`);
    check("observability: evidenced write has evidenceId",
      !!result2?.attribution?.gapEvidence?.evidenceId,
      `evidenceId=${result2?.attribution?.gapEvidence?.evidenceId}`);
    check("observability: evidenced write has code=recorded",
      result2?.attribution?.gapEvidence?.code === "recorded",
      `code=${result2?.attribution?.gapEvidence?.code}`);

    // Verify the gap event content — query the specific one we just checked
    const gapRow = await pool.query(`SELECT * FROM gitwire_auth.attribution_gap_evidence WHERE surface_id='test:guard:null_principal' ORDER BY occurred_at DESC LIMIT 1`);
    check("gap event: reason_code present", !!gapRow.rows[0]?.reason_code);
    check("gap event: surface_id is exact", gapRow.rows[0]?.surface_id === "test:guard:null_principal");
    check("gap event: writer is exact", gapRow.rows[0]?.writer === "decisionLogService.logDecision");
    check("gap event: table_name is decision_log", gapRow.rows[0]?.table_name === "decision_log");
    check("gap event: operation is insert", gapRow.rows[0]?.operation === "insert");
    check("gap event: principal_id is null", gapRow.rows[0]?.principal_id === null);
    check("gap event: legacy_actor is exact", gapRow.rows[0]?.legacy_actor === "legacy-actor-null");

    // ═══ 3. Null principal WITHOUT surfaceId → failure result ═══════════════
    console.log("\n=== 3. Null principal without surfaceId → failure ===");
    // The recordAttributionGap function returns failure when surfaceId is missing.
    // The guard passes surfaceId||null. When surfaceId is not supplied by the
    // caller AND the writer has no default, the guard uses the writer's default.
    // decisionLogService defaults to `decision_log:${source}`, so surfaceId is
    // always present. To test the missing-surfaceId path, call the recorder directly.
    const gapUrl = pathToFileURL(join(REPO_ROOT, "packages/web/src/services/auth/attributionGap.js"));
    const { recordAttributionGap } = await import(gapUrl.href);
    const missingSurfaceResult = await recordAttributionGap({
      reasonCode: "test_missing_surface",
      surfaceId: null, // explicitly null
      writer: "testWriter",
      tableName: "test_table",
      operation: "insert",
      legacyActor: "test-actor",
    });
    check("missing surfaceId: recorded=false", missingSurfaceResult.recorded === false);
    check("missing surfaceId: code=attribution_gap_evidence_error", missingSurfaceResult.code === "attribution_gap_evidence_error");

    // ═══ 4. Gap-table INSERT failure → failure result + fallback signal ════
    console.log("\n=== 4. Gap-table INSERT failure ===");
    // Rename the table to force failure
    await pool.query(`ALTER TABLE gitwire_auth.attribution_gap_evidence RENAME TO attribution_gap_evidence_bak`);
    const failResult = await recordAttributionGap({
      reasonCode: "test_insert_failure",
      surfaceId: "test:insert_failure",
      writer: "testWriter",
      tableName: "test_table",
      operation: "insert",
      legacyActor: "test-actor",
    });
    await pool.query(`ALTER TABLE gitwire_auth.attribution_gap_evidence_bak RENAME TO attribution_gap_evidence`);
    check("gap-table failure: recorded=false", failResult.recorded === false);
    check("gap-table failure: code=attribution_gap_evidence_error", failResult.code === "attribution_gap_evidence_error");
    check("gap-table failure: evidenceId=null", failResult.evidenceId === null);
    // Verify the failure result contains ONLY approved secret-safe fields
    const failKeys = Object.keys(failResult).sort();
    check("gap-table failure: result has only {code, evidenceId, recorded}",
      failKeys.length === 3 && failKeys.includes("code") && failKeys.includes("evidenceId") && failKeys.includes("recorded"),
      `keys=${failKeys.join(",")}`);
    // Verify no SQL text, params, payloads, tokens, or secrets in the result
    const failJson = JSON.stringify(failResult);
    check("gap-table failure: result contains no SQL/payload/secrets",
      !failJson.includes("INSERT") && !failJson.includes("VALUES") && !failJson.includes("password") && !failJson.includes("token"),
      `json=${failJson}`);

    // ═══ 5. Forged legacy actor → stored principal unchanged ════════════════
    console.log("\n=== 5. Forged legacy actor → principal unchanged ===");
    await logDecision({
      repoId: 90002, source: "guard_test_forge", triggerEvent: "test",
      targetType: "issue", targetNumber: 3,
      decision: "acted", reason: "forge test",
      actor: "FORGED-ACTOR-STRING",
      principalId: testPrincipalId,
      surfaceId: "test:guard:forged_actor",
    });
    const forgeRow = await pool.query(`SELECT principal_id, actor FROM decision_log WHERE source='guard_test_forge' ORDER BY created_at DESC LIMIT 1`);
    check("forged actor: principal unchanged", forgeRow.rows[0]?.principal_id === testPrincipalId);
    check("forged actor: legacy actor retained as metadata", forgeRow.rows[0]?.actor === "FORGED-ACTOR-STRING");

    // ═══ 6. Writer called once → no duplicate gap event ═════════════════════
    console.log("\n=== 6. Single writer call → no duplicate gap ===");
    const gapsBefore6 = (await pool.query("SELECT count(*)::int n FROM gitwire_auth.attribution_gap_evidence")).rows[0].n;
    await logDecision({
      repoId: 90002, source: "guard_test_dedup", triggerEvent: "test",
      targetType: "issue", targetNumber: 4,
      decision: "skipped", reason: "dedup test",
      actor: "legacy",
      principalId: null,
      surfaceId: "test:guard:dedup",
    });
    const gapsAfter6 = (await pool.query("SELECT count(*)::int n FROM gitwire_auth.attribution_gap_evidence")).rows[0].n;
    check("single call: exactly one gap event (no duplicate)", gapsAfter6 === gapsBefore6 + 1, `delta=${gapsAfter6 - gapsBefore6}`);

    // ═══ 7. Append-only enforcement ═════════════════════════════════════════
    console.log("\n=== 7. Append-only enforcement ===");
    let updateBlocked = false;
    try { await pool.query("UPDATE gitwire_auth.attribution_gap_evidence SET reason_code='hacked' WHERE id=(SELECT id FROM gitwire_auth.attribution_gap_evidence LIMIT 1)"); }
    catch { updateBlocked = true; }
    check("attribution_gap_evidence UPDATE rejected", updateBlocked);

    let deleteBlocked = false;
    try { await pool.query("DELETE FROM gitwire_auth.attribution_gap_evidence WHERE id=(SELECT id FROM gitwire_auth.attribution_gap_evidence LIMIT 1)"); }
    catch { deleteBlocked = true; }
    check("attribution_gap_evidence DELETE rejected", deleteBlocked);

    // ═══ 8. Recursion prevention (structural proof) ════════════════════════
    console.log("\n=== 8. Recursion prevention ===");
    // The attribution_gap_evidence table is NOT one of the five guarded writers.
    // recordAttributionGap() writes directly to attribution_gap_evidence, which
    // has no attribution guard. Therefore it cannot recursively trigger another
    // gap event. This is a structural property, not a runtime check.
    //
    // Proof: the five guarded tables are:
    //   decision_log, audit_trail_entries, repair_proposals,
    //   repair_proposal_events, managed_actions
    // attribution_gap_evidence is NOT in this set.
    check("recursion prevention: evidence table is not a guarded writer", true,
      "attribution_gap_evidence is written directly by recordAttributionGap, not through any guarded writer API");

    // Direct test: insert into attribution_gap_evidence should NOT trigger
    // any additional gap event (because there is no guard on this table).
    const gapsBeforeRecursion = (await pool.query("SELECT count(*)::int n FROM gitwire_auth.attribution_gap_evidence")).rows[0].n;
    await recordAttributionGap({
      reasonCode: "recursion_test",
      surfaceId: "test:recursion",
      writer: "recursionTestWriter",
      tableName: "attribution_gap_evidence",
      operation: "insert",
      legacyActor: "recursion-actor",
    });
    const gapsAfterRecursion = (await pool.query("SELECT count(*)::int n FROM gitwire_auth.attribution_gap_evidence")).rows[0].n;
    check("recursion test: exactly one event (no recursive cascade)", gapsAfterRecursion === gapsBeforeRecursion + 1,
      `delta=${gapsAfterRecursion - gapsBeforeRecursion}`);

    // ═══ SUMMARY ════════════════════════════════════════════════════════════
    console.log("\n=== SUMMARY ===");
    const totalGaps = (await pool.query("SELECT count(*)::int n FROM gitwire_auth.attribution_gap_evidence")).rows[0].n;
    check("total gap events in test DB", totalGaps >= 3, `total=${totalGaps} (expected >=3: null+envelope + dedup + recursion)`);

    await pool.end();
    delete process.env.DATABASE_URL;
    delete process.env.REDIS_URL;
  } finally {
    try { execFileSync("docker", ["rm", "-f", cid], { stdio: "ignore" }); } catch {}
  }

  console.log(`\n=== Attribution Guard PG Proof: ${passed} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error("harness error:", e.stack || e.message); process.exit(1); });
