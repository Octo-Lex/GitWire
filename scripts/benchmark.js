// scripts/benchmark.js
// GitWire Benchmark Harness — measures API p95 latency, queue throughput,
// and mixed read/write workload latency using the shared factual burst runner.
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
// This harness shares the same isolation policy AND the same factual burst
// runner as the Jest stress suite. The local burst()/stats() functions have
// been removed — all measurement goes through burst-runner.js's runBurst(),
// which reports factual HTTP outcomes (transportCompleted, transportFailed,
// statusCounts) instead of conflating Promise fulfillment with success.

import { fileURLToPath, pathToFileURL } from "url";
import { dirname, resolve } from "path";

// Resolve shared modules relative to this script.
const __dirname = dirname(fileURLToPath(import.meta.url));
const POLICY_PATH = resolve(__dirname, "../packages/web/tests/target-policy.js");
const RUNNER_PATH = resolve(__dirname, "../packages/web/tests/stress/burst-runner.js");
const { loadPolicy } = await import(pathToFileURL(POLICY_PATH).href);
const { runBurst, httpOperation } = await import(pathToFileURL(RUNNER_PATH).href);

// benchmark.js requires the full isolated stress gate for ALL modes.
const POLICY = loadPolicy({ requireStressGate: true });

// Register the repo-sync mutation contract at init (for queue + mixed).
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
const ITERATIONS = parseInt(process.argv.find((a, i) => process.argv[i - 1] === "--iterations")) || 200;
const CONCURRENCY = parseInt(process.argv.find((a, i) => process.argv[i - 1] === "--concurrency")) || 10;

const FLAGS = {
  webhook: process.argv.includes("--webhook"),
  api: process.argv.includes("--api"),
  queue: process.argv.includes("--queue"),
};
const RUN_ALL = !FLAGS.webhook && !FLAGS.api && !FLAGS.queue;

// ── Operation construction (uses prepareApiRequest via helpers.js) ──────────
//
// benchmark.js builds operation descriptors using the same prepareApiRequest()
// path that the stress suite uses. We import helpers.js for its
// apiBurstOperation() and prepareApiRequest().

const HELPERS_PATH = resolve(__dirname, "../packages/web/tests/helpers.js");
const { prepareApiRequest, apiBurstOperation } = await import(pathToFileURL(HELPERS_PATH).href);

/**
 * Build a read operation descriptor for an endpoint.
 * @param {string} path
 * @param {string} kind
 * @returns {{ kind: string, method: string, run: () => Promise<ClassifiedOutcome> }}
 */
function readOp(path, kind = "read") {
  return apiBurstOperation(path, { kind, method: "GET", bodyMode: "auto" });
}

/**
 * Build a write operation descriptor for a sync.
 * @param {string} fixtureRepo
 * @returns {{ kind: string, method: string, run: () => Promise<ClassifiedOutcome> }}
 */
function syncOp(fixtureRepo) {
  return apiBurstOperation(`/api/repos/${fixtureRepo}/sync`, {
    kind: "write", method: "POST", body: {}, contractName: "repo-sync",
  });
}

// ── Printing ───────────────────────────────────────────────────────────────

function printLatency(label, latency) {
  console.log(`\n  ${label}`);
  if (latency.count === 0) {
    console.log("    (no transport-completed responses)");
    return;
  }
  console.log(`    Count:      ${latency.count}`);
  console.log(`    RPS:        ${(latency.count / (latency.maxMs / 1000)).toFixed(1)} (max-duration approx)`);
  console.log(`    P50:        ${latency.p50Ms != null ? latency.p50Ms.toFixed(1) : "null"} ms`);
  console.log(`    P95:        ${latency.p95Ms != null ? latency.p95Ms.toFixed(1) : "null"} ms`);
  console.log(`    P99:        ${latency.p99Ms != null ? latency.p99Ms.toFixed(1) : "null"} ms`);
  console.log(`    Min/Max:    ${latency.minMs != null ? latency.minMs.toFixed(1) : "null"} / ${latency.maxMs != null ? latency.maxMs.toFixed(1) : "null"} ms`);
}

// ── Benchmark: API Latency ──────────────────────────────────────────────────

