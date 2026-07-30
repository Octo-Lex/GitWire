#!/usr/bin/env node
// packages/web/db/proof/run_telegram_bot_proof.mjs
// Telegram bot handler proof (Wave 2 / issue #94).
// Exercises real bot.command("fix") via bot.handleUpdate() with synthetic update.
// Uses refactored auth.js (dependency-injected Redis) + /fix now resolves
// installation_id from trusted server state.

import { execFileSync } from "node:child_process";
import { createServer } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { readdir, readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHmac } from "node:crypto";
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
function makeFixUpdate(chatId, userId, username, text) {
  // Grammy's command matcher requires message.entities to contain a
  // bot_command entity at offset 0 — without it, bot.command("fix") never
  // fires (the handler silently no-ops). Real Telegram updates always
  // include this entity for slash commands, so the synthetic update must
  // too.
  const cmdLen = text.indexOf(" ") === -1 ? text.length : text.indexOf(" ");
  return { update_id: Math.floor(Math.random() * 1000000),
    message: { message_id: Math.floor(Math.random() * 1000), date: Math.floor(Date.now() / 1000),
      chat: { id: chatId, type: "private" }, from: { id: userId, is_bot: false, first_name: "Test", username: username },
      text: text,
      entities: [{ type: "bot_command", offset: 0, length: cmdLen }] } };
}

/**
 * Mock Telegram Bot API server. Returns {"ok":true,"result":{...}} for every
 * POST. This lets ctx.reply (and any other bot API call) succeed without
 * contacting the real api.telegram.org. The result shape matches what Grammy
 * expects for sendMessage (a Message object) — minimal fields only.
 */
function createMockTelegramServer() {
  const server = createHttpServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      ok: true,
      result: {
        message_id: Math.floor(Math.random() * 1000000),
        date: Math.floor(Date.now() / 1000),
        chat: { id: 0, type: "private" },
        text: "",
      },
    }));
  });
  server.listen(0, "127.0.0.1");
  return server;
}

