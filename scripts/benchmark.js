// scripts/benchmark.js
// GitWire Benchmark Harness — measures API p95 latency, queue throughput,
// and mixed read/write workload latency.
//
// Usage:
//   node scripts/benchmark.js                    # Full suite
//   node scripts/benchmark.js --api              # API latency only
//   node scripts/benchmark.js --queue            # Queue throughput only
//   node scripts/benchmark.js --iterations 500   # Custom iteration count
//   node scripts/benchmark.js --concurrency 20   # Custom concurrency
//
// Requires:
//   - GitWire running in an ISOLATED environment (never production)
//   - GITWIRE_BASE_URL, API_KEY, GITWIRE_STRESS_ENV=isolated all set in env
//
// This harness shares the same isolation policy as the Jest stress suite
// (tests/target-policy.js). It refuses to run without explicit configuration,
// rejects known production hostnames/repositories/installations regardless of
// configuration, and rejects cross-origin absolute URLs before any header is
// constructed. Mutating benchmarks additionally require
// GITWIRE_STRESS_ALLOW_MUTATIONS=true plus fixture identities and a budget.

import { fileURLToPath, pathToFileURL } from "url";
import { dirname, resolve } from "path";

// Resolve the shared policy module relative to this script so benchmark.js
// works regardless of the current working directory. On Windows, dynamic
// import requires a file:// URL (a bare C:\ path throws
// ERR_UNSUPPORTED_ESM_URL_SCHEME), so we convert via pathToFileURL.
const __dirname = dirname(fileURLToPath(import.meta.url));
const POLICY_PATH = resolve(__dirname, "../packages/web/tests/target-policy.js");
const { loadPolicy } = await import(pathToFileURL(POLICY_PATH).href);

// benchmark.js requires the full isolated stress gate for ALL modes, including
// read-only benchmarks. The previous requireStressGate=false was inconsistent
// with the header's claim that GITWIRE_STRESS_ENV=isolated is required, and
// allowed read benchmarks to target production. Mutations additionally
// require the fixture opt-in, fixture identities, run ID, and budget.
const POLICY = loadPolicy({ requireStressGate: true });

// Register benchmark mutation contracts at init (not inside a benchmark
// function). Previously repo-sync was registered inside benchmarkMixed(),
// which meant --queue (which runs first and never invokes mixed) failed at
// the contract check. Registering here makes every benchmark mode that
// mutates work regardless of invocation order.
if (POLICY.allowMutations) {
  POLICY.registerMutationContract({
    name: "repo-sync",
    method: "POST",
    classification: "FIXTURE_MUTATION",
    route: "/api/repos/:owner/:repo/sync",
    identities: [{ field: "repo", location: "path", param: "owner" }],
  });
}

// ── Configuration ──────────────────────────────────────────────────────────

const BASE_URL = POLICY.baseUrlRaw;
const API_KEY = POLICY.apiKey;
const ITERATIONS = parseInt(process.argv.find((a, i) => process.argv[i - 1] === "--iterations")) || 200;
const CONCURRENCY = parseInt(process.argv.find((a, i) => process.argv[i - 1] === "--concurrency")) || 10;

const FLAGS = {
  webhook: process.argv.includes("--webhook"),
  api: process.argv.includes("--api"),
  queue: process.argv.includes("--queue"),
};
const RUN_ALL = !FLAGS.webhook && !FLAGS.api && !FLAGS.queue;

// ── Helpers ─────────────────────────────────────────────────────────────────

function percentile(sorted, p) {
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

function stats(durationsMs) {
  if (!durationsMs.length) return { total: 0, min: "0", max: "0", mean: "0", p50: "0", p90: "0", p95: "0", p99: "0", rps: "0" };
  const sorted = [...durationsMs].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    total: sorted.length,
    min: sorted[0].toFixed(1),
    max: sorted[sorted.length - 1].toFixed(1),
    mean: (sum / sorted.length).toFixed(1),
    p50: percentile(sorted, 50).toFixed(1),
    p90: percentile(sorted, 90).toFixed(1),
    p95: percentile(sorted, 95).toFixed(1),
    p99: percentile(sorted, 99).toFixed(1),
    rps: (sorted.length / (sum / 1000)).toFixed(1),
  };
}

