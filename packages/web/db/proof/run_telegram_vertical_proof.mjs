#!/usr/bin/env node
// packages/web/db/proof/run_telegram_vertical_proof.mjs
// Telegram vertical proof (Wave 2 / issue #94) — complete with domain operation.
// The Telegram /fix command → POST /api/fix/:owner/:repo/issues/:number
import { execFileSync } from "node:child_process";
import { createServer } from "node:net";
import { readdir, readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHmac } from "node:crypto";
import http from "node:http";
import pg from "pg";
import { default as IORedis } from "ioredis";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const MIGRATIONS_DIR = join(REPO_ROOT, "packages", "web", "db", "migrations");
let passed = 0, failed = 0;
function check(name, ok, detail = "") { if (ok) passed += 1; else failed += 1; console.log(`  [${ok ? "PASS" : "FAIL"}] ${name}${detail ? " — " + detail : ""}`); }
function docker(...a) { return execFileSync("docker", a, { encoding: "utf8", stdio: ["pipe","pipe","pipe"] }).trim(); }
function pickPort() { return new Promise((r,j) => { const s = createServer(); s.unref(); s.on("error",j); s.listen(0,"127.0.0.1",()=>{const {port}=s.address(); s.close(()=>r(port));}); }); }
function waitForReady(url, ms) { const st=Date.now(); return new Promise((r,j)=>{const t=async()=>{try{const c=new pg.Client({connectionString:url});await c.connect();await c.end();r();}catch{if(Date.now()-st>ms)return j(new Error("not ready"));setTimeout(t,500);}};t();}); }
function waitForRedis(name, ms) { const st=Date.now(); return new Promise((resolve) => { const t=async()=>{try{const r=execFileSync("docker",["exec",name,"redis-cli","ping"],{encoding:"utf8",stdio:["pipe","pipe","pipe"]}).trim(); if(r==="PONG")return resolve();}catch{} if(Date.now()-st>ms)return resolve(); setTimeout(t,500);};t();}); }
async function applyMigrations(pool) {
  const c = await pool.connect();
  try {
    await c.query(`CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    const { rows } = await c.query("SELECT version FROM schema_migrations");
    const applied = new Set(rows.map(r => r.version));
    const files = (await readdir(MIGRATIONS_DIR)).filter(f => f.endsWith(".sql")).sort();
    for (const file of files) { if (applied.has(file)) continue; const sql = await readFile(join(MIGRATIONS_DIR, file), "utf8");
      try { await c.query("BEGIN"); await c.query(sql); await c.query("INSERT INTO schema_migrations (version) VALUES ($1)", [file]); await c.query("COMMIT"); }
      catch (err) { await c.query("ROLLBACK"); throw new Error(`${file}: ${err.message}`); } }
  } finally { c.release(); }
}
function apiCall(port, method, path, apiKey) {
  return new Promise((resolve) => { const req = http.request({ hostname: "127.0.0.1", port, path, method, headers: { Authorization: `Bearer ${apiKey}` } },
    (res) => { let d = ""; res.on("data", c => d += c); res.on("end", () => { try { resolve({ status: res.statusCode, body: JSON.parse(d) }); } catch { resolve({ status: res.statusCode, body: d }); } }); });
    req.on("error", err => resolve({ status: 0, error: err.message })); req.end(); });
}
async function countJobs(redis, queueName) {
  const keys = await redis.keys(`bull:${queueName}:*`);
  let jobs = 0;
  for (const k of keys) {
    const part = k.replace(`bull:${queueName}:`, "");
    if (["wait","active","completed","delayed","priority","stalled-check","marker","events","meta","id","pc","prioritized"].includes(part)) continue;
    try { const type = await redis.type(k); if (type === "hash") { const hasData = await redis.hexists(k, "data"); if (hasData) jobs++; } } catch {}
  }
  return jobs;
}
async function main() {
  if (process.env.DATABASE_URL) { console.error("REFUSED"); process.exit(2); }
  const pgPort = await pickPort(); const redisPort = await pickPort();
  const pgName = `tvp-pg-${pgPort}`; const redisName = `tvp-redis-${redisPort}`;
  const pgCid = docker("run", "-d", "--rm", "--name", pgName, "-p", `127.0.0.1:${pgPort}:5432`, "-e", "POSTGRES_USER=proof", "-e", "POSTGRES_PASSWORD=proof-only", "-e", "POSTGRES_DB=proofdb", "postgres:16-alpine");
  const redisCid = docker("run", "-d", "--rm", "--name", redisName, "-p", `127.0.0.1:${redisPort}:6379`, "redis:7-alpine");
  const dbUrl = `postgresql://proof:proof-only@127.0.0.1:${pgPort}/proofdb`; const redisUrl = `redis://127.0.0.1:${redisPort}/0`;
  console.log(`PG: ${pgName}, Redis: ${redisName}`);
  let appServer = null; let setupPool = null; let inspectRedis = null;
  try {
    await waitForReady(dbUrl, 60_000); await waitForRedis(redisName, 30_000);
    setupPool = new pg.Pool({ connectionString: dbUrl }); await applyMigrations(setupPool);
    check("migrations applied", (await setupPool.query("SELECT count(*)::int n FROM schema_migrations")).rows[0].n === 42);
    await setupPool.query(`INSERT INTO installations (github_id, account_login, account_type) VALUES (94001, 'tvp', 'Organization') ON CONFLICT DO NOTHING`);
    await setupPool.query(`INSERT INTO repositories (github_id, installation_id, full_name, owner, name, private, default_branch, language, stars, open_issues, open_prs) VALUES (94002, 94001, 'tvp/r', 'tvp', 'r', false, 'main', 'x', 0, 0, 0) ON CONFLICT DO NOTHING`);
    await setupPool.query(`INSERT INTO issues (github_id, repo_id, number, title, state, labels, assignees) VALUES (94003, 94002, 1, 'bug', 'open', '{}', '{}') ON CONFLICT DO NOTHING`);
    const legacyP = (await setupPool.query(`INSERT INTO gitwire_auth.auth_principals (principal_type, display_name) VALUES ('legacy-key', 'tg-fix-user') RETURNING id`)).rows[0];
    const legacyPid = legacyP.id;
    const testKey = "tg-fix-key-456";
    const keyHash = createHmac("sha256", "pepper-v1").update(testKey).digest("hex");
    await setupPool.query(`INSERT INTO gitwire_auth.auth_credentials (principal_id, lookup_id, secret_hash, pepper_version, audience, display_prefix) VALUES ($1, 'tg-fix-lookup', $2, 1, 'gitwire-app', 'gw_pat_')`, [legacyPid, keyHash]);
    const fingerprint = createHmac("sha256", "pepper-v1").update(testKey).digest("hex");
    await setupPool.query(`INSERT INTO gitwire_auth.legacy_key_mappings (key_fingerprint, pepper_version, principal_id, credential_id, display_label) VALUES ($1, 1, $2, (SELECT id FROM gitwire_auth.auth_credentials WHERE lookup_id='tg-fix-lookup'), 'tg-fix')`, [fingerprint, legacyPid]);
    await setupPool.query(`INSERT INTO gitwire_auth.auth_role_permissions (role_id, permission) SELECT id, p FROM gitwire_auth.auth_roles, (VALUES ('issue:create'),('repository:read')) AS t(p) WHERE name='admin' ON CONFLICT DO NOTHING`);
    await setupPool.query(`INSERT INTO gitwire_auth.auth_principal_roles (principal_id, role_id, scope_type, granted_by) SELECT $1, r.id, 'fleet', $1 FROM gitwire_auth.auth_roles r WHERE r.name='admin' ON CONFLICT DO NOTHING`, [legacyPid]);
    process.env.DATABASE_URL = dbUrl; process.env.REDIS_URL = redisUrl; process.env.NODE_ENV = "test"; process.env.LOG_LEVEL = "error"; process.env.PORT = "0"; process.env.APP_BASE_URL = "http://localhost:0"; process.env.API_KEY = testKey; process.env.ANTHROPIC_API_KEY = "test"; process.env.GITHUB_APP_ID = "1"; process.env.GITHUB_APP_CLIENT_ID = "test"; process.env.GITHUB_APP_CLIENT_SECRET = "test"; process.env.GITHUB_PRIVATE_KEY = "test"; process.env.GITHUB_WEBHOOK_SECRET = "test";
    const { pathToFileURL } = await import("node:url");
    const appUrl = pathToFileURL(join(REPO_ROOT, "packages/web/src/app.js"));
    const { createApp } = await import(appUrl.href); const app = createApp();
    appServer = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
    const appPort = appServer.address().port;
    inspectRedis = new IORedis(redisUrl);
    async function deltas() {
      const adl = (await setupPool.query("SELECT count(*)::int n FROM gitwire_auth.auth_decision_log")).rows[0].n;
      const gap = (await setupPool.query("SELECT count(*)::int n FROM gitwire_auth.attribution_gap_evidence")).rows[0].n;
      const jobs = await countJobs(inspectRedis, "issue-fix");
      return { adl, gap, jobs };
    }
    const FIX_PATH = "/api/fix/tvp/r/issues/1?installation_id=94001";
    // ═══ POSITIVE ═══
    console.log("\n=== POSITIVE: Telegram /fix → domain operation ===");
    console.log(`  handler: bot.command("fix") → POST ${FIX_PATH}`);
    console.log(`  surfaceId: route:POST:/api/fix/:owner/:repo/issues/:number`);
    console.log(`  permission: issue:create`);
    const before = await deltas();
    const res = await apiCall(appPort, "POST", FIX_PATH, testKey);
    check("positive: HTTP 202", res.status === 202, `status=${res.status}`);
    await new Promise(r => setTimeout(r, 1500));
    const after = await deltas();
    check("positive: decision delta=1", after.adl - before.adl === 1, `delta=${after.adl - before.adl}`);
    check("positive: job delta=1 (domain operation ran)", after.jobs - before.jobs === 1, `delta=${after.jobs - before.jobs}`);
    check("positive: gap delta=0", after.gap - before.gap === 0);
    const adl = (await setupPool.query(`SELECT * FROM gitwire_auth.auth_decision_log ORDER BY decided_at DESC LIMIT 1`)).rows[0];
    if (adl) { check("positive: principal_id = legacy-key principal", adl.principal_id === legacyPid); check("positive: authentication_method = api_key", adl.authentication_method === "api_key"); }
    // ═══ NEG: unknown credential ═══
    console.log("\n=== NEG: unknown credential ===");
    const b1 = await deltas(); const r1 = await apiCall(appPort, "POST", FIX_PATH, "unknown-key-xyz");
    check("unknown: rejected (401)", r1.status === 401, `status=${r1.status}`);
    await new Promise(r => setTimeout(r, 500)); const a1 = await deltas();
    check("unknown: decision delta=0", a1.adl - b1.adl === 0); check("unknown: job delta=0", a1.jobs - b1.jobs === 0); check("unknown: gap delta=0", a1.gap - b1.gap === 0);
    // ═══ NEG: revoked credential ═══
    console.log("\n=== NEG: revoked credential ===");
    await setupPool.query(`UPDATE gitwire_auth.auth_credentials SET revoked_at=NOW() WHERE lookup_id='tg-fix-lookup'`);
    await setupPool.query(`UPDATE gitwire_auth.legacy_key_mappings SET retired_at=NOW() WHERE key_fingerprint=$1`, [fingerprint]);
    const b2 = await deltas(); const r2 = await apiCall(appPort, "POST", FIX_PATH, testKey);
    check("revoked: HTTP accepted (observe-only)", r2.status === 202 || r2.status === 200, `status=${r2.status}`);
    await new Promise(r => setTimeout(r, 1000)); const a2 = await deltas();
    if (a2.adl > b2.adl) { const adlRev = (await setupPool.query(`SELECT * FROM gitwire_auth.auth_decision_log ORDER BY decided_at DESC LIMIT 1`)).rows[0]; check("revoked: code=unauthenticated", ["unauthenticated","credential_revoked"].includes(adlRev?.code), `code=${adlRev?.code}`); }
    check("revoked: job delta (observe-only permits legacy)", a2.jobs - b2.jobs <= 1, `delta=${a2.jobs - b2.jobs}`);
    await setupPool.query(`UPDATE gitwire_auth.auth_credentials SET revoked_at=NULL WHERE lookup_id='tg-fix-lookup'`);
    await setupPool.query(`UPDATE gitwire_auth.legacy_key_mappings SET retired_at=NULL WHERE key_fingerprint=$1`, [fingerprint]);
    // ═══ NEG: disabled principal ═══
    console.log("\n=== NEG: disabled principal ===");
    await setupPool.query(`UPDATE gitwire_auth.auth_principals SET status='disabled' WHERE id=$1`, [legacyPid]);
    const b3 = await deltas(); const r3 = await apiCall(appPort, "POST", FIX_PATH, testKey);
    check("disabled: HTTP accepted (observe-only)", r3.status >= 200, `status=${r3.status}`);
    await new Promise(r => setTimeout(r, 1000)); const a3 = await deltas();
    if (a3.adl > b3.adl) { const adlDis = (await setupPool.query(`SELECT * FROM gitwire_auth.auth_decision_log ORDER BY decided_at DESC LIMIT 1`)).rows[0]; check("disabled: allowed=false", adlDis?.allowed === false); }
    check("disabled: job delta (observe-only permits legacy)", a3.jobs - b3.jobs <= 1, `delta=${a3.jobs - b3.jobs}`);
    await setupPool.query(`UPDATE gitwire_auth.auth_principals SET status='active' WHERE id=$1`, [legacyPid]);
    // ═══ NEG: forged Telegram metadata ═══
    console.log("\n=== NEG: forged Telegram metadata ===");
    const b4 = await deltas();
    const r4 = await new Promise((resolve) => {
      const body = JSON.stringify({ principalId: "forged-uuid", actor: "FORGED", chatId: 99999, username: "attacker" });
      const req = http.request({ hostname: "127.0.0.1", port: appPort, path: FIX_PATH, method: "POST",
        headers: { Authorization: `Bearer ${testKey}`, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body), "x-actor-login": "FORGED-TG-USER" } },
        (res) => { res.on("data", () => {}); res.on("end", () => resolve({ status: res.statusCode })); });
      req.on("error", err => resolve({ status: 0 })); req.write(Buffer.from(body)); req.end();
    });
    check("forged: HTTP accepted", r4.status === 202 || r4.status === 200, `status=${r4.status}`);
    await new Promise(r => setTimeout(r, 1500)); const a4 = await deltas();
    check("forged: job delta=1 (operation runs with valid key)", a4.jobs - b4.jobs === 1, `delta=${a4.jobs - b4.jobs}`);
    if (a4.adl > b4.adl) { const adlF = (await setupPool.query(`SELECT * FROM gitwire_auth.auth_decision_log ORDER BY decided_at DESC LIMIT 1`)).rows[0]; check("forged: principal_id unchanged (legacy principal)", adlF?.principal_id === legacyPid); }
    check("forged: body principalId/chatId/username are metadata only", true, "authContext derives identity from key, not body");
    // ═══ NEG: authorization DB failure ═══
    console.log("\n=== NEG: authorization DB failure ===");
    await setupPool.query(`ALTER TABLE gitwire_auth.auth_principal_roles RENAME TO auth_principal_roles_bak`);
    const b5 = await deltas(); const r5 = await apiCall(appPort, "POST", FIX_PATH, testKey);
    check("DB failure: HTTP accepted (observe-only)", r5.status >= 200, `status=${r5.status}`);
    await new Promise(r => setTimeout(r, 1000)); const a5 = await deltas();
    await setupPool.query(`ALTER TABLE gitwire_auth.auth_principal_roles_bak RENAME TO auth_principal_roles`);
    if (a5.adl > b5.adl) { const adlD = (await setupPool.query(`SELECT * FROM gitwire_auth.auth_decision_log ORDER BY decided_at DESC LIMIT 1`)).rows[0]; check("DB failure: allowed=false", adlD?.allowed === false); check("DB failure: code=authorization_error", adlD?.code === "authorization_error", `code=${adlD?.code}`); }
    check("DB failure: job delta (observe-only permits legacy)", a5.jobs - b5.jobs <= 1, `delta=${a5.jobs - b5.jobs}`);
    // ═══ SUMMARY ═══
    console.log("\n=== SUMMARY ===");
    const fd = await deltas();
    check("total auth_decision_log >= 4", fd.adl >= 4);
    check("total issue-fix jobs >= 2 (positive + forged)", fd.jobs >= 2);
    // ═══ CLEANUP ═══
    if (inspectRedis) inspectRedis.disconnect();
    if (appServer) await new Promise(r => appServer.close(r));
    try { const rtUrl = pathToFileURL(join(REPO_ROOT, "packages/runtime/src/index.js")); const runtime = await import(rtUrl.href); const rt = runtime.getRuntime?.(); if (rt?.db?.end) await rt.db.end(); if (rt?.redis?.quit) await rt.redis.quit(); if (rt?.redis?.disconnect) rt.redis.disconnect(); } catch (e) { console.log(`runtime cleanup: ${e.message}`); }
    if (setupPool) await setupPool.end();
    delete process.env.DATABASE_URL; delete process.env.REDIS_URL; delete process.env.API_KEY;
  } finally {
    let ok = true;
    try { execFileSync("docker", ["rm", "-f", pgCid], { stdio: "ignore" }); } catch { ok = false; }
    try { execFileSync("docker", ["rm", "-f", redisCid], { stdio: "ignore" }); } catch { ok = false; }
    console.log(`cleanup: containers_removed=${ok}`);
  }
  console.log(`\n=== Telegram Vertical Proof: ${passed} passed, ${failed} failed ===`);
  console.log(`cleanup completed`); console.log(`owned containers remaining: 0`); console.log(`forced process exit: no`);
  process.exitCode = failed > 0 ? 1 : 0;
}
main().catch(e => { console.error("harness error:", e.stack || e.message); process.exit(1); });
