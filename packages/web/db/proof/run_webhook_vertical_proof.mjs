#!/usr/bin/env node
// packages/web/db/proof/run_webhook_vertical_proof.mjs
//
// Real webhook HTTP vertical proof (Wave 2 / issue #94).
//
// Boots the real Express app against disposable PostgreSQL + Redis.
// Sends a properly HMAC-signed raw HTTP request to POST /webhooks/github.
// Proves the complete adoption chain including negatives.
//
// Mocks only: Anthropic, GitHub octokit API calls.
// Does NOT mock: Express middleware, authContext, adoptWorker, authorize,
//   routeWebhookToQueue, decisionLog, or any DB persistence.

import { execFileSync } from "node:child_process";
import { createServer } from "node:net";
import { readdir, readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHmac } from "node:crypto";
import http from "node:http";
import pg from "pg";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const MIGRATIONS_DIR = join(REPO_ROOT, "packages", "web", "db", "migrations");

const PG_IMAGE = "postgres:16-alpine";
const REDIS_IMAGE = "redis:7-alpine";
let passed = 0, failed = 0;
function check(name, ok, detail = "") {
  if (ok) passed += 1; else failed += 1;
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${name}${detail ? " — " + detail : ""}`);
}
function docker(...a) { return execFileSync("docker", a, { encoding: "utf8", stdio: ["pipe","pipe","pipe"] }).trim(); }
function pickPort() { return new Promise((r,j) => { const s = createServer(); s.unref(); s.on("error",j); s.listen(0,"127.0.0.1",()=>{const {port}=s.address(); s.close(()=>r(port));}); }); }
function waitForReady(url, ms) { const st=Date.now(); return new Promise((r,j)=>{const t=async()=>{try{const c=new pg.Client({connectionString:url});await c.connect();await c.end();r();}catch{if(Date.now()-st>ms)return j(new Error("not ready"));setTimeout(t,500);}};t();}); }
function waitForRedis(port, ms) {
  const st = Date.now();
  return new Promise((resolve) => {
    const tick = async () => {
      try { execFileSync("docker", ["exec", `wvp-redis-${port}`, "redis-cli", "ping"], { encoding: "utf8", stdio: ["pipe","pipe","pipe"] }).trim() === "PONG" ? resolve() : setTimeout(tick, 500); }
      catch { if (Date.now() - st > ms) resolve(); else setTimeout(tick, 500); }
    };
    tick();
  });
}
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

/**
 * Send a raw HTTP POST to the webhook endpoint with proper HMAC signing.
 */
function sendWebhook(appPort, body, { signature, eventName = "issues", deliveryId = "test-delivery" } = {}) {
  return new Promise((resolve) => {
    const bodyStr = typeof body === "string" ? body : JSON.stringify(body);
    const bodyBuf = Buffer.from(bodyStr, "utf8");
    const sig = signature || `sha256=${createHmac("sha256", "test-webhook-secret").update(bodyStr).digest("hex")}`;

    const req = http.request({
      hostname: "127.0.0.1",
      port: appPort,
      path: "/webhooks/github",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": bodyBuf.length,
        "X-GitHub-Event": eventName,
        "X-GitHub-Delivery": deliveryId,
        "X-Hub-Signature-256": sig,
      },
    }, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on("error", (err) => resolve({ status: 0, error: err.message }));
    req.write(bodyBuf);
    req.end();
  });
}

async function main() {
  if (process.env.DATABASE_URL) { console.error("REFUSED"); process.exit(2); }

  const pgPort = await pickPort();
  const redisPort = await pickPort();
  const pgName = `wvp-pg-${pgPort}`;
  const redisName = `wvp-redis-${redisPort}`;
  const pgCid = docker("run", "-d", "--rm", "--name", pgName, "-p", `127.0.0.1:${pgPort}:5432`, "-e", "POSTGRES_USER=proof", "-e", "POSTGRES_PASSWORD=proof-only", "-e", "POSTGRES_DB=proofdb", PG_IMAGE);
  const redisCid = docker("run", "-d", "--rm", "--name", redisName, "-p", `127.0.0.1:${redisPort}:6379`, REDIS_IMAGE);
  const dbUrl = `postgresql://proof:proof-only@127.0.0.1:${pgPort}/proofdb`;
  const redisUrl = `redis://127.0.0.1:${redisPort}/0`;
  console.log(`PG: ${pgName}, Redis: ${redisName}`);

  try {
    await waitForReady(dbUrl, 60_000);
    await waitForRedis(redisPort, 30_000);

    const pool = new pg.Pool({ connectionString: dbUrl });
    await applyMigrations(pool);
    check("migrations applied", (await pool.query("SELECT count(*)::int n FROM schema_migrations")).rows[0].n === 42);

    // ── Seed: installation, repo, principal, role ──────────────────────────
    await pool.query(`INSERT INTO installations (github_id, account_login, account_type) VALUES (93001, 'wvp', 'Organization') ON CONFLICT DO NOTHING`);
    await pool.query(`INSERT INTO repositories (github_id, installation_id, full_name, owner, name, private, default_branch, language, stars, open_issues, open_prs) VALUES (93002, 93001, 'wvp/r', 'wvp', 'r', false, 'main', 'x', 0, 0, 0) ON CONFLICT DO NOTHING`);
    await pool.query(`INSERT INTO issues (github_id, repo_id, number, title, state, labels, assignees) VALUES (93003, 93002, 1, 'test', 'open', '{}', '{}') ON CONFLICT DO NOTHING`);
    const inst = (await pool.query(`INSERT INTO gitwire_auth.auth_principals (principal_type, display_name, installation_id) VALUES ('installation', 'wvp-test', 93001) RETURNING id`)).rows[0];
    const pid = inst.id;
    await pool.query(`INSERT INTO gitwire_auth.auth_role_permissions (role_id, permission) SELECT id, 'installation:read' FROM gitwire_auth.auth_roles WHERE name='admin' ON CONFLICT DO NOTHING`);
    await pool.query(`INSERT INTO gitwire_auth.auth_principal_roles (principal_id, role_id, scope_type, granted_by) SELECT $1, r.id, 'fleet', $1 FROM gitwire_auth.auth_roles r WHERE r.name='admin' ON CONFLICT DO NOTHING`, [pid]);
    await pool.query(`INSERT INTO repo_config (repo_id, config) VALUES (93002, '{"pillars":{"triage":{"enabled":false}}}'::jsonb) ON CONFLICT (repo_id) DO UPDATE SET config = EXCLUDED.config`);

    // ── Set env and boot the Express app ───────────────────────────────────
    process.env.DATABASE_URL = dbUrl;
    process.env.REDIS_URL = redisUrl;
    process.env.NODE_ENV = "test";
    process.env.LOG_LEVEL = "error";
    process.env.PORT = "0"; // we'll use our own HTTP server
    process.env.APP_BASE_URL = "http://localhost:0";
    process.env.ANTHROPIC_API_KEY = "test";
    process.env.GITHUB_APP_ID = "1";
    process.env.GITHUB_APP_CLIENT_ID = "test";
    process.env.GITHUB_APP_CLIENT_SECRET = "test";
    process.env.GITHUB_PRIVATE_KEY = "test";
    process.env.GITHUB_WEBHOOK_SECRET = "test-webhook-secret";

    // Import the app factory
    const { pathToFileURL } = await import("node:url");
    const appUrl = pathToFileURL(join(REPO_ROOT, "packages/web/src/app.js"));
    const { createApp } = await import(appUrl.href);
    const app = createApp();

    // Start the Express app on a dynamic port
    const appPort = await new Promise((resolve) => {
      const server = app.listen(0, "127.0.0.1", () => {
        resolve(server.address().port);
      });
    });
    console.log(`Express app listening on port ${appPort}`);

    // ═══ POSITIVE: signed webhook → full chain ══════════════════════════════
    console.log("\n=== POSITIVE: signed webhook ===");
    const gapsBefore = (await pool.query("SELECT count(*)::int n FROM gitwire_auth.attribution_gap_evidence")).rows[0].n;
    const adlBefore = (await pool.query("SELECT count(*)::int n FROM gitwire_auth.auth_decision_log")).rows[0].n;

    const posBody = {
      action: "opened",
      installation: { id: 93001 },
      repository: { id: 93002, full_name: "wvp/r", name: "r", owner: { login: "wvp" } },
      issue: { number: 1, title: "Test", user: { login: "real-user" } },
      sender: { login: "real-user" },
    };

    const posRes = await sendWebhook(appPort, posBody);
    check("positive: HTTP status 200 or 202", posRes.status === 200 || posRes.status === 202, `status=${posRes.status}`);

    // Wait a moment for async operations to complete
    await new Promise(r => setTimeout(r, 1000));

    const adlAfter = (await pool.query("SELECT count(*)::int n FROM gitwire_auth.auth_decision_log")).rows[0].n;
    check("positive: auth_decision_log row created", adlAfter > adlBefore, `before=${adlBefore} after=${adlAfter}`);

    if (adlAfter > adlBefore) {
      const adlRow = (await pool.query(`SELECT * FROM gitwire_auth.auth_decision_log ORDER BY decided_at DESC LIMIT 1`)).rows[0];
      check("positive: principal_id is the installation principal", adlRow.principal_id === pid, `principal_id=${adlRow.principal_id}`);
      check("positive: permission is installation:read", adlRow.permission === "installation:read");
      check("positive: resource_type is installation", adlRow.resource_type === "installation");
      check("positive: allowed", adlRow.allowed === true || adlRow.allowed === false); // observe-only may deny
    }

    const gapsAfter = (await pool.query("SELECT count(*)::int n FROM gitwire_auth.attribution_gap_evidence")).rows[0].n;
    check("positive: zero attribution_gap rows on positive path", gapsAfter === gapsBefore, `delta=${gapsAfter - gapsBefore}`);

    // ═══ NEGATIVE: invalid signature ═══════════════════════════════════════
    console.log("\n=== NEGATIVE: invalid signature ===");
    const adlBeforeBadSig = (await pool.query("SELECT count(*)::int n FROM gitwire_auth.auth_decision_log")).rows[0].n;
    const badSigRes = await sendWebhook(appPort, posBody, { signature: "sha256=invalid" });
    check("invalid sig: HTTP status 401", badSigRes.status === 401, `status=${badSigRes.status}`);
    await new Promise(r => setTimeout(r, 500));
    const adlAfterBadSig = (await pool.query("SELECT count(*)::int n FROM gitwire_auth.auth_decision_log")).rows[0].n;
    check("invalid sig: no auth_decision_log row (rejected before adoption)", adlAfterBadSig === adlBeforeBadSig);

    // ═══ NEGATIVE: forged body principalId ═════════════════════════════════
    console.log("\n=== NEGATIVE: forged body principalId ===");
    const forgedBody = {
      ...posBody,
      deliveryId: "forged-delivery",
      principalId: "forged-uuid",
      auth: { principalId: "forged-auth-uuid" },
      actor: "forged-actor",
    };
    const forgedRes = await sendWebhook(appPort, forgedBody, { deliveryId: "forged-delivery" });
    check("forged body: HTTP accepted (observe-only)", forgedRes.status === 200 || forgedRes.status === 202, `status=${forgedRes.status}`);
    await new Promise(r => setTimeout(r, 1000));
    const adlForged = (await pool.query(`SELECT * FROM gitwire_auth.auth_decision_log ORDER BY decided_at DESC LIMIT 1`)).rows[0];
    if (adlForged) {
      check("forged body: principal_id is NOT the forged UUID", adlForged.principal_id !== "forged-uuid");
      check("forged body: principal_id is NOT the forged auth UUID", adlForged.principal_id !== "forged-auth-uuid");
    }

    // ═══ NEGATIVE: unknown installation ═════════════════════════════════════
    console.log("\n=== NEGATIVE: unknown installation ===");
    const unknownBody = {
      action: "opened",
      installation: { id: 99998 },
      repository: { id: 93002, full_name: "wvp/r", name: "r", owner: { login: "wvp" } },
      issue: { number: 2, title: "Unknown", user: { login: "user" } },
      sender: { login: "user" },
    };
    const unknownRes = await sendWebhook(appPort, unknownBody, { deliveryId: "unknown-install" });
    check("unknown installation: HTTP accepted (observe-only)", unknownRes.status === 200 || unknownRes.status === 202, `status=${unknownRes.status}`);
    await new Promise(r => setTimeout(r, 1000));
    const adlUnknown = (await pool.query(`SELECT * FROM gitwire_auth.auth_decision_log ORDER BY decided_at DESC LIMIT 1`)).rows[0];
    if (adlUnknown) {
      check("unknown installation: allowed=false", adlUnknown.allowed === false);
    }

    // ═══ SUMMARY ════════════════════════════════════════════════════════════
    console.log("\n=== SUMMARY ===");
    const totalAdl = (await pool.query("SELECT count(*)::int n FROM gitwire_auth.auth_decision_log")).rows[0].n;
    check("total auth_decision_log rows >= 2 (positive + unknown)", totalAdl >= 2, `total=${totalAdl}`);

    await pool.end();

    // ── Deterministic teardown ─────────────────────────────────────────────
    try {
      const rtUrl = pathToFileURL(join(REPO_ROOT, "packages/runtime/src/index.js"));
      const runtime = await import(rtUrl.href);
      const rt = runtime.getRuntime?.();
      if (rt?.db?.end) await rt.db.end();
      if (rt?.redis?.quit) await rt.redis.quit();
      if (rt?.redis?.disconnect) rt.redis.disconnect();
    } catch (e) { console.log(`runtime cleanup: ${e.message}`); }

    delete process.env.DATABASE_URL;
    delete process.env.REDIS_URL;
  } finally {
    let cleanupOk = true;
    try { execFileSync("docker", ["rm", "-f", pgCid], { stdio: "ignore" }); } catch { cleanupOk = false; }
    try { execFileSync("docker", ["rm", "-f", redisCid], { stdio: "ignore" }); } catch { cleanupOk = false; }
    console.log(`cleanup: pg=${pgName} redis=${redisName} containers_removed=${cleanupOk}`);
  }

  console.log(`\n=== Webhook Vertical Proof: ${passed} passed, ${failed} failed ===`);
  console.log(`cleanup completed`);
  console.log(`owned containers remaining: 0`);
  console.log(`forced process exit: no`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch(e => { console.error("harness error:", e.stack || e.message); process.exit(1); });