async function apiFetch(path, opts = {}) {
  // Resolve through the policy: same-origin check + production denylist +
  // mutation gate + budget. Throws before fetch if the target is disallowed.
  const url = POLICY.resolveRequest(path);
  const method = (opts.method || "GET").toUpperCase();
  POLICY.assertMutationAllowed({
    method,
    url,
    body: opts.body,
    contractName: opts.contractName,
    operationName: `benchmark:${method}:${url.pathname}`,
  });

  const headers = {
    "Content-Type": "application/json",
    ...(POLICY.authHeader() ? { Authorization: POLICY.authHeader() } : {}),
    ...opts.headers,
  };
  const start = performance.now();
  const res = await fetch(url.href, { ...opts, method, headers });
  const elapsed = performance.now() - start;
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body, elapsed, method, path: url.pathname };
}

async function burst(fn, count, concurrency) {
  const results = [];
  const batchSize = Math.min(concurrency, 5); // Stay under 100 req/min rate limit
  const batchDelay = 100; // ms between batches
  for (let i = 0; i < count; i += batchSize) {
    const batch = Array.from({ length: Math.min(batchSize, count - i) }, () => fn());
    const batchResults = await Promise.allSettled(batch);
    for (const r of batchResults) {
      if (r.status === "fulfilled") results.push(r.value);
      else results.push({ status: 0, elapsed: -1, error: r.reason?.message });
    }
    if (i + batchSize < count) await new Promise(r => setTimeout(r, batchDelay));
  }
  return results;
}

function printStats(label, s) {
  console.log(`\n  ${label}`);
  console.log(`    Requests:  ${s.total}`);
  console.log(`    RPS:       ${s.rps}`);
  console.log(`    Mean:      ${s.mean} ms`);
  console.log(`    P50:       ${s.p50} ms`);
  console.log(`    P90:       ${s.p90} ms`);
  console.log(`    P95:       ${s.p95} ms`);
  console.log(`    P99:       ${s.p99} ms`);
  console.log(`    Min/Max:   ${s.min} / ${s.max} ms`);
}

// ── Benchmark: API Latency ──────────────────────────────────────────────────

async function benchmarkAPI() {
  console.log("\n━━━ API Latency Benchmark ━━━");
  console.log(`  ${ITERATIONS} requests × ${CONCURRENCY} concurrency × ${BASE_URL}`);

  const endpoints = [
    { label: "GET /api/repos", path: "/api/repos" },
    { label: "GET /api/issues", path: "/api/issues?limit=20" },
    { label: "GET /api/pull-requests", path: "/api/pull-requests?limit=20" },
    { label: "GET /api/ci/stats", path: "/api/ci/stats" },
    { label: "GET /api/actions/summary", path: "/api/actions/summary" },
    { label: "GET /api/activity/summary", path: "/api/activity/summary" },
    { label: "GET /health", path: "/health" },
  ];

  const results = {};

  for (const ep of endpoints) {
    const res = await burst(() => apiFetch(ep.path), ITERATIONS, CONCURRENCY);
    const durations = res.filter((r) => r.status === 200).map((r) => r.elapsed);
    const errors = res.filter((r) => r.status !== 200).length;
    const s = stats(durations);
    results[ep.label] = { ...s, errors };
    printStats(ep.label, s);
    if (errors > 0) console.log(`    Errors:    ${errors}`);
  }

  return results;
}

// ── Benchmark: Webhook Ingestion ────────────────────────────────────────────

