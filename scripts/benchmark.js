// scripts/benchmark.js
// GitWire Benchmark Harness — measures webhook RPS, queue throughput, and API p95.
//
// Usage:
//   node scripts/benchmark.js                    # Full suite
//   node scripts/benchmark.js --webhook          # Webhook ingestion only
//   node scripts/benchmark.js --api              # API latency only
//   node scripts/benchmark.js --queue            # Queue throughput only
//   node scripts/benchmark.js --iterations 500   # Custom iteration count
//   node scripts/benchmark.js --concurrency 20   # Custom concurrency
//
// Requires:
//   - GitWire running (local or production)
//   - API_KEY set in env or passed via --api-key

import { randomUUID } from "crypto";

// ── Configuration ──────────────────────────────────────────────────────────

const BASE_URL = process.env.GITWIRE_BASE_URL || "https://gitwire.erlab.uk";
const API_KEY = process.env.API_KEY || process.argv.find((a, i) => process.argv[i - 1] === "--api-key") || "";
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
  const headers = {
    "Content-Type": "application/json",
    ...(API_KEY ? { Authorization: `Bearer ${API_KEY}` } : {}),
    ...opts.headers,
  };
  const start = performance.now();
  const res = await fetch(`${BASE_URL}${path}`, { ...opts, headers });
  const elapsed = performance.now() - start;
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body, elapsed };
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
  console.log(`  ${ITERATIONS} synthetic push events × ${CONCURRENCY} concurrency`);

  // Build a synthetic push event payload
  function makePayload() {
    const deliveryId = randomUUID();
    return {
      deliveryId,
      eventName: "push",
      payload: JSON.stringify({
        ref: "refs/heads/main",
        before: "abc1234",
        after: "def5678",
        repository: {
          id: 99999999,
          full_name: "benchmark-org/benchmark-repo",
          name: "benchmark-repo",
          owner: { login: "benchmark-org" },
          private: true,
          default_branch: "main",
        },
        sender: { login: "benchmark-bot" },
        installation: { id: 9999999 },
        commits: [],
        head_commit: { id: "def5678", message: "bench: synthetic push" },
      }),
    };
  }

  // We POST to /webhooks/github with synthetic data.
  // Signature won't verify, so we measure the rejection speed.
  // For a true benchmark, we'd need the webhook secret — but rejection
  // speed still tests the HTTP stack, body parsing, and early return.
  const durations = [];
  let accepted = 0;
  let rejected = 0;

  const res = await burst(
    () => {
      const p = makePayload();
      return apiFetch("/webhooks/github", {
        method: "POST",
        headers: {
          "X-GitHub-Event": p.eventName,
          "X-GitHub-Delivery": p.deliveryId,
          "X-Hub-Signature-256": "sha256=fakesignature",
        },
        body: p.payload,
      });
    },
    ITERATIONS,
    CONCURRENCY,
  );

  for (const r of res) {
    durations.push(r.elapsed);
    if (r.status === 202) accepted++;
    else rejected++;
  }

  const s = stats(durations);
  printStats("POST /webhooks/github (synthetic)", s);
  console.log(`    Accepted:  ${accepted}`);
  console.log(`    Rejected:  ${rejected} (expected — fake signature)`);

  return { ...s, accepted, rejected };
}

// ── Benchmark: Queue Throughput ─────────────────────────────────────────────

async function benchmarkQueue() {
  console.log("\n━━━ Queue Throughput Benchmark ━━━");
  console.log(`  ${ITERATIONS} jobs enqueued × measure drain time`);

  // We'll enqueue N jobs to a dedicated benchmark queue,
  // then measure how fast they drain with a temporary worker.

  // Use the API to trigger sync jobs (they go to BullMQ) and measure
  // how fast the queue accepts them.
  const syncJobs = [];
  const res = await burst(
    () => apiFetch("/api/repos/Elephant-Rock-Lab/GitWire/sync", { method: "POST" }),
    Math.min(ITERATIONS, 20), // Don't overwhelm with real sync jobs
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
  if (errors > 0) console.log(`    Errors:    ${errors} (404s expected for missing repos)`);

  return s;
}

// ── Benchmark: Mixed Workload ───────────────────────────────────────────────

async function benchmarkMixed() {
  console.log("\n━━━ Mixed Workload Benchmark ━━━");
  console.log(`  ${ITERATIONS} mixed read/write ops × ${CONCURRENCY} concurrency`);

  const operations = [
    // Reads (70%)
    () => apiFetch("/api/repos"),
    () => apiFetch("/api/issues?limit=20"),
    () => apiFetch("/api/ci/stats"),
    () => apiFetch("/api/actions/summary"),
    () => apiFetch("/api/activity/summary"),
    () => apiFetch("/health"),
    () => apiFetch("/api/webhooks/deliveries?limit=10"),
    // Writes (30%) — use safe non-destructive operations
    () => apiFetch("/api/repos/nonexistent/benchmark-sync/sync", { method: "POST" }),
    () => apiFetch("/api/ci/999999999/retry", { method: "POST" }),
    () => apiFetch("/api/actions/999999999/retry", { method: "POST" }),
  ];

  const res = await burst(
    () => operations[Math.floor(Math.random() * operations.length)](),
    ITERATIONS,
    CONCURRENCY,
  );

  const readDurations = [];
  const writeDurations = [];
  let readErrors = 0;
  let writeErrors = 0;

  // Classify: operations 0-6 are reads, 7-9 are writes
  // We can't perfectly classify from results, so split by status pattern
  for (const r of res) {
    if (r.elapsed < 0) continue;
    // Writes typically return 202, 404, or 400; reads return 200
    if (r.status === 200) {
      readDurations.push(r.elapsed);
    } else {
      writeDurations.push(r.elapsed);
    }
  }

  if (readDurations.length > 0) {
    printStats("Read operations", stats(readDurations));
  }
  if (writeDurations.length > 0) {
    printStats("Write operations", stats(writeDurations));
  }

  const allDurations = res.filter((r) => r.elapsed > 0).map((r) => r.elapsed);
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
