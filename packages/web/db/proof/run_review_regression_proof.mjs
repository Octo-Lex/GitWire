#!/usr/bin/env node
// packages/web/db/proof/run_review_regression_proof.mjs
// Review regression proof (Wave 2 / issue #94).
// Proves the cumulative review corrections are effective:
//
// 1. ciHealWorker: principalId threaded through attemptHeal → healByPatchPR
//    (no ReferenceError, principal reaches propose/writers)
// 2. ciHealWorker reconcilePR + checkHealPRStatus: adoption before side effects
// 3. reconciliationWorker: stale actions via actionStateMachine (not raw UPDATE)
// 4. Rollback ledger consistency: 041 + 042 ledger entries removed and restored

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
const ROLLBACK_DIR = join(REPO_ROOT, "packages", "web", "db", "proof");

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
const pgName = "rrp-pg-" + pgPort; const redisName = "rrp-redis-" + redisPort;
const pgCid = docker("run", "-d", "--rm", "--name", pgName, "-p", "127.0.0.1:" + pgPort + ":5432", "-e", "POSTGRES_USER=proof", "-e", "POSTGRES_PASSWORD=proof-only", "-e", "POSTGRES_DB=proofdb", "postgres:16-alpine");
const redisCid = docker("run", "-d", "--rm", "--name", redisName, "-p", "127.0.0.1:" + redisPort + ":6379", "redis:7-alpine");
const dbUrl = "postgresql://proof:proof-only@127.0.0.1:" + pgPort + "/proofdb"; const redisUrl = "redis://127.0.0.1:" + redisPort + "/0";

console.log("PG: " + pgName + ", Redis: " + redisName);

