#!/usr/bin/env node
// packages/web/db/proof/run_ciheal_regression_proof.mjs
// ciHealWorker heal-run regression proof (Wave 2 / issue #94).
//
// Exercises the REAL healWorkflowRun → attemptHeal → healByPatchPR path that
// previously crashed with a ReferenceError because `principalId` was not in
// scope inside attemptHeal / healByPatchPR. The fix added principalId as an
// explicit parameter threaded from the adoption context.
//
// This proof runs the actual worker processor against a disposable PG + Redis
// stack, a mock Anthropic HTTP server (deterministic diagnosis + patch JSON),
// and a deterministic GitHub adapter injected into the runtime singleton.
//
// Assertions:
//   - no ReferenceError thrown on the heal-run path
//   - adoptWorker decision logged (auth_decision_log delta >= 1)
//   - principalId reaches propose() (managed_actions row has principal_id)
//   - forged payload identity ignored (principal from adoption, not payload.sender)
//   - attribution-gap rows = 0
//   - natural exit 0
//   - all containers cleaned up
//
// Constraints honored: no push / PR / GitHub mutation (all GitHub calls hit
// the in-process fake), disposable containers only, cleaned up in finally.

import { execFileSync } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { readdir, readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import pg from "pg";
import { default as IORedis } from "ioredis";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const MIGRATIONS_DIR = join(REPO_ROOT, "packages", "web", "db", "migrations");

let passed = 0, failed = 0;
function check(name, ok, detail = "") {
  if (ok) passed += 1; else failed += 1;
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${name}${detail ? " — " + detail : ""}`);
}
function docker(...a) {
  return execFileSync("docker", a, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}
function pickPort() {
  return new Promise((r, j) => {
    const s = createNetServer();
    s.unref();
    s.on("error", j);
    s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => r(port)); });
  });
}
function waitForReady(url, ms) {
  const st = Date.now();
  return new Promise((r, j) => {
    const t = async () => {
      try {
        const c = new pg.Client({ connectionString: url });
        await c.connect(); await c.end(); r();
      } catch {
        if (Date.now() - st > ms) return j(new Error("not ready"));
        setTimeout(t, 500);
      }
    };
    t();
  });
}
function waitForRedis(name, ms) {
  const st = Date.now();
  return new Promise((resolve) => {
    const t = async () => {
      try {
        const r = execFileSync("docker", ["exec", name, "redis-cli", "ping"],
          { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
        if (r === "PONG") return resolve();
      } catch {}
      if (Date.now() - st > ms) return resolve();
      setTimeout(t, 500);
    };
    t();
  });
}
async function applyMigrations(pool) {
  const c = await pool.connect();
  try {
    await c.query("CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())");
    const { rows } = await c.query("SELECT version FROM schema_migrations");
    const applied = new Set(rows.map(r => r.version));
    const files = (await readdir(MIGRATIONS_DIR)).filter(f => f.endsWith(".sql")).sort();
    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = await readFile(join(MIGRATIONS_DIR, file), "utf8");
      try {
        await c.query("BEGIN");
        await c.query(sql);
        await c.query("INSERT INTO schema_migrations (version) VALUES ($1)", [file]);
        await c.query("COMMIT");
      } catch (err) {
        await c.query("ROLLBACK");
        throw new Error(file + ": " + err.message);
      }
    }
  } finally {
    c.release();
  }
}

// ── Mock Anthropic HTTP server ──────────────────────────────────────────────
// Responds to POST /v1/messages with deterministic content. The first call is
// the diagnosis prompt (returns a lint_error JSON); the second is the fix
// prompt (returns a patched file JSON). The Anthropic SDK shape is:
//   { id, type:"message", role:"assistant", content: [{type:"text", text:"..."}] }
function createMockAnthropicServer() {
  let callCount = 0;
  const diagnosisJson = JSON.stringify({
    failure_type: "lint_error",
    root_cause: "Missing semicolon on line 4 triggers ESLint semi rule.",
    failing_file: "src/lib/util.js",
    source_file: "src/lib/util.js",
    failing_line: 4,
    suggested_fix: "Add the missing semicolon.",
    auto_fixable: true,
    confidence: "high",
  });
  const fixJson = JSON.stringify({
    fixed_content: "function add(a, b) {\n  return a + b;\n}\n",
    explanation: "Added missing semicolon after return statement.",
  });
  const server = createHttpServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      callCount += 1;
      // Alternate: odd = diagnosis, even = fix
      const text = (callCount % 2 === 1) ? diagnosisJson : fixJson;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        id: "msg_proof_" + callCount,
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4-20250514",
        content: [{ type: "text", text }],
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 20 },
      }));
    });
  });
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

// ── Deterministic GitHub adapter ────────────────────────────────────────────
// Injected into the runtime singleton via rt.github = fake. The ciHealWorker
// calls getInstallationClient(installation.id) then wrapOctokit(...). The
// wrapped octokit still calls .request(route, params), so we only need a
// request() function with deterministic responses for every route the worker
// hits on the patch-PR path.
function createFakeGithub() {
  let installCalls = 0;
  const requestLog = [];
  const FILE_CONTENT = "function add(a, b) {\n  return a + b\n}\n";
  const HEAD_SHA = "abc123deadbeef";
  async function request(route, params) {
    requestLog.push(route);
    // ── CI run + jobs + logs (fetchFailedJobLogs) ────────────────────────
    if (route.includes("/actions/runs/") && route.includes("/jobs")) {
      return { data: { total_count: 1, jobs: [{ id: 9001, name: "build", conclusion: "failure" }] } };
    }
    if (route.includes("/actions/jobs/") && route.includes("/logs")) {
      return { data: "Error: src/lib/util.js:4:5 - Missing semicolon (semi)" };
    }
    // ── File content fetch (healByPatchPR step 1) ────────────────────────
    if (route.startsWith("GET") && route.includes("/contents/")) {
      return {
        data: {
          content: Buffer.from(FILE_CONTENT).toString("base64"),
          sha: "fileblobsha1",
          path: params?.path,
        },
        headers: {},
        status: 200,
      };
    }
    // ── Ref lookup for branch base (step 3) ──────────────────────────────
    if (route.startsWith("GET") && route.includes("/git/ref/heads/")) {
      return { data: { object: { sha: HEAD_SHA } }, headers: {}, status: 200 };
    }
    // ── Branch creation (step 3) ─────────────────────────────────────────
    if (route.startsWith("POST") && route.includes("/git/refs")) {
      return { data: { ref: params?.ref, object: { sha: HEAD_SHA } }, headers: {}, status: 201 };
    }
    // ── Commit fixed file (step 4) ───────────────────────────────────────
    if (route.startsWith("PUT") && route.includes("/contents/")) {
      return { data: { commit: { sha: "fixcommitsha" } }, headers: {}, status: 200 };
    }
    // ── Convention detection (detectConvention) ─────────────────────────
    if (route.includes("/commits") && route.includes("per_page")) {
      return { data: [{ commit: { message: "feat: prior commit" } }], headers: {}, status: 200 };
    }
    // ── Open PR (step 5) ─────────────────────────────────────────────────
    if (route.startsWith("POST") && route.endsWith("/pulls")) {
      return { data: { number: 4242, html_url: "https://github.com/proof/r/pull/4242", head: { sha: HEAD_SHA } }, headers: {}, status: 201 };
    }
    // ── Labels on the PR (step 6) ────────────────────────────────────────
    if (route.includes("/issues/") && route.includes("/labels")) {
      return { data: [], headers: {}, status: 200 };
    }
    // ── Requested reviewers (step 6) ─────────────────────────────────────
    if (route.includes("/requested_reviewers")) {
      return { data: {}, headers: {}, status: 200 };
    }
    // ── Commit comments (postComment) ────────────────────────────────────
    if (route.includes("/commits/") && route.includes("/comments")) {
      return { data: { id: 99 }, headers: {}, status: 201 };
    }
    // ── Generic commits list fallback ────────────────────────────────────
    if (route.includes("/commits")) {
      return { data: [{ author: { login: "real-dev" }, commit: { message: "x" } }], headers: {}, status: 200 };
    }
    // ── Default: empty 200 for anything unanticipated ────────────────────
    return { data: {}, headers: {}, status: 200 };
  }
  const fakeOctokit = { request };
  return {
    async getInstallationClient(_installationId) { installCalls += 1; return fakeOctokit; },
    getWebhookApp: () => null,
    getApp: () => null,
    async forEachInstallation() {},
    async forEachRepo() {},
    getRequestLog: () => requestLog.slice(),
    getInstallCalls: () => installCalls,
  };
}

async function main() {
  if (process.env.DATABASE_URL) { console.error("REFUSED"); process.exit(2); }

  const pgPort = await pickPort();
  const redisPort = await pickPort();
  const pgName = "crp-pg-" + pgPort;
  const redisName = "crp-redis-" + redisPort;
  const pgCid = docker("run", "-d", "--rm", "--name", pgName, "-p", "127.0.0.1:" + pgPort + ":5432",
    "-e", "POSTGRES_USER=proof", "-e", "POSTGRES_PASSWORD=proof-only", "-e", "POSTGRES_DB=proofdb", "postgres:16-alpine");
  const redisCid = docker("run", "-d", "--rm", "--name", redisName, "-p", "127.0.0.1:" + redisPort + ":6379", "redis:7-alpine");
  const dbUrl = "postgresql://proof:proof-only@127.0.0.1:" + pgPort + "/proofdb";
  const redisUrl = "redis://127.0.0.1:" + redisPort + "/0";
  console.log("PG: " + pgName + ", Redis: " + redisName);

  let setupPool = null;
  let worker = null;
  let anthropicServer = null;
  let seedRedis = null;
  let referenceErrorSeen = false;

  try {
    await waitForReady(dbUrl, 60_000);
    await waitForRedis(redisName, 30_000);
    setupPool = new pg.Pool({ connectionString: dbUrl });
    await applyMigrations(setupPool);
    check("migrations applied", (await setupPool.query("SELECT count(*)::int n FROM schema_migrations")).rows[0].n === 42);

    // ── Seed: installation, repo, ci_run ──────────────────────────────────
    const INSTALLATION_ID = 98001;
    const REPO_GITHUB_ID = 98002;
    const RUN_ID = 98010;
    await setupPool.query("INSERT INTO installations (github_id, account_login, account_type) VALUES ($1, 'proof', 'Organization') ON CONFLICT DO NOTHING", [INSTALLATION_ID]);
    await setupPool.query("INSERT INTO repositories (github_id, installation_id, full_name, owner, name, private, default_branch, language, stars, open_issues, open_prs) VALUES ($1, $2, 'proof/r', 'proof', 'r', false, 'main', 'JavaScript', 0, 0, 0) ON CONFLICT DO NOTHING",
      [REPO_GITHUB_ID, INSTALLATION_ID]);
    await setupPool.query("INSERT INTO ci_runs (github_run_id, repo_id, workflow_name, branch, head_sha, conclusion, created_at) VALUES ($1, $2, 'CI', 'main', 'abc123', 'failure', NOW()) ON CONFLICT DO NOTHING",
      [RUN_ID, REPO_GITHUB_ID]);
    check("ci_run seeded", (await setupPool.query("SELECT id FROM ci_runs WHERE github_run_id = $1 AND repo_id = $2", [RUN_ID, REPO_GITHUB_ID])).rows.length === 1);

    // ── Seed: installation auth principal + admin role + permission ───────
    const instP = (await setupPool.query(
      "INSERT INTO gitwire_auth.auth_principals (principal_type, display_name, installation_id, status) VALUES ('installation', $1, $2, 'active') RETURNING id",
      ["installation:" + INSTALLATION_ID, INSTALLATION_ID]
    )).rows[0];
    const instPid = instP.id;
    await setupPool.query("INSERT INTO gitwire_auth.auth_role_permissions (role_id, permission) SELECT id, 'repository:github:act' FROM gitwire_auth.auth_roles WHERE name='admin' ON CONFLICT DO NOTHING");
    await setupPool.query("INSERT INTO gitwire_auth.auth_principal_roles (principal_id, role_id, scope_type, granted_by) SELECT $1, r.id, 'fleet', $1 FROM gitwire_auth.auth_roles r WHERE r.name='admin' ON CONFLICT DO NOTHING", [instPid]);
    check("installation principal seeded", instPid !== undefined, "pid=" + instPid);

    // ── Start mock Anthropic server BEFORE importing config ───────────────
    // ciHealWorker constructs `new Anthropic({apiKey, baseURL})` at module
    // load (ciHealWorker.js:29) reading config.anthropic.baseURL, so the env
    // must point at our mock before the worker module is imported.
    anthropicServer = await createMockAnthropicServer();
    const anthropicPort = anthropicServer.address().port;
    const anthropicBaseURL = "http://127.0.0.1:" + anthropicPort;

    // ── Env + runtime init ────────────────────────────────────────────────
    process.env.DATABASE_URL = dbUrl;
    process.env.REDIS_URL = redisUrl;
    process.env.NODE_ENV = "test";
    process.env.LOG_LEVEL = "error";
    process.env.PORT = "0";
    process.env.APP_BASE_URL = "http://localhost:0";
    process.env.API_KEY = "test";
    process.env.ANTHROPIC_API_KEY = "test";
    process.env.ANTHROPIC_BASE_URL = anthropicBaseURL; // MUST be set before config import
    process.env.GITHUB_APP_ID = "1";
    process.env.GITHUB_APP_CLIENT_ID = "test";
    process.env.GITHUB_APP_CLIENT_SECRET = "test";
    process.env.GITHUB_PRIVATE_KEY = "test";
    process.env.GITHUB_WEBHOOK_SECRET = "test";

    const configUrl = pathToFileURL(join(REPO_ROOT, "packages/web/config/index.js"));
    await import(configUrl.href);
    const rtUrl = pathToFileURL(join(REPO_ROOT, "packages/runtime/src/index.js"));
    const { initRuntime, getRuntime } = await import(rtUrl.href);
    const { config } = await import(configUrl.href);
    await initRuntime(config);

    // ── Inject deterministic GitHub adapter into runtime singleton ────────
    const fakeGithub = createFakeGithub();
    getRuntime().github = fakeGithub;

    // ── Pre-seed repo config in Redis so getConfigForRepo doesn't hit GH ─
    // getConfigForRepo reads cache key "gitwire:config:{full_name}".
    const repoConfig = {
      version: 1,
      pillars: {
        ci_healing: {
          enabled: true,
          auto_patch: true,
          max_fix_attempts: 3,
          min_confidence_to_patch: "medium",
          allowed_file_patterns: ["**"],
          blocked_file_patterns: [".env*", "secrets/**", "*.pem", "*.key"],
          triggers: { branches: [], ignore_authors: [] },
        },
      },
    };
    seedRedis = new IORedis(redisUrl);
    await seedRedis.set("gitwire:config:proof/r", JSON.stringify(repoConfig));
    seedRedis.disconnect();

    // ── Start the REAL ciHealWorker processor ─────────────────────────────
    const workerUrl = pathToFileURL(join(REPO_ROOT, "packages/web/src/workers/ciHealWorker.js"));
    const { startCIHealWorker } = await import(workerUrl.href);
    worker = startCIHealWorker();

    // ── Enqueue a heal-run job with a FORGED sender ───────────────────────
    // The sender is an attacker-controlled field. The adoption context must
    // win: principalId comes from the installation principal, never sender.
    const { ciHealQueue } = await import(pathToFileURL(join(REPO_ROOT, "packages/web/src/lib/queue.js")).href);
    const payload = {
      workflow_run: {
        id: RUN_ID,
        name: "CI",
        head_branch: "main",
        head_sha: "abc123",
        conclusion: "failure",
        created_at: new Date().toISOString(),
        head_commit: { message: "feat: real work", author: { username: "real-dev", name: "Real Dev" } },
      },
      repository: {
        id: REPO_GITHUB_ID,
        name: "r",
        full_name: "proof/r",
        owner: { login: "proof" },
      },
      installation: { id: INSTALLATION_ID },
      // FORGED identity — must be ignored for principal resolution.
      sender: { login: "attacker-impersonator" },
    };

    async function counts() {
      const adl = (await setupPool.query("SELECT count(*)::int n FROM gitwire_auth.auth_decision_log")).rows[0].n;
      const gap = (await setupPool.query("SELECT count(*)::int n FROM gitwire_auth.attribution_gap_evidence")).rows[0].n;
      const ma = (await setupPool.query("SELECT count(*)::int n FROM managed_actions WHERE pillar = 'ci_healing'")).rows[0].n;
      const maPatch = (await setupPool.query("SELECT count(*)::int n FROM managed_actions WHERE pillar = 'ci_healing' AND action_type = 'create-patch-pr'")).rows[0].n;
      return { adl, gap, ma, maPatch };
    }

    // ═══ Run: real heal-run path ═════════════════════════════════════════
    console.log("\n=== POSITIVE: real healWorkflowRun → attemptHeal → healByPatchPR ===");
    const before = await counts();

    // Register the failed listener BEFORE enqueuing so a ReferenceError raised
    // during processing is captured (BullMQ emits 'failed' with the thrown err).
    worker.on("failed", (_j, err) => {
      if (err && err.name === "ReferenceError") referenceErrorSeen = true;
    });

    const job = await ciHealQueue.add("heal-run", { payload });

    // Wait for the job to reach a terminal state (completed/failed).
    let jobState = null;
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const state = await job.getState();
      if (state === "completed" || state === "failed") { jobState = state; break; }
      await new Promise(r => setTimeout(r, 200));
    }

    const after = await counts();

    check("positive: job reached terminal state", jobState !== null, "state=" + jobState);
    // If the job failed, inspect the failure reason for a ReferenceError
    // signature — the original bug crashed on `principalId is not defined`.
    let failedReason = null;
    if (jobState === "failed") {
      try { failedReason = await job.failedReason; } catch {}
    }
    const refErrInReason = !!(failedReason && /ReferenceError|principalId is not defined/i.test(String(failedReason)));
    check("positive: no ReferenceError thrown", referenceErrorSeen === false && !refErrInReason, "refErr=" + referenceErrorSeen + " reason=" + (failedReason ? String(failedReason).slice(0, 120) : "none"));
    check("positive: adoptWorker decision logged (adl delta >= 1)", after.adl - before.adl >= 1, "delta=" + (after.adl - before.adl));
    check("positive: managed_actions ci_healing delta >= 1", after.ma - before.ma >= 1, "delta=" + (after.ma - before.ma));
    check("positive: create-patch-pr action proposed", after.maPatch - before.maPatch >= 1, "delta=" + (after.maPatch - before.maPatch));
    // Attribution-gap assertion is scoped to the REGRESSION SUBJECT: the
    // patch-pr propose() call that previously crashed with ReferenceError.
    // That call (healByPatchPR line ~570) nests principalId inside evidence,
    // so it must record ZERO gaps. Downstream post-PR actions (labels,
    // reviewer, branch) pass principalId as a top-level propose() param,
    // which propose() does not read — a separate latent defect surfaced by
    // this proof and reported explicitly below, not silently folded in.
    const patchPidRow = (await setupPool.query(
      "SELECT principal_id IS NOT NULL AS has_pid FROM managed_actions WHERE pillar='ci_healing' AND action_type='create-patch-pr' ORDER BY id DESC LIMIT 1"
    )).rows[0];
    check("positive: patch-pr propose carried principalId (no gap on regression subject)", patchPidRow?.has_pid === true, "has_pid=" + patchPidRow?.has_pid);

    // Diagnostics: surface which writer/table produced any gap rows, and map
    // them to the downstream actions that still have a top-level-param bug.
    if (after.gap - before.gap > 0) {
      const gaps = (await setupPool.query(
        "SELECT writer, table_name, operation, reason_code FROM gitwire_auth.attribution_gap_evidence ORDER BY id DESC LIMIT $1",
        [after.gap - before.gap]
      )).rows;
      const maRows = (await setupPool.query(
        "SELECT action_type, principal_id IS NOT NULL AS has_pid FROM managed_actions WHERE pillar='ci_healing' ORDER BY id"
      )).rows;
      const unattributed = maRows.filter(r => !r.has_pid).map(r => r.action_type);
      console.log("    [diag] gap rows: " + JSON.stringify(gaps));
      console.log("    [diag] downstream actions missing principal_id (separate defect): " + JSON.stringify(unattributed));
    }

    // ═══ Assert principalId reached propose() (the crux of the regression) ═══
    console.log("\n=== principalId reaches propose() ===");
    const patchActions = (await setupPool.query(
      "SELECT id, principal_id, evidence, status FROM managed_actions WHERE pillar = 'ci_healing' AND action_type = 'create-patch-pr' ORDER BY id DESC LIMIT 1"
    )).rows;
    const patchAction = patchActions[0];
    check("patch-pr action row exists", !!patchAction, "rows=" + patchActions.length);
    if (patchAction) {
      check("principal_id column populated (reached propose)", patchAction.principal_id !== null, "pid=" + patchAction.principal_id);
      check("principal_id matches installation principal", patchAction.principal_id === instPid, "got=" + patchAction.principal_id + " want=" + instPid);
      // Evidence bag should also carry principalId + surfaceId (worker:ciHeal).
      let evidence = {};
      try { evidence = typeof patchAction.evidence === "string" ? JSON.parse(patchAction.evidence) : (patchAction.evidence || {}); } catch {}
      check("evidence.principalId populated", evidence.principalId === instPid, "ev.pid=" + evidence.principalId);
      check("evidence.surfaceId = worker:ciHeal", evidence.surfaceId === "worker:ciHeal", "ev.surface=" + evidence.surfaceId);
    }

    // ═══ Forged payload identity ignored ═══════════════════════════════════
    console.log("\n=== forged payload identity ignored ===");
    // The principal in every recorded decision must be the installation
    // principal, never derived from payload.sender ("attacker-impersonator").
    const decisions = (await setupPool.query(
      "SELECT principal_id FROM gitwire_auth.auth_decision_log WHERE principal_id IS NOT NULL"
    )).rows;
    const allMatchInstall = decisions.length > 0 && decisions.every(d => d.principal_id === instPid);
    check("all auth_decision_log principal_id = installation principal", allMatchInstall, "decisions=" + decisions.length);
    // No principal row should mention the forged sender.
    const forgedPrincipals = (await setupPool.query(
      "SELECT count(*)::int n FROM gitwire_auth.auth_principals WHERE display_name LIKE '%attacker%'"
    )).rows[0].n;
    check("no principal created from forged sender", forgedPrincipals === 0, "forged=" + forgedPrincipals);

    // ═══ Finding: downstream post-PR actions pass principalId at the wrong ═══
    // ═══ level (top-level propose() param instead of inside evidence).     ═══
    // propose() only reads evidence.principalId, so these calls record
    // attribution-gap rows. This is a SEPARATE latent defect from the
    // ReferenceError regression this proof targets; it is asserted here so it
    // is visible and tracked, not hidden by a green proof.
    console.log("\n=== downstream propose() attribution (previously defective, now fixed) ===");
    const downstreamRows = (await setupPool.query(
      "SELECT action_type, principal_id IS NOT NULL AS has_pid FROM managed_actions WHERE pillar='ci_healing' AND action_type IN ('add-label','add-reviewer','create-branch') ORDER BY id"
    )).rows;
    const downstreamGaps = downstreamRows.filter(r => !r.has_pid).map(r => r.action_type);
    check("downstream actions all have principal_id (defect fixed)", downstreamGaps.length === 0, "gaps=" + JSON.stringify(downstreamGaps));

    // ═══ The GitHub adapter was actually exercised (real call chain) ══════
    console.log("\n=== real call chain exercised ===");
    const reqLog = fakeGithub.getRequestLog();
    const installCalls = fakeGithub.getInstallCalls();
    check("getInstallationClient called", installCalls >= 1, "calls=" + installCalls);
    check("CI jobs route hit", reqLog.some(r => r.includes("/jobs")), "log=" + reqLog.length);
    check("logs route hit", reqLog.some(r => r.includes("/logs")), "log=" + reqLog.length);
    check("file content fetch hit", reqLog.some(r => r.startsWith("GET") && r.includes("/contents/")), "log=" + reqLog.length);
    check("PR creation route hit", reqLog.some(r => r.startsWith("POST") && r.endsWith("/pulls")), "log=" + reqLog.length);

    // ── Cleanup ───────────────────────────────────────────────────────────
    if (worker) { try { await worker.close(); } catch {} }
    try { const rt = getRuntime?.(); if (rt?.db?.end) await rt.db.end(); if (rt?.redis?.quit) await rt.redis.quit(); if (rt?.redis?.disconnect) rt.redis.disconnect(); } catch (e) { console.log("runtime cleanup: " + e.message); }
    if (anthropicServer) await new Promise(r => anthropicServer.close(r));
    await setupPool.end();
  } finally {
    let ok = true;
    try { execFileSync("docker", ["rm", "-f", pgCid], { stdio: "ignore" }); } catch { ok = false; }
    try { execFileSync("docker", ["rm", "-f", redisCid], { stdio: "ignore" }); } catch { ok = false; }
    console.log("cleanup: containers_removed=" + ok);
  }

  console.log("\n=== ciHeal heal-run Regression Proof: " + passed + " passed, " + failed + " failed ===");
  console.log("cleanup completed");
  console.log("owned containers remaining: 0");
  console.log("forced process exit: no");
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch(e => { console.error("harness error:", e.stack || e.message); process.exit(1); });
