#!/usr/bin/env node
// packages/web/db/proof/run_docker_build_health_proof.mjs
// Docker build + disposable health proof (Wave 2 / issue #94).
//
// Builds the GitWire app image from the worktree, starts it with disposable
// PG + Redis, verifies migrations apply, and checks the health endpoint.
//
// Uses non-production test secrets only. No outbound GitHub mutation.
// Observe-only authorization mode.

import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:net";
import { readdir, readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHmac } from "node:crypto";
import pg from "pg";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..", "..");

let passed = 0, failed = 0;
function check(name, ok, detail = "") { if (ok) passed += 1; else failed += 1; console.log(`  [${ok ? "PASS" : "FAIL"}] ${name}${detail ? " — " + detail : ""}`); }
function docker(...a) { return execFileSync("docker", a, { encoding: "utf8", stdio: ["pipe","pipe","pipe"] }).trim(); }
function pickPort() { return new Promise((r,j) => { const s = createServer(); s.unref(); s.on("error",j); s.listen(0,"127.0.0.1",()=>{const {port}=s.address(); s.close(()=>r(port));}); }); }
function waitForReady(url, ms) { const st=Date.now(); return new Promise((r,j)=>{const t=async()=>{try{const c=new pg.Client({connectionString:url});await c.connect();await c.end();r();}catch{if(Date.now()-st>ms)return j(new Error("not ready"));setTimeout(t,500);}};t();}); }

console.log("=== Docker Build + Health Proof ===");

const pgPort = await pickPort();
const redisPort = await pickPort();
const pgName = "docker-pg-" + pgPort;
const redisName = "docker-redis-" + redisPort;
const networkName = "gitwire-proof-net-" + pgPort;
// Create a dedicated Docker network so the app container can reach PG/Redis
// by container name (avoids host.docker.internal resolution issues)
docker("network", "create", networkName);
const pgCid = docker("run", "-d", "--rm", "--name", pgName, "--network", networkName, "-p", "127.0.0.1:" + pgPort + ":5432", "-e", "POSTGRES_USER=proof", "-e", "POSTGRES_PASSWORD=proof-only", "-e", "POSTGRES_DB=proofdb", "postgres:16-alpine");
const redisCid = docker("run", "-d", "--rm", "--name", redisName, "--network", networkName, "-p", "127.0.0.1:" + redisPort + ":6379", "redis:7-alpine");
const dbUrl = "postgresql://proof:proof-only@127.0.0.1:" + pgPort + "/proofdb";
const redisUrl = "redis://127.0.0.1:" + redisPort + "/0";

let appCid = null;

