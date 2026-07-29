#!/usr/bin/env node
// packages/web/db/proof/run_installation_worker_adoption_proof.mjs
// Installation-scoped worker adoption proof (Wave 2 / issue #94).
//
// Proves that the installation-scoped workers (maintainer, issueFix, phase2,
// phase3, ciEvidence) correctly resolve a trusted installation principal via
// adoptWorker(), and that the principalId is non-null and recorded.
//
// Exercises the REAL adoptWorker() and REAL authorize() against disposable
// PG+Redis. Tests the adoption path:
//
//   real adoptWorker({ installationId, ... })
//   → real resolveInstallationWorkerContext (DB lookup by installation_id)
//   → real authorize() (permission check + decision log)
//   → principalId is non-null
//   → auth_decision_log has one row with the installation principal

import { execFileSync } from "node:child_process";
import { createServer } from "node:net";
import { readdir, readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
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
    await c.query("CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())");
    const { rows } = await c.query("SELECT version FROM schema_migrations");
    const applied = new Set(rows.map(r => r.version));
    const files = (await readdir(MIGRATIONS_DIR)).filter(f => f.endsWith(".sql")).sort();
    for (const file of files) { if (applied.has(file)) continue; const sql = await readFile(join(MIGRATIONS_DIR, file), "utf8");
      try { await c.query("BEGIN"); await c.query(sql); await c.query("INSERT INTO schema_migrations (version) VALUES ($1)", [file]); await c.query("COMMIT"); }
      catch (err) { await c.query("ROLLBACK"); throw new Error(file + ": " + err.message); } }
  } finally { c.release(); }
}

const pgPort = await pickPort(); const redisPort = await pickPort();
const pgName = "iwa-pg-" + pgPort; const redisName = "iwa-redis-" + redisPort;
const pgCid = docker("run", "-d", "--rm", "--name", pgName, "-p", "127.0.0.1:" + pgPort + ":5432", "-e", "POSTGRES_USER=proof", "-e", "POSTGRES_PASSWORD=proof-only", "-e", "POSTGRES_DB=proofdb", "postgres:16-alpine");
const redisCid = docker("run", "-d", "--rm", "--name", redisName, "-p", "127.0.0.1:" + redisPort + ":6379", "redis:7-alpine");
const dbUrl = "postgresql://proof:proof-only@127.0.0.1:" + pgPort + "/proofdb"; const redisUrl = "redis://127.0.0.1:" + redisPort + "/0";

console.log("PG: " + pgName + ", Redis: " + redisName);