async function benchmarkAPI() {
  console.log("\n━━━ API Latency Benchmark ━━━");
  console.log(`  ${ITERATIONS} requests × ${CONCURRENCY} concurrency × ${BASE_URL}`);
  console.log(`  Latency = transport-completed duration (incl. body handling)`);

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
    // Pre-materialize all descriptors before execution (not inside callbacks).
    const ops = Array.from({ length: ITERATIONS }, () => readOp(ep.path));
    const r = await runBurst(ops, {
      concurrency: CONCURRENCY,
      pacing: { mode: "none" },
    });
    printLatency(ep.label, r.latency);
    if (r.transportFailed > 0) {
      console.log(`    Transport failures: ${r.transportFailed}`);
    }
    // Report unexpected HTTP statuses (non-200, non-429).
    const unexpected = Object.entries(r.statusCounts)
      .filter(([s]) => s !== "200" && s !== "429")
      .map(([s, n]) => `${s}×${n}`);
    if (unexpected.length > 0) console.log(`    Other:      ${unexpected.join(", ")}`);
    results[ep.label] = {
      transportCompleted: r.transportCompleted,
      transportFailed: r.transportFailed,
      rps: r.rps.toFixed(1),
      p95: r.latency.p95Ms != null ? r.latency.p95Ms.toFixed(1) : "null",
      statusCounts: r.statusCounts,
    };
  }

  return results;
}

// ── Benchmark: Webhook Ingestion ────────────────────────────────────────────

async function benchmarkWebhook() {
  console.log("\n━━━ Webhook Ingestion Benchmark ━━━");
  console.log("  Not implemented in this revision.");
  console.log("  Real ingestion throughput requires validly HMAC-signed payloads against");
  console.log("  a configured webhook secret (ST-04 follow-up).");
  return null;
}

// ── Benchmark: Queue Throughput ─────────────────────────────────────────────

async function benchmarkQueue() {
  console.log("\n━━━ Queue Throughput Benchmark ━━━");

  if (!POLICY.allowMutations) {
    console.log("  Skipped — requires GITWIRE_STRESS_ALLOW_MUTATIONS=true and a fixture repo.");
    return null;
  }
  const fixtureRepo = POLICY.fixtureRepo;
  // The queue benchmark deliberately limits concurrency and operation count
  // as a mutation-safety constraint (not a hidden scheduler cap). This is
  // disclosed explicitly below, not hidden in Math.min().
  const QUEUE_OP_CAP = 20;
  const QUEUE_CONCURRENCY_CAP = 3;
  const opCount = Math.min(ITERATIONS, QUEUE_OP_CAP);
  const queueConcurrency = Math.min(CONCURRENCY, QUEUE_CONCURRENCY_CAP);
  console.log(`  ${opCount} sync jobs × fixture ${fixtureRepo}`);
  console.log(`  Configured concurrency: ${CONCURRENCY}`);
  console.log(`  Requested concurrency: ${queueConcurrency} (concurrencyLimitReason: queue_mutation_safety_cap)`);

  // Pre-materialize all sync descriptors before execution.
  const ops = Array.from({ length: opCount }, () => syncOp(fixtureRepo));
  const r = await runBurst(ops, {
    concurrency: queueConcurrency,
    pacing: { mode: "none" },
  });

  printLatency("POST /api/repos/:owner/:repo/sync (queue enqueue)", r.latency);
  console.log(`    Transport completed: ${r.transportCompleted}/${r.attempted}`);
  console.log(`    202 Accepted: ${r.statusCounts[202] || 0}`);

  return {
    transportCompleted: r.transportCompleted,
    transportFailed: r.transportFailed,
    rps: r.rps.toFixed(1),
    p95: r.latency.p95Ms != null ? r.latency.p95Ms.toFixed(1) : "null",
    statusCounts: r.statusCounts,
    configuredConcurrency: CONCURRENCY,
    requestedConcurrency: queueConcurrency,
    concurrencyLimitReason: "queue_mutation_safety_cap",
  };
}

// ── Benchmark: Mixed Workload ───────────────────────────────────────────────