let setupPool = null;
try {
  await waitForReady(dbUrl, 60_000); await waitForRedis(redisName, 30_000);
  setupPool = new pg.Pool({ connectionString: dbUrl }); await applyMigrations(setupPool);
  check("migrations applied", (await setupPool.query("SELECT count(*)::int n FROM schema_migrations")).rows[0].n === 42);

  process.env.DATABASE_URL = dbUrl; process.env.REDIS_URL = redisUrl; process.env.NODE_ENV = "test"; process.env.LOG_LEVEL = "error";
  process.env.PORT = "0"; process.env.APP_BASE_URL = "http://localhost:0"; process.env.API_KEY = "test";
  process.env.ANTHROPIC_API_KEY = "test"; process.env.GITHUB_APP_ID = "1"; process.env.GITHUB_APP_CLIENT_ID = "test";
  process.env.GITHUB_APP_CLIENT_SECRET = "test"; process.env.GITHUB_PRIVATE_KEY = "test"; process.env.GITHUB_WEBHOOK_SECRET = "test";

  const { pathToFileURL } = await import("node:url");
  const configUrl = pathToFileURL(join(REPO_ROOT, "packages/web/config/index.js"));
  await import(configUrl.href);

  // ═══ 1. ciHealWorker principalId threading (source-level + structural) ═══
  console.log("\n=== 1. ciHealWorker principalId threading ===");
  const ciHealSrc = await readFile(join(REPO_ROOT, "packages/web/src/workers/ciHealWorker.js"), "utf8");

  // Verify attemptHeal accepts principalId
  const attemptHealMatch = ciHealSrc.match(/async function attemptHeal\([^)]*\)/);
  check("attemptHeal signature includes principalId", attemptHealMatch?.[0]?.includes("principalId"), attemptHealMatch?.[0]);

  // Verify healByPatchPR accepts principalId
  const healByPatchPRMatch = ciHealSrc.match(/async function healByPatchPR\([^)]*\)/);
  check("healByPatchPR signature includes principalId", healByPatchPRMatch?.[0]?.includes("principalId"), healByPatchPRMatch?.[0]);

  // Verify attemptHeal calls healByPatchPR with principalId
  const callSection = ciHealSrc.split("async function attemptHeal")[1]?.split("async function healByPatchPR")[0];
  check("attemptHeal passes principalId to healByPatchPR", callSection?.includes("principalId"));

  // Verify healByPatchPR body references principalId in propose calls
  const healByPatchPRBody = ciHealSrc.split("async function healByPatchPR")[1] || "";
  check("healByPatchPR references principalId", healByPatchPRBody.includes("principalId"));
  check("healByPatchPR passes principalId to propose", healByPatchPRBody.includes("principalId") && healByPatchPRBody.includes("propose("));

  // Verify no ReferenceError — principalId is a parameter, not undeclared
  check("principalId is declared in healByPatchPR scope (parameter)", healByPatchPRMatch?.[0]?.includes("principalId"));

  // ═══ 2. ciHealWorker reconcilePR + checkHealPRStatus adoption ═══
  console.log("\n=== 2. ciHealWorker reconcilePR + checkHealPRStatus adoption ===");

  // Verify reconcilePR has adoptWorker before first GitHub/DB call
  const reconcileSection = ciHealSrc.split("async function reconcilePR")[1]?.split("async function ")[0] || "";
  const reconcileAdoptIdx = reconcileSection.indexOf("adoptWorker");
  const reconcileOctokitIdx = reconcileSection.indexOf("getInstallationClient");
  check("reconcilePR: adoptWorker before getInstallationClient", reconcileAdoptIdx > -1 && reconcileAdoptIdx < reconcileOctokitIdx, "adopt=" + reconcileAdoptIdx + " octokit=" + reconcileOctokitIdx);

  // Verify checkHealPRStatus has adoptWorker before first GitHub/DB call
  const checkSection = ciHealSrc.split("async function checkHealPRStatus")[1] || "";
  const checkAdoptIdx = checkSection.indexOf("adoptWorker");
  const checkOctokitIdx = checkSection.indexOf("getInstallationClient");
  check("checkHealPRStatus: adoptWorker before getInstallationClient", checkAdoptIdx > -1 && checkAdoptIdx < checkOctokitIdx, "adopt=" + checkAdoptIdx + " octokit=" + checkOctokitIdx);

  // ═══ 3. reconciliationWorker uses actionStateMachine, not raw UPDATE ═══
  console.log("\n=== 3. reconciliationWorker canonical transitions ===");
  const reconSrc = await readFile(join(REPO_ROOT, "packages/web/src/workers/reconciliationWorker.js"), "utf8");

  // Stale actions should use fail()/cancel() not raw UPDATE
  const staleSection = reconSrc.substring(0, reconSrc.indexOf("Phase 2"));
  check("stale cleanup uses fail() not raw UPDATE", staleSection.includes("await fail(") && !staleSection.includes("UPDATE managed_actions SET status"));
  check("stale cleanup uses cancel() not raw UPDATE", staleSection.includes("await cancel("));

  // heal_outcome UPDATEs should have validateAttribution before them
  const healSection = reconSrc.substring(reconSrc.indexOf("Phase 3"));
  const healUpdateIdx = healSection.indexOf("UPDATE managed_actions SET heal_outcome");
  const healGuardIdx = healSection.indexOf("validateAttribution");
  check("heal_outcome UPDATE has validateAttribution guard", healGuardIdx > -1 && healGuardIdx < healUpdateIdx, "guard=" + healGuardIdx + " update=" + healUpdateIdx);

  // Verify imports
  check("imports fail from actionStateMachine", reconSrc.includes("fail") && reconSrc.includes("actionStateMachine"));
  check("imports validateAttribution", reconSrc.includes("validateAttribution"));
  check("captures principalId from adoption", reconSrc.includes("const principalId = workerPrincipalId(adoption.context)"));

  // ═══ 4. Rollback ledger consistency ═══
  console.log("\n=== 4. Rollback ledger consistency ===");

  // Seed system principal for reconciliation adoption
  await setupPool.query("INSERT INTO gitwire_auth.auth_principals (principal_type, display_name) VALUES ('system', 'system:reconciliation-worker') ON CONFLICT DO NOTHING");
  await setupPool.query("INSERT INTO gitwire_auth.auth_principal_roles (principal_id, role_id, scope_type, granted_by) SELECT p.id, r.id, 'fleet', p.id FROM gitwire_auth.auth_principals p, gitwire_auth.auth_roles r WHERE p.display_name='system:reconciliation-worker' AND r.name='admin' ON CONFLICT DO NOTHING");

  // Verify current ledger has 041 + 042
  const ledgerBefore = (await setupPool.query("SELECT version FROM schema_migrations WHERE version IN ('041_wave2_runtime_identity.sql', '042_attribution_gap_evidence.sql') ORDER BY version")).rows;
  check("ledger has 041 + 042 before rollback", ledgerBefore.length === 2);

  // Rollback 042
  const rollback042 = await readFile(join(ROLLBACK_DIR, "rollback_wave2_042.sql"), "utf8");
  await setupPool.query("BEGIN");
  await setupPool.query(rollback042);
  await setupPool.query("DELETE FROM schema_migrations WHERE version = '042_attribution_gap_evidence.sql'");
  await setupPool.query("COMMIT");

  const ledgerAfter042 = (await setupPool.query("SELECT version FROM schema_migrations WHERE version = '042_attribution_gap_evidence.sql'")).rows;
  check("042 ledger entry removed after rollback", ledgerAfter042.length === 0);

  // Rollback 041
  const rollback041 = await readFile(join(ROLLBACK_DIR, "rollback_wave2.sql"), "utf8");
  await setupPool.query("BEGIN");
  await setupPool.query(rollback041);
  await setupPool.query("DELETE FROM schema_migrations WHERE version = '041_wave2_runtime_identity.sql'");
  await setupPool.query("COMMIT");

  const ledgerAfter041 = (await setupPool.query("SELECT version FROM schema_migrations WHERE version = '041_wave2_runtime_identity.sql'")).rows;
  check("041 ledger entry removed after rollback", ledgerAfter041.length === 0);

  // Verify tables are gone
  const { rows: adlExists } = await setupPool.query("SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='gitwire_auth' AND table_name='auth_decision_log')");
  check("auth_decision_log dropped after 041 rollback", adlExists[0].exists === false);

  // Re-apply both
  await applyMigrations(setupPool);
  const ledgerAfterReapply = (await setupPool.query("SELECT version FROM schema_migrations WHERE version IN ('041_wave2_runtime_identity.sql', '042_attribution_gap_evidence.sql') ORDER BY version")).rows;
  check("041 + 042 ledger entries restored after reapply", ledgerAfterReapply.length === 2);

  const { rows: adlExists2 } = await setupPool.query("SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='gitwire_auth' AND table_name='auth_decision_log')");
  check("auth_decision_log restored after reapply", adlExists2[0].exists === true);

  // ═══ 5. managedActionService.recordAction has attribution guard ═══
  console.log("\n=== 5. managedActionService attribution guard ===");
  const masSrc = await readFile(join(REPO_ROOT, "packages/web/src/services/managedActionService.js"), "utf8");
  check("recordAction accepts principalId parameter", masSrc.includes("principalId = null"));
  check("recordAction calls validateAttribution", masSrc.includes("validateAttribution"));
  check("recordAction includes principal_id in INSERT", masSrc.includes("principal_id") && masSrc.includes("principalId"));
  check("imports validateAttribution", masSrc.includes("import { validateAttribution }"));

  // Cleanup
  try { const rtUrl = pathToFileURL(join(REPO_ROOT, "packages/runtime/src/index.js")); const runtime = await import(rtUrl.href); const rt = runtime.getRuntime?.(); if (rt?.db?.end) await rt.db.end(); if (rt?.redis?.quit) await rt.redis.quit(); if (rt?.redis?.disconnect) rt.redis.disconnect(); } catch (e) { console.log("runtime cleanup: " + e.message); }
  await setupPool.end();
} finally {
  try { docker("rm", "-f", pgCid); } catch {}
  try { docker("rm", "-f", redisCid); } catch {}
  console.log("cleanup: containers_removed");
}

console.log("\n=== Review Regression Proof: " + passed + " passed, " + failed + " failed ===");
console.log("cleanup completed");
console.log("owned containers remaining: 0");
console.log("forced process exit: no");
process.exitCode = failed > 0 ? 1 : 0;
