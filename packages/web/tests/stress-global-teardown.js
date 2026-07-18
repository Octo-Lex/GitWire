// tests/stress-global-teardown.js
//
// Jest globalTeardown for the stress suite. Runs once after all tests
// (including unit tests that don't use the budget). If the stress mutation
// env is configured, attaches to the run's budget namespace (as a
// participant, since the orchestrator already initialized it) and marks it
// finalized so a future run with the same GITWIRE_STRESS_RUN_ID fails closed
// on stale reuse rather than attaching to consumed slots.
//
// This is the Jest-side counterpart of benchmark.js's finally-block finalize.

import { loadPolicy } from './target-policy.js';

export default async function globalTeardown() {
  // Only finalize when mutations were enabled for this run. Read-only stress
  // runs have no budget to finalize.
  if (process.env.GITWIRE_STRESS_ALLOW_MUTATIONS !== 'true') return;
  if (!process.env.GITWIRE_STRESS_RUN_ID) return;
  try {
    const policy = loadPolicy({ requireStressGate: true });
    if (policy.budget) {
      policy.budget.finalize();
    }
  } catch (err) {
    // Surface but do not swallow: a failed finalize means the namespace is
    // not marked done, and reuse would silently attach to stale state.
    // eslint-disable-next-line no-console
    console.error(`[globalTeardown] budget finalize failed: ${err.message}`);
    process.exitCode = 1;
  }
}