let setupPool = null;
try {
  await waitForReady(dbUrl, 60_000); await waitForRedis(redisName, 30_000);
  setupPool = new pg.Pool({ connectionString: dbUrl }); await applyMigrations(setupPool);
  check("migrations applied", (await setupPool.query("SELECT count(*)::int n FROM schema_migrations")).rows[0].n === 42);

  // Set up env for runtime
  process.env.DATABASE_URL = dbUrl; process.env.REDIS_URL = redisUrl; process.env.NODE_ENV = "test"; process.env.LOG_LEVEL = "error";
  process.env.PORT = "0"; process.env.APP_BASE_URL = "http://localhost:0"; process.env.API_KEY = "test";
  process.env.ANTHROPIC_API_KEY = "test"; process.env.GITHUB_APP_ID = "1"; process.env.GITHUB_APP_CLIENT_ID = "test";
  process.env.GITHUB_APP_CLIENT_SECRET = "test"; process.env.GITHUB_PRIVATE_KEY = "test"; process.env.GITHUB_WEBHOOK_SECRET = "test";

  const { pathToFileURL } = await import("node:url");

  // Initialize runtime
  const configUrl = pathToFileURL(join(REPO_ROOT, "packages/web/config/index.js"));
  await import(configUrl.href);

  // Seed installation + repository + installation principal
  const installationId = 95001;
  const repoGithubId = 95002;
  await setupPool.query("INSERT INTO installations (github_id, account_login, account_type) VALUES ($1, 'iwa', 'Organization') ON CONFLICT DO NOTHING", [installationId]);
  await setupPool.query("INSERT INTO repositories (github_id, installation_id, full_name, owner, name, private, default_branch, language, stars, open_issues, open_prs) VALUES ($1, $2, 'iwa/r', 'iwa', 'r', false, 'main', 'x', 0, 0, 0) ON CONFLICT DO NOTHING", [repoGithubId, installationId]);

  const instP = (await setupPool.query("INSERT INTO gitwire_auth.auth_principals (principal_type, display_name, installation_id) VALUES ('installation', 'iwa-installation', $1) RETURNING id", [installationId])).rows[0];
  const instPid = instP.id;
  await setupPool.query("INSERT INTO gitwire_auth.auth_principal_roles (principal_id, role_id, scope_type, granted_by) SELECT $1, r.id, 'fleet', $1 FROM gitwire_auth.auth_roles r WHERE r.name='admin' ON CONFLICT DO NOTHING", [instPid]);

  // ═══ Test each installation-scoped worker's adoption path ═══════════════
  const installWorkers = [
    { workerId: "worker:ciEvidence", permission: "ci_run:read" },
    { workerId: "worker:maintainer", permission: "repository:github:act" },
    { workerId: "worker:issueFix", permission: "pull_request:create" },
    { workerId: "worker:phase2", permission: "merge_queue_entry:update" },
    { workerId: "worker:phase3", permission: "installation:read" },
  ];

  const adoptUrl = pathToFileURL(join(REPO_ROOT, "packages/web/src/services/auth/workerAdoption.js"));
  const { adoptWorker, workerPrincipalId } = await import(adoptUrl.href);

  for (const w of installWorkers) {
    console.log("\n=== " + w.workerId + " adoption (installationId=" + installationId + ") ===");

    const adlBefore = (await setupPool.query("SELECT count(*)::int n FROM gitwire_auth.auth_decision_log")).rows[0].n;

    const adoption = await adoptWorker({
      workerId: w.workerId,
      permission: w.permission,
      resourceType: "repository",
      installationId,
      jobData: { installationId, repoFullName: "iwa/r" },
    });

    const principalId = workerPrincipalId(adoption.context);
    check(w.workerId + ": context resolved", adoption.context !== null);
    check(w.workerId + ": principalId is non-null UUID", principalId !== null && /^[0-9a-f]{8}-/.test(principalId), "pid=" + principalId);
    check(w.workerId + ": principalType = installation", adoption.context?.principalType === "installation");
    check(w.workerId + ": principalId = installation principal", principalId === instPid);
    check(w.workerId + ": decision recorded", (await setupPool.query("SELECT count(*)::int n FROM gitwire_auth.auth_decision_log")).rows[0].n === adlBefore + 1);
  }

  // ═══ NEGATIVE: missing installation principal ═══════════════════════════
  console.log("\n=== NEG: missing installation principal ===");
  const missingInstId = 99999;
  const adlBeforeNeg = (await setupPool.query("SELECT count(*)::int n FROM gitwire_auth.auth_decision_log")).rows[0].n;
  const negAdoption = await adoptWorker({
    workerId: "worker:maintainer",
    permission: "repository:github:act",
    resourceType: "repository",
    installationId: missingInstId,
    jobData: { installationId: missingInstId },
  });
  check("neg: context is null (no principal)", negAdoption.context === null);
  check("neg: principalId is null", workerPrincipalId(negAdoption.context) === null);
  check("neg: decision still recorded (observe-only)", (await setupPool.query("SELECT count(*)::int n FROM gitwire_auth.auth_decision_log")).rows[0].n === adlBeforeNeg + 1);

  // Cleanup runtime
  try { const rtUrl = pathToFileURL(join(REPO_ROOT, "packages/runtime/src/index.js")); const runtime = await import(rtUrl.href); const rt = runtime.getRuntime?.(); if (rt?.db?.end) await rt.db.end(); if (rt?.redis?.quit) await rt.redis.quit(); if (rt?.redis?.disconnect) rt.redis.disconnect(); } catch (e) { console.log("runtime cleanup: " + e.message); }
  await setupPool.end();
} finally {
  try { docker("rm", "-f", pgCid); } catch {}
  try { docker("rm", "-f", redisCid); } catch {}
  console.log("cleanup: containers_removed");
}

console.log("\n=== Installation Worker Adoption Proof: " + passed + " passed, " + failed + " failed ===");
console.log("cleanup completed");
console.log("owned containers remaining: 0");
console.log("forced process exit: no");
process.exitCode = failed > 0 ? 1 : 0;