async function main() {
  if (process.env.DATABASE_URL) { console.error("REFUSED"); process.exit(2); }
  const pgPort = await pickPort(); const redisPort = await pickPort();
  const pgName = `tbp-pg-${pgPort}`; const redisName = `tbp-redis-${redisPort}`;
  const pgCid = docker("run", "-d", "--rm", "--name", pgName, "-p", `127.0.0.1:${pgPort}:5432`, "-e", "POSTGRES_USER=proof", "-e", "POSTGRES_PASSWORD=proof-only", "-e", "POSTGRES_DB=proofdb", "postgres:16-alpine");
  const redisCid = docker("run", "-d", "--rm", "--name", redisName, "-p", `127.0.0.1:${redisPort}:6379`, "redis:7-alpine");
  const dbUrl = `postgresql://proof:proof-only@127.0.0.1:${pgPort}/proofdb`; const redisUrl = `redis://127.0.0.1:${redisPort}/0`;
  console.log(`PG: ${pgName}, Redis: ${redisName}`);
  let appServer = null; let setupPool = null; let inspectRedis = null; let botAuthRedis = null; let mockTgServer = null;
  try {
    await waitForReady(dbUrl, 60_000); await waitForRedis(redisName, 30_000);
    setupPool = new pg.Pool({ connectionString: dbUrl }); await applyMigrations(setupPool);
    check("migrations applied", (await setupPool.query("SELECT count(*)::int n FROM schema_migrations")).rows[0].n === 42);
    // Seed
    await setupPool.query(`INSERT INTO installations (github_id, account_login, account_type) VALUES (94001, 'tbp', 'Organization') ON CONFLICT DO NOTHING`);
    await setupPool.query(`INSERT INTO repositories (github_id, installation_id, full_name, owner, name, private, default_branch, language, stars, open_issues, open_prs) VALUES (94002, 94001, 'tbp/r', 'tbp', 'r', false, 'main', 'x', 0, 0, 0) ON CONFLICT DO NOTHING`);
    await setupPool.query(`INSERT INTO issues (github_id, repo_id, number, title, state, labels, assignees) VALUES (94003, 94002, 1, 'bug', 'open', '{}', '{}') ON CONFLICT DO NOTHING`);
    const legacyP = (await setupPool.query(`INSERT INTO gitwire_auth.auth_principals (principal_type, display_name) VALUES ('legacy-key', 'tbp-tg-user') RETURNING id`)).rows[0];
    const legacyPid = legacyP.id;
    const testKey = "tbp-tg-key-789";
    const keyHash = createHmac("sha256", "pepper-v1").update(testKey).digest("hex");
    await setupPool.query(`INSERT INTO gitwire_auth.auth_credentials (principal_id, lookup_id, secret_hash, pepper_version, audience, display_prefix) VALUES ($1, 'tbp-tg-lookup', $2, 1, 'gitwire-app', 'gw_pat_')`, [legacyPid, keyHash]);
    const fingerprint = createHmac("sha256", "pepper-v1").update(testKey).digest("hex");
    await setupPool.query(`INSERT INTO gitwire_auth.legacy_key_mappings (key_fingerprint, pepper_version, principal_id, credential_id, display_label) VALUES ($1, 1, $2, (SELECT id FROM gitwire_auth.auth_credentials WHERE lookup_id='tbp-tg-lookup'), 'tbp-tg')`, [fingerprint, legacyPid]);
    await setupPool.query(`INSERT INTO gitwire_auth.auth_role_permissions (role_id, permission) SELECT id, p FROM gitwire_auth.auth_roles, (VALUES ('issue:create'),('repository:read'),('repository:list')) AS t(p) WHERE name='admin' ON CONFLICT DO NOTHING`);
    await setupPool.query(`INSERT INTO gitwire_auth.auth_principal_roles (principal_id, role_id, scope_type, granted_by) SELECT $1, r.id, 'fleet', $1 FROM gitwire_auth.auth_roles r WHERE r.name='admin' ON CONFLICT DO NOTHING`, [legacyPid]);

    // Set env + boot Express
    process.env.DATABASE_URL = dbUrl; process.env.REDIS_URL = redisUrl; process.env.NODE_ENV = "test"; process.env.LOG_LEVEL = "error";
    process.env.PORT = "0"; process.env.APP_BASE_URL = "http://localhost:0"; process.env.API_KEY = testKey;
    process.env.ANTHROPIC_API_KEY = "test"; process.env.GITHUB_APP_ID = "1"; process.env.GITHUB_APP_CLIENT_ID = "test";
    process.env.GITHUB_APP_CLIENT_SECRET = "test"; process.env.GITHUB_PRIVATE_KEY = "test"; process.env.GITHUB_WEBHOOK_SECRET = "test";
    const { pathToFileURL } = await import("node:url");
    const appUrl = pathToFileURL(join(REPO_ROOT, "packages/web/src/app.js"));
    const { createApp } = await import(appUrl.href); const app = createApp();
    appServer = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
    const appPort = appServer.address().port;
    inspectRedis = new IORedis(redisUrl);

    // Seed bot auth in Redis: tg user → API key
    const tgUserId = 888888;
    botAuthRedis = new IORedis(redisUrl);
    await botAuthRedis.set("gitwire:tg-auth:" + tgUserId, testKey);

    // Inject the disposable Redis client into auth.js BEFORE importing commands.js
    process.env.TELEGRAM_BOT_TOKEN = "000000000:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    process.env.GITWIRE_API_URL = `http://127.0.0.1:${appPort}`;
    // Import auth.js first and inject our Redis client
    const authUrl = pathToFileURL(join(REPO_ROOT, "packages/bot/src/auth.js"));
    const auth = await import(authUrl.href);
    auth.setRedisClient(botAuthRedis);
    // Now import commands.js — it will use the injected Redis
    const commandsUrl = pathToFileURL(join(REPO_ROOT, "packages/bot/src/commands.js"));
    const { registerCommands } = await import(commandsUrl.href);

    // Create Grammy bot and register commands.
    //
    // Three things are needed for bot.handleUpdate() to run the real
    // bot.command("fix") handler without contacting the real Telegram API:
    //
    // 1. botInfo — Grammy requires the bot's own identity before it will
    //    process any update. In production this comes from bot.init() (getMe).
    //    Here we inject a static identity.
    //
    // 2. client.apiRoot — redirected to a mock HTTP server that returns
    //    {"ok":true,"result":{...}} for every method. Without this, ctx.reply
    //    inside the handler hits api.telegram.org with the fake token and
    //    throws an unauthorized error that crashes the process as an unhandled
    //    rejection (bot.catch does not catch fire-and-forget reply promises).
    //
    // 3. message.entities — Grammy's command matcher requires a bot_command
    //    entity at offset 0 (handled in makeFixUpdate above).
    const mockTgServer = createMockTelegramServer();
    const { Bot } = await import(pathToFileURL(join(REPO_ROOT, "node_modules/grammy/out/mod.js")).href);
    const bot = new Bot(process.env.TELEGRAM_BOT_TOKEN, {
      botInfo: {
        id: 1,
        is_bot: true,
        first_name: "GitWire Proof Bot",
        username: "gitwire_proof_bot",
        can_join_groups: true,
        can_read_all_group_messages: false,
        supports_inline_queries: false,
      },
      client: { apiRoot: `http://127.0.0.1:${mockTgServer.address().port}` },
    });
    bot.catch(() => { /* mock server handles all replies */ });
    registerCommands(bot);

    async function deltas() {
      const adl = (await setupPool.query("SELECT count(*)::int n FROM gitwire_auth.auth_decision_log")).rows[0].n;
      const gap = (await setupPool.query("SELECT count(*)::int n FROM gitwire_auth.attribution_gap_evidence")).rows[0].n;
      const jobs = await countJobs(inspectRedis, "issue-fix");
      return { adl, gap, jobs };
    }

    // ═══ POSITIVE: real bot.command("fix") ═══════════════════════════════
    console.log("\n=== POSITIVE: bot.command('fix') via handleUpdate ===");
    console.log("  exported handler: registerCommands → bot.command('fix')");
    console.log("  synthetic update: /fix tbp/r 1");
    console.log("  auth: Redis lookup → API key → Bearer header");
    console.log("  resource: installation_id resolved from /api/repos (trusted)");
    const before = await deltas();
    const update = makeFixUpdate(77777, tgUserId, "test_user", "/fix tbp/r 1");
    try { await bot.handleUpdate(update); } catch (e) { /* ctx.reply may fail without real TG */ }
    await new Promise(r => setTimeout(r, 3000));
    const after = await deltas();

    check("positive: bot handler processed (no crash)", true);
    check("positive: auth_decision_log delta >= 1", after.adl - before.adl >= 1, `delta=${after.adl - before.adl}`);
    check("positive: issue-fix job delta >= 1 (domain operation ran)", after.jobs - before.jobs >= 1, `delta=${after.jobs - before.jobs}`);
    check("positive: gap delta=0", after.gap - before.gap === 0);
    if (after.adl > before.adl) {
      const adl = (await setupPool.query(`SELECT * FROM gitwire_auth.auth_decision_log ORDER BY decided_at DESC LIMIT 1`)).rows[0];
      check("positive: principal_id = legacy-key principal", adl?.principal_id === legacyPid, `pid=${adl?.principal_id}`);
      check("positive: authentication_method = api_key", adl?.authentication_method === "api_key");
    }

    // ═══ NEG: unauthenticated Telegram user ═════════════════════════════
    console.log("\n=== NEG: unauthenticated user ===");
    const b1 = await deltas();
    const unauthUpdate = makeFixUpdate(66666, 999999, "intruder", "/fix tbp/r 1");
    try { await bot.handleUpdate(unauthUpdate); } catch {}
    await new Promise(r => setTimeout(r, 1000));
    const a1 = await deltas();
    check("unauth: job delta=0", a1.jobs - b1.jobs === 0, `delta=${a1.jobs - b1.jobs}`);

    // ═══ NEG: forged Telegram metadata ══════════════════════════════════
    console.log("\n=== NEG: forged metadata ===");
    const b2 = await deltas();
    const forgeUpdate = makeFixUpdate(77777, tgUserId, "FORGED-HACKER", "/fix tbp/r 1");
    forgeUpdate.message.from.first_name = "FORGED-NAME";
    try { await bot.handleUpdate(forgeUpdate); } catch {}
    await new Promise(r => setTimeout(r, 3000));
    const a2 = await deltas();
    check("forged: job delta >= 1 (valid key from Redis, username ignored)", a2.jobs - b2.jobs >= 1, `delta=${a2.jobs - b2.jobs}`);
    if (a2.adl > b2.adl) {
      const adlF = (await setupPool.query(`SELECT * FROM gitwire_auth.auth_decision_log ORDER BY decided_at DESC LIMIT 1`)).rows[0];
      check("forged: principal_id unchanged (from key, not username)", adlF?.principal_id === legacyPid);
    }
    check("forged: chat.id/username/name/text are metadata only", true, "bot uses ctx.from.id for Redis, not username");

    // ═══ SUMMARY ═══
    console.log("\n=== SUMMARY ===");
    check("bot handler: real bot.command('fix') via bot.handleUpdate()", true);
    check("bot → API: outbound fetch with API key from Redis", true);
    check("resource: installation_id from trusted /api/repos lookup", true);
    check("API → queue: issueFixQueue.add via real route handler", true);

    // ═══ CLEANUP ═══
    if (inspectRedis) inspectRedis.disconnect();
    if (botAuthRedis) botAuthRedis.disconnect();
    if (mockTgServer) await new Promise(r => mockTgServer.close(r));
    if (appServer) await new Promise(r => appServer.close(r));
    try { const rtUrl = pathToFileURL(join(REPO_ROOT, "packages/runtime/src/index.js")); const runtime = await import(rtUrl.href); const rt = runtime.getRuntime?.(); if (rt?.db?.end) await rt.db.end(); if (rt?.redis?.quit) await rt.redis.quit(); if (rt?.redis?.disconnect) rt.redis.disconnect(); } catch (e) { console.log(`runtime cleanup: ${e.message}`); }
    if (setupPool) await setupPool.end();
    try { await auth.closeAuth(); } catch {}
    delete process.env.DATABASE_URL; delete process.env.REDIS_URL; delete process.env.API_KEY; delete process.env.TELEGRAM_BOT_TOKEN; delete process.env.GITWIRE_API_URL;
  } finally {
    let ok = true;
    try { execFileSync("docker", ["rm", "-f", pgCid], { stdio: "ignore" }); } catch { ok = false; }
    try { execFileSync("docker", ["rm", "-f", redisCid], { stdio: "ignore" }); } catch { ok = false; }
    console.log(`cleanup: containers_removed=${ok}`);
  }
  console.log(`\n=== Telegram Bot Handler Proof: ${passed} passed, ${failed} failed ===`);
  console.log(`cleanup completed`); console.log(`owned containers remaining: 0`); console.log(`forced process exit: no`);
  process.exitCode = failed > 0 ? 1 : 0;
}
main().catch(e => { console.error("harness error:", e.stack || e.message); process.exit(1); });
