// tests/stress/webhook-simulation.test.js
// Stress Test: Simulate rapid webhook-like API calls against the fixture repo.
//
// Routes targeting guessed/dynamic identities (sync-from-/api/repos list,
// ci/${id}/retry on non-existent runs, fix/backfill/review on fake-org) are
// removed: a fail-closed fixture contract requires the declared fixture
// identity be present and correct. Only fixture-targeted mutations remain.
import { apiBurstOperation, FIXTURE_REPO } from '../helpers.js';
import { boundedBurst, sleep } from './stress-helpers.js';

describe('Webhook Simulation: rapid fixture-targeted calls', () => {
  beforeEach(async () => { await sleep(500); });

  describe('Stale scan storm on fixture repo', () => {
    test('Trigger stale scan on fixture repo concurrently', async () => {
      const REPO = FIXTURE_REPO;
      const tasks = Array.from({ length: 5 }, () => apiBurstOperation(
        `/api/maintainer/${REPO}/stale-scan`,
        { kind: 'write', method: 'POST', body: {}, contractName: 'maintainer-stale-scan' }
      ));
      const result = await boundedBurst(tasks, { maxConcurrent: 2, delayBetweenBatches: 1000 });
      console.log(`  Stale x5: ${result.transportCompleted}/${result.attempted} in ${result.elapsedMs}ms`);
      result.results.forEach(r => expect(r.status).not.toBe(500));
    });
  });

  describe('Fixture repo sync storm', () => {
    test('Trigger sync on fixture repo concurrently', async () => {
      const REPO = FIXTURE_REPO;
      const tasks = Array.from({ length: 5 }, () => apiBurstOperation(
        `/api/repos/${REPO}/sync`,
        { kind: 'write', method: 'POST', body: {}, contractName: 'repo-sync' }
      ));
      const result = await boundedBurst(tasks, { maxConcurrent: 2, delayBetweenBatches: 1000 });
      console.log(`  Sync x5: ${result.transportCompleted}/${result.attempted} in ${result.elapsedMs}ms`);
      result.results.forEach(r => expect(r.status).not.toBe(500));
    });
  });
});
