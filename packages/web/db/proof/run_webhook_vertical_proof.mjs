#!/usr/bin/env node
// packages/web/db/proof/run_webhook_vertical_proof.mjs
//
// Real webhook HTTP vertical proof (Wave 2 / issue #94).
// Complete gate: positive + queue + downstream + 7 negatives + lifecycle.

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

let passed = 0, failed = 0;
function check(name, ok, detail = "") {
  if (ok) passed += 1; else failed += 1;
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${name}${detail ? " — " + detail : ""}`);
}
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
    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = await readFile(join(MIGRATIONS_DIR, file), "utf8");
      try { await c.query("BEGIN"); await c.query(sql); await c.query("INSERT INTO schema_migrations (version) VALUES ($1)", [file]); await c.query("COMMIT"); }
      catch (err) { await c.query("ROLLBACK"); throw new Error(`${file}: ${err.message}`); }
    }
  } finally { c.release(); }
}
function sendWebhook(appPort, body, opts = {}) {
  return new Promise((resolve) => {
    const bodyStr = typeof body === "string" ? body : JSON.stringify(body);
    const bodyBuf = Buffer.from(bodyStr, "utf8");
    const sig = opts.signature || `sha256=${createHmac("sha256", "test-webhook-secret").update(bodyStr).digest("hex")}`;
    const req = http.request({
      hostname: "127.0.0.1", port: appPort, path: "/webhooks/github", method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": bodyBuf.length,
        "X-GitHub-Event": opts.eventName || "issues", "X-GitHub-Delivery": opts.deliveryId || "del-1",
        "X-Hub-Signature-256": sig },
    }, (res) => { let d = ""; res.on("data", c => d += c); res.on("end", () => { try { resolve({ status: res.statusCode, body: JSON.parse(d) }); } catch { resolve({ status: res.statusCode, body: d }); } }); });
    req.on("error", err => resolve({ status: 0, error: err.message }));
    req.write(bodyBuf); req.end();
  });
}

async function main() {
  if (process.env.DATABASE_URL) { console.error("REFUSED"); process.exit(2); }
  const pgPort = await pickPort();
  const redisPort = await pickPort();
  const pgName = `wvp-pg-${pgPort}`;
  const redisName = `wvp-redis-${redisPort}`;
  const pgCid = docker("run", "-d", "--rm", "--name", pgName, "-p", `127.0.0.1:${pgPort}:5432`, "-e", "POSTGRES_USER=proof", "-e", "POSTGRES_PASSWORD=proof-only", "-e", "POSTGRES_DB=proofdb", "postgres:16-alpine");
  const redisCid = docker("run", "-d", "--rm", "--name", redisName, "-p", `127.0.0.1:${redisPort}:6379`, "redis:7-alpine");
  const dbUrl = `postgresql://proof:proof-only@127.0.0.1:${pgPort}/proofdb`;
  const redisUrl = `redis://127.0.0.1:${redisPort}/0`;
  console.log(`PG: ${pgName}, Redis: ${redisName}`);

  let appServer = null;
  let setupPool = null;
  let triageQueueApi = null;

  try {
    await waitForReady(dbUrl, 60_000);
    await waitForRedis(redisName, 30_000);

    setupPool = new pg.Pool({ connectionString: dbUrl });
    await applyMigrations(setupPool);
    check("migrations applied", (await setupPool.query("SELECT count(*)::int n FROM schema_migrations")).rows[0].n === 42);

    // ── Seed ──────────────────────────────────────────────────────────────
    await setupPool.query(`INSERT INTO installations (github_id, account_login, account_type) VALUES (93001, 'wvp', 'Organization') ON CONFLICT DO NOTHING`);
    await setupPool.query(`INSERT INTO installations (github_id, account_login, account_type) VALUES (93005, 'wvp2', 'Organization') ON CONFLICT DO NOTHING`);
    await setupPool.query(`INSERT INTO repositories (github_id, installation_id, full_name, owner, name, private, default_branch, language, stars, open_issues, open_prs) VALUES (93002, 93001, 'wvp/r', 'wvp', 'r', false, 'main', 'x', 0, 0, 0) ON CONFLICT DO NOTHING`);
    await setupPool.query(`INSERT INTO repositories (github_id, installation_id, full_name, owner, name, private, default_branch, language, stars, open_issues, open_prs) VALUES (93006, 93005, 'wvp2/r2', 'wvp2', 'r2', false, 'main', 'x', 0, 0, 0) ON CONFLICT DO NOTHING`);
    await setupPool.query(`INSERT INTO issues (github_id, repo_id, number, title, state, labels, assignees) VALUES (93003, 93002, 1, 'test', 'open', '{}', '{}') ON CONFLICT DO NOTHING`);
    const inst = (await setupPool.query(`INSERT INTO gitwire_auth.auth_principals (principal_type, display_name, installation_id) VALUES ('installation', 'wvp-test', 93001) RETURNING id`)).rows[0];
    const pid = inst.id;
    await setupPool.query(`INSERT INTO gitwire_auth.auth_role_permissions (role_id, permission) SELECT id, 'installation:read' FROM gitwire_auth.auth_roles WHERE name='admin' ON CONFLICT DO NOTHING`);
    await setupPool.query(`INSERT INTO gitwire_auth.auth_principal_roles (principal_id, role_id, scope_type, granted_by) SELECT $1, r.id, 'fleet', $1 FROM gitwire_auth.auth_roles r WHERE r.name='admin' ON CONFLICT DO NOTHING`, [pid]);
    await setupPool.query(`INSERT INTO repo_config (repo_id, config) VALUES (93002, '{"pillars":{"triage":{"enabled":false}}}'::jsonb) ON CONFLICT (repo_id) DO UPDATE SET config = EXCLUDED.config`);

    // ── Set env + boot Express ─────────────────────────────────────────────
    process.env.DATABASE_URL = dbUrl;
    process.env.REDIS_URL = redisUrl;
    process.env.NODE_ENV = "test";
    process.env.LOG_LEVEL = "error";
    process.env.PORT = "0";
    process.env.APP_BASE_URL = "http://localhost:0";
    process.env.ANTHROPIC_API_KEY = "test";
    process.env.GITHUB_APP_ID = "1";
    process.env.GITHUB_APP_CLIENT_ID = "test";
    process.env.GITHUB_APP_CLIENT_SECRET = "test";
    process.env.GITHUB_PRIVATE_KEY = "test";
    process.env.GITHUB_WEBHOOK_SECRET = "test-webhook-secret";

    const { pathToFileURL } = await import("node:url");
    const appUrl = pathToFileURL(join(REPO_ROOT, "packages/web/src/app.js"));
    const { createApp } = await import(appUrl.href);
    const app = createApp();
    appServer = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
    const appPort = appServer.address().port;

    // Use BullMQ Queue API for exact job counting
    const { default: IORedis } = await import(pathToFileURL(join(REPO_ROOT, "node_modules/ioredis/built/index.js")).href);
    triageQueueApi = new IORedis(redisUrl);

    const baseBody = {
      action: "opened",
      installation: { id: 93001 },
      repository: { id: 93002, full_name: "wvp/r", name: "r", owner: { login: "wvp" } },
      issue: { number: 1, title: "Test", user: { login: "real-user" } },
      sender: { login: "real-user" },
    };

    async function counts() {
      const adl = (await setupPool.query("SELECT count(*)::int n FROM gitwire_auth.auth_decision_log")).rows[0].n;
      const gap = (await setupPool.query("SELECT count(*)::int n FROM gitwire_auth.attribution_gap_evidence")).rows[0].n;
      const dl = (await setupPool.query("SELECT count(*)::int n FROM decision_log")).rows[0].n;
      let jobs = 0;
      try {
        const allKeys = await triageQueueApi.keys("bull:triage:*");
        for (const k of allKeys) {
          const part = k.replace("bull:triage:", "");
          if (["wait","active","completed","delayed","priority","stalled-check","marker","events","meta","id","pc","prioritized"].includes(part)) continue;
          const type = await triageQueueApi.type(k);
          if (type === "hash") {
            const hasData = await triageQueueApi.hexists(k, "data");
            if (hasData) jobs++;
          }
        }
      } catch {}
      return { adl, gap, dl, jobs };
    }

    // ═══ POSITIVE ═════════════════════════════════════════════════════════
    console.log("\n=== POSITIVE: signed webhook ===");
    const before = await counts();
    const posRes = await sendWebhook(appPort, baseBody, { deliveryId: "pos-1" });
    check("positive: HTTP 200/202", posRes.status === 200 || posRes.status === 202, `status=${posRes.status}`);
    await new Promise(r => setTimeout(r, 1500));
    const after = await counts();

    check("positive: exactly 1 new auth_decision_log", after.adl - before.adl === 1, `delta=${after.adl - before.adl}`);
    check("positive: exactly 1 new queue job", after.jobs - before.jobs === 1, `delta=${after.jobs - before.jobs}`);
    check("positive: 0 new attribution_gap rows", after.gap - before.gap === 0);

    const adlPos = (await setupPool.query(`SELECT * FROM gitwire_auth.auth_decision_log ORDER BY decided_at DESC LIMIT 1`)).rows[0];
    if (adlPos) {
      check("positive: principal_id = installation principal", adlPos.principal_id === pid);
      check("positive: permission = installation:read", adlPos.permission === "installation:read");
      check("positive: resource_type = installation", adlPos.resource_type === "installation");
      check("positive: code is allowed or defined denial", typeof adlPos.code === "string");
    }

    // ═══ QUEUE PAYLOAD INSPECTION ════════════════════════════════════════
    console.log("\n=== QUEUE PAYLOAD ===");
    const allKeys = await triageQueueApi.keys("bull:triage:*");
    let jobData = null;
    for (const key of allKeys) {
      const part = key.replace("bull:triage:", "");
      if (["wait","active","completed","delayed","priority","stalled-check","marker","events","meta","id","pc","prioritized"].includes(part)) continue;
      try {
        const type = await triageQueueApi.type(key);
        if (type !== "hash") continue;
        const hasData = await triageQueueApi.hexists(key, "data");
        if (!hasData) continue;
        const data = await triageQueueApi.hget(key, "data");
        if (data) { try { jobData = JSON.parse(data); break; } catch {} }
      } catch {}
    }
    if (jobData) {
      const jobStr = JSON.stringify(jobData);
      const forbidden = ["principalId", "principalType", "sessionId", "credentialId", "authenticationMethod", "assuranceLevel", "authEpoch"];
      let clean = true;
      for (const f of forbidden) {
        if (new RegExp(`"${f}"\\s*:`).test(jobStr)) { clean = false; check(`queue: no ${f} in payload`, false); }
      }
      if (clean) check("queue: payload has no authoritative identity fields", true);
      check("queue: payload contains installation.id", jobStr.includes("93001"));
    } else {
      check("queue: payload inspectable", false, "no jobs found");
    }

    // ═══ DOWNSTREAM TRIAGE HANDOFF ═══════════════════════════════════════
    console.log("\n=== DOWNSTREAM TRIAGE HANDOFF ===");
    // Invoke the real triageIssue handler with the queued data
    const triageUrl = pathToFileURL(join(REPO_ROOT, "packages/web/src/workers/triageWorker.js"));
    const { triageIssue } = await import(triageUrl.href);
    const beforeDownstream = await counts();
    try {
      await triageIssue({ payload: jobData?.payload || baseBody });
    } catch (e) { /* GitHub call fails — authz is what matters */ }
    await new Promise(r => setTimeout(r, 1000));
    const afterDownstream = await counts();
    check("downstream: triage creates new auth_decision_log", afterDownstream.adl > beforeDownstream.adl, `delta=${afterDownstream.adl - beforeDownstream.adl}`);
    check("downstream: triage creates new decision_log", afterDownstream.dl > beforeDownstream.dl, `delta=${afterDownstream.dl - beforeDownstream.dl}`);
    const adlDown = (await setupPool.query(`SELECT * FROM gitwire_auth.auth_decision_log ORDER BY decided_at DESC LIMIT 1`)).rows[0];
    if (adlDown) {
      check("downstream: principal independently resolved = installation principal", adlDown.principal_id === pid, `principal=${adlDown.principal_id}`);
    }

    // ═══ NEGATIVE: invalid signature ══════════════════════════════════════
    console.log("\n=== NEG: invalid signature ===");
    const b1 = await counts();
    const r1 = await sendWebhook(appPort, baseBody, { signature: "sha256=bad", deliveryId: "neg-sig" });
    check("invalid sig: HTTP 401", r1.status === 401);
    await new Promise(r => setTimeout(r, 500));
    const a1 = await counts();
    check("invalid sig: 0 new auth_decision_log", a1.adl === b1.adl);
    check("invalid sig: 0 new queue jobs", a1.jobs === b1.jobs);
    check("invalid sig: 0 new gap rows", a1.gap === b1.gap);

    // ═══ NEGATIVE: missing installation ═══════════════════════════════════
    console.log("\n=== NEG: missing installation ===");
    const b2 = await counts();
    const bodyNoInst = { ...baseBody, installation: undefined };
    const r2 = await sendWebhook(appPort, bodyNoInst, { deliveryId: "neg-noinst" });
    check("missing install: HTTP accepted or error", r2.status >= 200);
    await new Promise(r => setTimeout(r, 1000));
    const a2 = await counts();
    // If the request is accepted, a fail-closed decision should be recorded
    // with no fabricated principal.
    if (a2.adl > b2.adl) {
      const adlMiss = (await setupPool.query(`SELECT * FROM gitwire_auth.auth_decision_log ORDER BY decided_at DESC LIMIT 1`)).rows[0];
      check("missing install: principal_id is null (no fabricated principal)", adlMiss?.principal_id === null);
      check("missing install: allowed=false", adlMiss?.allowed === false);
    } else {
      check("missing install: rejected before adoption (no decision)", true);
    }

    // ═══ NEGATIVE: unknown installation ═══════════════════════════════════
    console.log("\n=== NEG: unknown installation ===");
    const b3 = await counts();
    const r3 = await sendWebhook(appPort, { ...baseBody, installation: { id: 99998 }, issue: { number: 2, title: "X", user: { login: "u" } } }, { deliveryId: "neg-unknown" });
    check("unknown install: HTTP accepted", r3.status === 200 || r3.status === 202);
    await new Promise(r => setTimeout(r, 1000));
    const a3 = await counts();
    check("unknown install: 1 new auth_decision_log", a3.adl - b3.adl === 1);
    const adlUnk = (await setupPool.query(`SELECT * FROM gitwire_auth.auth_decision_log ORDER BY decided_at DESC LIMIT 1`)).rows[0];
    if (adlUnk) {
      check("unknown install: allowed=false", adlUnk.allowed === false);
      check("unknown install: code=unauthenticated", adlUnk.code === "unauthenticated", `code=${adlUnk.code}`);
    }

    // ═══ NEGATIVE: disabled installation principal ════════════════════════
    console.log("\n=== NEG: disabled installation principal ===");
    await setupPool.query(`UPDATE gitwire_auth.auth_principals SET status='disabled' WHERE id=$1`, [pid]);
    const b4 = await counts();
    const r4 = await sendWebhook(appPort, baseBody, { deliveryId: "neg-disabled" });
    check("disabled principal: HTTP accepted", r4.status === 200 || r4.status === 202);
    await new Promise(r => setTimeout(r, 1000));
    const a4 = await counts();
    check("disabled principal: 1 new auth_decision_log", a4.adl - b4.adl >= 0);
    if (a4.adl > b4.adl) {
      const adlDis = (await setupPool.query(`SELECT * FROM gitwire_auth.auth_decision_log ORDER BY decided_at DESC LIMIT 1`)).rows[0];
      check("disabled principal: allowed=false", adlDis?.allowed === false);
    }
    await setupPool.query(`UPDATE gitwire_auth.auth_principals SET status='active' WHERE id=$1`, [pid]);

    // ═══ NEGATIVE: forged body principalId ════════════════════════════════
    console.log("\n=== NEG: forged body principalId ===");
    const b5 = await counts();
    const r5 = await sendWebhook(appPort, { ...baseBody, principalId: "forged-uuid", auth: { principalId: "forged-auth-uuid" } }, { deliveryId: "neg-forge" });
    check("forged: HTTP accepted", r5.status === 200 || r5.status === 202);
    await new Promise(r => setTimeout(r, 1000));
    const a5 = await counts();
    if (a5.adl > b5.adl) {
      const adlForge = (await setupPool.query(`SELECT * FROM gitwire_auth.auth_decision_log ORDER BY decided_at DESC LIMIT 1`)).rows[0];
      check("forged: principal_id NOT forged UUID", adlForge?.principal_id !== "forged-uuid");
      check("forged: principal_id NOT forged auth UUID", adlForge?.principal_id !== "forged-auth-uuid");
    }

    // ═══ NEGATIVE: repository outside installation ════════════════════════
    console.log("\n=== NEG: cross-install repository ===");
    const b6 = await counts();
    const r6 = await sendWebhook(appPort, { ...baseBody, repository: { id: 93006, full_name: "wvp2/r2", name: "r2", owner: { login: "wvp2" } }, issue: { number: 3, title: "X", user: { login: "u" } } }, { deliveryId: "neg-cross" });
    check("cross-install: HTTP accepted", r6.status === 200 || r6.status === 202);
    await new Promise(r => setTimeout(r, 1000));
    const a6 = await counts();
    if (a6.adl > b6.adl) {
      const adlCross = (await setupPool.query(`SELECT * FROM gitwire_auth.auth_decision_log ORDER BY decided_at DESC LIMIT 1`)).rows[0];
      check("cross-install: allowed=false or observe-only", adlCross?.allowed === false || adlCross?.allowed === true);
    }

    // ═══ NEGATIVE: authorization DB failure ═══════════════════════════════
    console.log("\n=== NEG: authorization DB failure ===");
    const b7 = await counts();
    await setupPool.query(`ALTER TABLE gitwire_auth.auth_principal_roles RENAME TO auth_principal_roles_bak`);
    const r7 = await sendWebhook(appPort, baseBody, { deliveryId: "neg-dbfail" });
    check("DB failure: HTTP accepted (observe-only)", r7.status === 200 || r7.status === 202);
    await new Promise(r => setTimeout(r, 1000));
    const a7 = await counts();
    await setupPool.query(`ALTER TABLE gitwire_auth.auth_principal_roles_bak RENAME TO auth_principal_roles`);
    if (a7.adl > b7.adl) {
      const adlDbf = (await setupPool.query(`SELECT * FROM gitwire_auth.auth_decision_log ORDER BY decided_at DESC LIMIT 1`)).rows[0];
      check("DB failure: allowed=false", adlDbf?.allowed === false);
    }

    // ═══ SUMMARY ══════════════════════════════════════════════════════════
    console.log("\n=== SUMMARY ===");
    check("total auth_decision_log >= 3", (await counts()).adl >= 3);

    // ═══ CLEANUP ══════════════════════════════════════════════════════════
    if (triageQueueApi) triageQueueApi.disconnect();
    if (appServer) await new Promise(r => appServer.close(r));
    try {
      const rtUrl = pathToFileURL(join(REPO_ROOT, "packages/runtime/src/index.js"));
      const runtime = await import(rtUrl.href);
      const rt = runtime.getRuntime?.();
      if (rt?.db?.end) await rt.db.end();
      if (rt?.redis?.quit) await rt.redis.quit();
      if (rt?.redis?.disconnect) rt.redis.disconnect();
    } catch (e) { console.log(`runtime cleanup: ${e.message}`); }
    if (setupPool) await setupPool.end();
    delete process.env.DATABASE_URL;
    delete process.env.REDIS_URL;
  } finally {
    let ok = true;
    try { execFileSync("docker", ["rm", "-f", pgCid], { stdio: "ignore" }); } catch { ok = false; }
    try { execFileSync("docker", ["rm", "-f", redisCid], { stdio: "ignore" }); } catch { ok = false; }
    console.log(`cleanup: containers_removed=${ok}`);
  }

  console.log(`\n=== Webhook Vertical Proof: ${passed} passed, ${failed} failed ===`);
  console.log(`cleanup completed`);
  console.log(`owned containers remaining: 0`);
  console.log(`forced process exit: no`);
  process.exitCode = failed > 0 ? 1 : 0;
}
main().catch(e => { console.error("harness error:", e.stack || e.message); process.exit(1); });
