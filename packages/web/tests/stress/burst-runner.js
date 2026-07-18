// packages/web/tests/stress/burst-runner.js
//
// ⚠️ MECHANICAL EXTRACTION — temporary old-semantics stub for the PR2a red phase.
//
// This file is a VERBATIM copy of the current boundedBurst behavior from
// stress-helpers.js, renamed to runBurst so defect-sensitive tests can be
// written against the NEW API surface before the new implementation exists.
//
// The tests in tests/unit/burst-runner.test.js target the new result shape
// (transportCompleted, transportFailed, statusCounts, body states, etc.).
// Against this stub they will FAIL at the assertion level — not at import —
// because runBurst returns { succeeded, statuses, ... } (the old shape) while
// the tests assert .transportCompleted etc. That is the defect-sensitive red
// evidence the plan requires: each failure reaches its assertion for the
// intended reason, demonstrating the test is sensitive to the defect.
//
// Once the red evidence is captured, this file is replaced with the real
// implementation (scheduler, httpOperation, aggregates, etc.).

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Verbatim from stress-helpers.js boundedBurst, renamed.
// OLD SEMANTICS: succeeded === fulfilled Promise count (the defect PR2a fixes).
export async function runBurst(tasks, options = {}) {
  const maxConcurrent = options.maxConcurrent ?? options.concurrency ?? 8;
  const delayBetweenBatches = options.delayBetweenBatches ??
    (options.pacing && options.pacing.delayMs) ?? 500;
  const start = Date.now();
  const results = [];
  for (let i = 0; i < tasks.length; i += maxConcurrent) {
    const batch = tasks.slice(i, i + maxConcurrent);
    // Support both bare functions and {run} descriptors for the transition.
    const fns = batch.map(t => typeof t === 'function' ? t : t.run);
    const batchResults = await Promise.allSettled(fns.map(fn => fn()));
    results.push(...batchResults);
    if (i + maxConcurrent < tasks.length && delayBetweenBatches > 0) {
      await sleep(delayBetweenBatches);
    }
  }
  const elapsed = Date.now() - start;
  const succeeded = results.filter(r => r.status === 'fulfilled').length;
  const failed = results.filter(r => r.status === 'rejected').length;
  const statuses = results.map(r => r.status === 'fulfilled' ? r.value?.status : 0);
  return { elapsed, succeeded, failed, total: tasks.length, statuses, results };
}

// Placeholder — does not exist yet. Tests that import it will fail at import,
// which is acceptable ONLY for gates that require types not present in old code.
// For gates that test against runBurst's output, the failure is at assertion.
export function httpOperation() {
  throw new Error('httpOperation not yet implemented (mechanical-extraction red phase)');
}

export function classifyTransportError() {
  throw new Error('classifyTransportError not yet implemented');
}