async function benchmarkWebhook() {
  console.log("\n━━━ Webhook Ingestion Benchmark ━━━");
  console.log("  Not implemented in this revision.");
  console.log("  Previous behavior sent fake-signature payloads and measured early");
  console.log("  rejection latency while labelling it 'ingestion' — that measured the");
  console.log("  HTTP stack's reject path, not ingestion, and produced misleading numbers.");
  console.log("  Real ingestion throughput requires validly HMAC-signed payloads against");
  console.log("  a configured webhook secret, which is scoped to the ST-04 follow-up.");
  return null;
}

// ── Benchmark: Queue Throughput ─────────────────────────────────────────────

async function benchmarkQueue() {
  console.log("\n━━━ Queue Throughput Benchmark ━━━");

  // Queue benchmark enqueues real sync jobs, which are mutations against a
  // fixture repository. Require the full mutation gate.
  if (!POLICY.allowMutations) {
    console.log("  Skipped — requires GITWIRE_STRESS_ALLOW_MUTATIONS=true and a fixture repo.");
    console.log("  (queue enqueue creates real BullMQ jobs against the configured fixture repo)");
    return null;
  }
  const fixtureRepo = POLICY.fixtureRepo;
  console.log(`  ${Math.min(ITERATIONS, 20)} sync jobs × fixture ${fixtureRepo}`);

  // Use the API to trigger sync jobs (they go to BullMQ) against the
  // configured fixture repository only. The policy's mutation gate + budget
  // bound how many may fire.
  const res = await burst(
    () => apiFetch(`/api/repos/${fixtureRepo}/sync`, { method: "POST", contractName: "repo-sync" }),
    Math.min(ITERATIONS, 20),
    Math.min(CONCURRENCY, 3),
  );

  const durations = res.filter((r) => r.status === 202).map((r) => r.elapsed);
  const errors = res.filter((r) => r.status !== 202).length;

  if (durations.length === 0) {
    console.log("  No successful queue jobs — skipping");
    return null;
  }

  const s = stats(durations);
  printStats("POST /api/repos/:owner/:repo/sync (queue enqueue)", s);
  if (errors > 0) console.log(`    Errors:    ${errors}`);

  return s;
}

// ── Benchmark: Mixed Workload ───────────────────────────────────────────────