async function benchmarkMixed() {
  console.log("\n━━━ Mixed Workload Benchmark ━━━");
  console.log(`  ${ITERATIONS} ops × ${CONCURRENCY} concurrency`);

  // Pre-materialize ALL operation descriptors before calling runBurst.
  // The previous version chose operations inside the scheduled callback
  // and caught rejections into fulfilled error objects. Both behaviors are
  // gone: descriptors exist before execution begins, guaranteeing attribution.
  const readPaths = [
    "/api/repos", "/api/issues?limit=20", "/api/ci/stats",
    "/api/actions/summary", "/api/activity/summary", "/health",
    "/api/webhooks/deliveries?limit=10",
  ];
  const writeOps = POLICY.allowMutations && POLICY.fixtureRepo
    ? [syncOp(POLICY.fixtureRepo)]
    : [];

  if (writeOps.length === 0) {
    console.log("  Mutations disabled — running read-only mixed workload.");
  }

  // Build the full descriptor list up front. Each iteration randomly picks
  // a read or write descriptor template and materializes a fresh instance.
  const ops = Array.from({ length: ITERATIONS }, (_, i) => {
    const isWrite = writeOps.length > 0 && Math.random() < 0.3;
    if (isWrite) {
      return syncOp(POLICY.fixtureRepo);
    }
    const path = readPaths[Math.floor(Math.random() * readPaths.length)];
    return readOp(path);
  });

  const r = await runBurst(ops, {
    concurrency: CONCURRENCY,
    pacing: { mode: "none" },
  });

  // Split latency by kind using result.results[].kind (attached before exec).
  const readDurations = r.results
    .filter(x => x.kind === "read" && x.durationMs != null)
    .map(x => x.durationMs);
  const writeDurations = r.results
    .filter(x => x.kind === "write" && x.durationMs != null)
    .map(x => x.durationMs);

  // Compute per-kind stats via the runner's computeLatencyStats.
  const { computeLatencyStats } = await import(pathToFileURL(RUNNER_PATH).href);
  if (readDurations.length > 0) {
    printLatency("Read operations", computeLatencyStats(readDurations));
  }
  if (writeDurations.length > 0) {
    printLatency("Write operations", computeLatencyStats(writeDurations));
  }

  printLatency("All operations", r.latency);
  console.log(`    Transport:  ${r.transportCompleted} completed, ${r.transportFailed} failed`);
  console.log(`    Scheduler:  requestedConcurrency=${r.requestedConcurrency}, maxInFlightObserved=${r.maxInFlightObserved}`);

  return {
    transportCompleted: r.transportCompleted,
    transportFailed: r.transportFailed,
    rps: r.rps.toFixed(1),
    p95: r.latency.p95Ms != null ? r.latency.p95Ms.toFixed(1) : "null",
  };
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  try {
    await runSuite();
  } finally {
    if (POLICY.allowMutations && POLICY.budget) {
      try {
        POLICY.budget.finalize();
      } catch (err) {
        console.error(`[benchmark] finalize failed: ${err.message}`);
        process.exitCode = 1;
      }
    }
  }
}

async function runSuite() {
  const suiteStart = performance.now();

  console.log("╔══════════════════════════════════════════╗");
  console.log("║       GitWire Benchmark Harness          ║");
  console.log("╠══════════════════════════════════════════╣");
  console.log(`║  Target:       ${BASE_URL.padEnd(26)}║`);
  console.log(`║  Iterations:   ${String(ITERATIONS).padEnd(26)}║`);
  console.log(`║  Concurrency:  ${String(CONCURRENCY).padEnd(26)}║`);
  console.log(`║  Auth:         ${("API key").padEnd(26)}║`);
  console.log("╚══════════════════════════════════════════╝");

  // Warmup
  console.log("\n⏳ Warming up...");
  await apiBurstOperation("/health", { kind: "warmup", method: "GET", bodyMode: "none" }).run();

  const results = {};

  if (RUN_ALL || FLAGS.api) results.api = await benchmarkAPI();
  if (RUN_ALL || FLAGS.webhook) results.webhook = await benchmarkWebhook();
  if (RUN_ALL || FLAGS.queue) results.queue = await benchmarkQueue();
  if (RUN_ALL) results.mixed = await benchmarkMixed();

  const suiteElapsed = ((performance.now() - suiteStart) / 1000).toFixed(1);

  console.log("\n━━━ Summary ━━━");
  console.log(`  Total time:  ${suiteElapsed}s`);

  if (results.mixed) {
    console.log(`  Mixed:       ${results.mixed.rps} RPS, p95=${results.mixed.p95}ms`);
  }

  console.log("\n✅ Benchmark complete.");

  const outPath = `benchmark-results-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  const { writeFileSync } = await import("fs");
  writeFileSync(outPath, JSON.stringify({
    timestamp: new Date().toISOString(),
    config: { baseUrl: BASE_URL, iterations: ITERATIONS, concurrency: CONCURRENCY },
    results,
  }, null, 2));
  console.log(`  Results saved to: ${outPath}`);
}

main().catch((err) => {
  console.error("Benchmark failed:", err);
  process.exit(1);
});
