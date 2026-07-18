// tests/stress/stress-helpers.js
// Shared utilities for stress tests.
//
// boundedBurst is now a thin adapter over the shared burst-runner.js core
// (the same module scripts/benchmark.js uses). It maps the legacy call
// signature to runBurst with pacing.mode="legacy_batches" — exact preservation
// of the previous cohort-batch-with-delay traffic shape. Tasks must be
// operation descriptors (from apiBurstOperation) or bare functions returning
// a ClassifiedOutcome. Legacy {status, body} return values are NOT normalized
// into body classifications (amendment 10) — consumers must use
// apiBurstOperation for factual body handling.

import { runBurst } from './burst-runner.js';

/**
 * Sleep for ms milliseconds.
 */
export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Fetch with automatic retry on 429 rate limit. Returns { status, body } in
 * the legacy shape for non-burst callers. For burst usage, use
 * resilientGetBurstOperation() from helpers.js instead.
 */
export async function resilientGet(path, retries = 3) {
  // Delegate to the POLICY-aware api() for URL resolution + auth.
  const { get } = await import('../helpers.js');
  for (let attempt = 0; attempt <= retries; attempt++) {
    const res = await get(path);
    if (res.status === 429 && attempt < retries) {
      await sleep(2000);
      continue;
    }
    return res;
  }
}

/**
 * Run a burst of operations with concurrency-batched execution and optional
 * delay between batches. Delegates to the shared runBurst core with
 * pacing.mode="legacy_batches" — the exact traffic shape the stress suite
 * was designed around (start a cohort of maxConcurrent, wait for all to
 * settle, wait delayBetweenBatches, start the next cohort).
 *
 * Tasks must be operation descriptors (from apiBurstOperation()) or bare
 * functions returning a ClassifiedOutcome. Legacy {status, body} returns
 * will fail outcome validation — use apiBurstOperation for factual outcomes.
 *
 * Returns the factual aggregate from runBurst (attempted, transportCompleted,
 * transportFailed, statusCounts, body counts, latency, results, etc.).
 * The old {succeeded, statuses, total} fields are GONE.
 *
 * @param {Array} tasks operation descriptors or bare functions
 * @param {Object} [options]
 * @param {number} [options.maxConcurrent=8]
 * @param {number} [options.delayBetweenBatches=500]
 * @returns {Promise<Aggregate>} see burst-runner.js for the full shape
 */
export async function boundedBurst(tasks, options = {}) {
  const maxConcurrent = options.maxConcurrent ?? 8;
  const delayBetweenBatches = options.delayBetweenBatches ?? 500;
  return runBurst(tasks, {
    concurrency: maxConcurrent,
    pacing: { mode: "legacy_batches", delayMs: delayBetweenBatches },
  });
}