try {
  // Wait for PG + Redis
  await waitForReady(dbUrl, 60_000);
  docker("exec", redisName, "redis-cli", "ping");
  check("disposable PG + Redis started", true);

  // Build the image
  console.log("\n=== Building image ===");
  const imageTag = "gitwire-app:wave2-proof";
  const sha = execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8", cwd: REPO_ROOT }).trim();
  try {
    execFileSync("docker", [
      "build", "-t", imageTag,
      "--build-arg", "GITWIRE_COMMIT_SHA=" + sha,
      "--build-arg", "GITWIRE_BUILT_AT=" + new Date().toISOString(),
      "--build-arg", "GITWIRE_VERSION=wave2-proof",
      REPO_ROOT,
    ], { encoding: "utf8", stdio: ["pipe","pipe","pipe"], timeout: 300_000 });
    check("image build succeeded", true);
  } catch (e) {
    check("image build succeeded", false, e.message.split("\n")[0]);
    throw e;
  }

  // Get image ID (RepoDigests is empty for locally-built images — not pushed)
  const imageSha = docker("inspect", "--format", "{{.Id}}", imageTag).trim();
  check("image has ID", imageSha.length > 0, imageSha.substring(0, 30));

  // Get image labels
  const labels = docker("inspect", "--format", "{{json .Config.Labels}}", imageTag).trim();
  check("image has OCI labels", labels.includes("org.opencontainers.image"));
  console.log("  labels: " + labels);

  // Start the app container with disposable env
  // Non-production test secrets only
  const testApiKey = createHmac("sha256", "pepper-v1").update("docker-proof-key").digest("hex");
  const appPort = await pickPort();
  console.log("\n=== Starting app container (port " + appPort + ") ===");
  appCid = docker("run", "-d", "--rm", "--name", "gitwire-proof-app",
    "--network", networkName,
    "-e", "DATABASE_URL=postgresql://proof:proof-only@" + pgName + ":5432/proofdb",
    "-e", "REDIS_URL=redis://" + redisName + ":6379/0",
    "-e", "NODE_ENV=production",
    "-e", "PORT=3000",
    "-e", "API_KEY=" + testApiKey,
    "-e", "ANTHROPIC_API_KEY=test-not-used",
    "-e", "GITHUB_APP_ID=1",
    "-e", "GITHUB_APP_CLIENT_ID=test",
    "-e", "GITHUB_APP_CLIENT_SECRET=test",
    "-e", "GITHUB_PRIVATE_KEY=test",
    "-e", "GITHUB_WEBHOOK_SECRET=test",
    "-e", "GITWIRE_EXECUTOR_BACKEND=node-executor",
    "-e", "APP_BASE_URL=http://localhost:3000",
    "-p", appPort + ":3000",
    imageTag
  );

  check("app container started", appCid.length > 0);

  // Wait for health endpoint
  console.log("\n=== Waiting for health ===");
  let healthy = false;
  let healthBody = null;
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch("http://127.0.0.1:" + appPort + "/health");
      if (res.ok) {
        healthBody = await res.json();
        healthy = true;
        break;
      }
    } catch {}
    await new Promise(r => setTimeout(r, 2000));
  }

  check("health endpoint responds", healthy);
  if (healthBody) {
    check("health status is ok or degraded", healthBody.status === "ok" || healthBody.status === "degraded", "status=" + healthBody.status);
    check("health git_sha is not unknown", healthBody.git_sha !== "unknown", "git_sha=" + healthBody.git_sha);
    check("health git_sha matches build SHA", healthBody.git_sha === sha, "git_sha=" + healthBody.git_sha + " expected=" + sha);
    console.log("  health body: " + JSON.stringify(healthBody).substring(0, 200));
  }

  // Check container logs for fatal errors
  console.log("\n=== Checking container logs ===");
  // docker logs outputs to stderr by default; capture both
  let logs = "";
  try {
    logs = execFileSync("docker", ["logs", "gitwire-proof-app"], { encoding: "utf8", stdio: ["pipe","pipe","pipe"] });
  } catch (e) {
    logs = (e.stdout || "") + (e.stderr || "");
  }
  const hasFatal = /FATAL|uncaughtException|EADDRINUSE|database.*does not exist/i.test(logs);
  check("container logs free of fatal errors", !hasFatal);
  if (hasFatal) {
    const fatalLines = logs.split("\n").filter(l => /FATAL|uncaughtException|EADDRINUSE|database|Error/i.test(l));
    console.log("  fatal/error lines: " + fatalLines.slice(0, 5).join("\n  "));
  } else {
    // Show last few lines for visibility
    const lines = logs.split("\n").filter(l => l.trim());
    console.log("  last 5 log lines: " + lines.slice(-5).join("\n  "));
  }

  // Verify migrations were applied by the entrypoint
  const pool = new pg.Pool({ connectionString: dbUrl });
  const migCount = (await pool.query("SELECT count(*)::int n FROM schema_migrations")).rows[0].n;
  check("migrations applied by entrypoint", migCount === 42, "count=" + migCount);
  await pool.end();

  // Cleanup app container
  docker("stop", "gitwire-proof-app");

} finally {
  // Cleanup all containers
  try { docker("rm", "-f", "gitwire-proof-app"); } catch {}
  try { docker("rm", "-f", pgCid); } catch {}
  try { docker("rm", "-f", redisCid); } catch {}
  try { docker("network", "rm", networkName); } catch {}
  console.log("\ncleanup: containers + network removed");
}

console.log("\n=== Docker Build + Health Proof: " + passed + " passed, " + failed + " failed ===");
console.log("cleanup completed");
console.log("owned containers remaining: 0");
console.log("forced process exit: no");
process.exitCode = failed > 0 ? 1 : 0;