async function benchmarkMixed() {
  console.log("\n━━━ Mixed Workload Benchmark ━━━");
  console.log(`  ${ITERATIONS} ops × ${CONCURRENCY} concurrency`);

  // Each operation carries its kind, and the kind is attached DIRECTLY to the
  // result object the promise resolves with (not tracked in a parallel array
  // keyed by invocation order — that misclassified under out-of-order
  // completion or rejected promises). The repo-sync contract is registered
  // at module init (above), so both --queue and --mixed can use it.
  const readOps = [
    { kind: "read", run: () => apiFetch("/api/repos").then(r => ({ ...r, kind: "read" })) },
    { kind: "read", run: () => apiFetch("/api/issues?limit=20").then(r => ({ ...r, kind: "read" })) },
    { kind: "read", run: () => apiFetch("/api/ci/stats").then(r => ({ ...r, kind: "read" })) },
    { kind: "read", run: () => apiFetch("/api/actions/summary").then(r => ({ ...r, kind: "read" })) },
    { kind: "read", run: () => apiFetch("/api/activity/summary").then(r => ({ ...r, kind: "read" })) },
    { kind: "read", run: () => apiFetch("/health").then(r => ({ ...r, kind: "read" })) },
    { kind: "read", run: () => apiFetch("/api/webhooks/deliveries?limit=10").then(r => ({ ...r, kind: "read" })) },
  ];
  // Only the fixture-targeted sync mutation. The previous NONEXISTENT_ID
  // ci/actions retry writes targeted guessed IDs that were not fixture-owned
  // records — that is not a safety boundary (the reviewer is correct), and
  // under the fail-closed contract model a guessed ID cannot be validated.
  const writeOps = POLICY.allowMutations && POLICY.fixtureRepo ? [
    { kind: "write", run: () => apiFetch(
      `/api/repos/${POLICY.fixtureRepo}/sync`,
      { method: "POST", contractName: "repo-sync" }
    ).then(r => ({ ...r, kind: "write" })) },
  ] : [];

  if (writeOps.length === 0) {
    console.log("  Mutations disabled — running read-only mixed workload.");
  }
  const operations = [...readOps, ...writeOps];

  const res = await burst(
    () => {
      const op = operations[Math.floor(Math.random() * operations.length)];
      // Attach kind on both resolve and reject so a failed write isn't
      // misclassified as a read. burst() catches rejections into its results
      // array as { error }; we synthesize a kind-tagged failure object.
      return op.run().catch(err => ({ kind: op.kind, error: err.message, elapsed: -1 }));
    },
    ITERATIONS,
    CONCURRENCY,
  );

  const readDurations = [];
  const writeDurations = [];
  for (const r of res) {
    if (!r || r.elapsed < 0) continue;
    if (r.kind === "write") writeDurations.push(r.elapsed);
    else readDurations.push(r.elapsed);
  }

  if (readDurations.length > 0) printStats("Read operations", stats(readDurations));
  if (writeDurations.length > 0) printStats("Write operations", stats(writeDurations));

  const allDurations = res.filter((r) => r && r.elapsed > 0).map((r) => r.elapsed);
  printStats("All operations", stats(allDurations));

  return stats(allDurations);
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const suiteStart = performance.now();

  console.log("╔══════════════════════════════════════════╗");
  console.log("║       GitWire Benchmark Harness          ║");
  console.log("╠══════════════════════════════════════════╣");
  console.log(`║  Target:       ${BASE_URL.padEnd(26)}║`);
  console.log(`║  Iterations:   ${String(ITERATIONS).padEnd(26)}║`);
  console.log(`║  Concurrency:  ${String(CONCURRENCY).padEnd(26)}║`);
  console.log(`║  Auth:         ${(API_KEY ? "API key" : "None").padEnd(26)}║`);
  console.log("╚══════════════════════════════════════════╝");

  // Warmup
  console.log("\n⏳ Warming up...");
  await apiFetch("/health");
  await new Promise((r) => setTimeout(r, 500));

  const results = {};

  if (RUN_ALL || FLAGS.api) results.api = await benchmarkAPI();
  if (RUN_ALL || FLAGS.webhook) results.webhook = await benchmarkWebhook();
  if (RUN_ALL || FLAGS.queue) results.queue = await benchmarkQueue();
  if (RUN_ALL) results.mixed = await benchmarkMixed();

  const suiteElapsed = ((performance.now() - suiteStart) / 1000).toFixed(1);

  // Summary
  console.log("\n━━━ Summary ━━━");
  console.log(`  Total time:  ${suiteElapsed}s`);

  if (results.api) {
    const apiSummary = Object.entries(results.api)
      .map(([k, v]) => `${k}: ${v.rps} RPS, p95=${v.p95}ms`)
      .join("\n    ");
    console.log(`  API:\n    ${apiSummary}`);
  }

  if (results.mixed) {
    console.log(`  Mixed:       ${results.mixed.rps} RPS, p95=${results.mixed.p95}ms`);
  }

  if (results.webhook) {
    console.log(`  Webhook:     ${results.webhook.rps} RPS, p95=${results.webhook.p95}ms`);
  } else {
    console.log(`  Webhook:     (not implemented in this revision)`);
  }

  console.log("\n✅ Benchmark complete.");

  // Write results to JSON
  const outPath = `benchmark-results-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  const { writeFileSync } = await import("fs");
  writeFileSync(outPath, JSON.stringify({ timestamp: new Date().toISOString(), config: { baseUrl: BASE_URL, iterations: ITERATIONS, concurrency: CONCURRENCY }, results }, null, 2));
  console.log(`  Results saved to: ${outPath}`);
}

main().catch((err) => {
  console.error("Benchmark failed:", err);
  process.exit(1);
});
