// tests/stress/webhook-simulation.test.js
// Stress Test: Simulate rapid webhook-like API calls against the fixture repo.
//
// Routes targeting guessed/dynamic identities are removed (fail-closed
// fixture contract). Only fixture-targeted mutations remain.
import { apiContractedOperation, STATUS_SETS } from './response-contracts.js';
import { runContractedBurst } from './burst-runner.js';
import { sleep } from './stress-helpers.js';
import { FIXTURE_REPO } from '../helpers.js';

describe('Webhook Simulation: rapid fixture-targeted calls', () => {
  beforeEach(async () => { await sleep(500); });

  describe('Stale scan storm on fixture repo', () => {
    test('Trigger stale scan on fixture repo concurrently', async () => {
      const REPO = FIXTURE_REPO;
      const tasks = Array.from({ length: 5 }, () => apiContractedOperation(
        `/api/maintainer/${REPO}/stale-scan`,
        {
          kind: 'write', method: 'POST', body: {}, contractName: 'maintainer-stale-scan',
          expectedStatuses: STATUS_SETS.MUTATION_TRIGGER,
        }
      ));
      const result = await runContractedBurst(tasks, {
        concurrency: 2, pacing: { mode: 'legacy_batches', delayMs: 1000 },
      });
      console.log(`  Stale x5: ${result.httpExpected}/${result.attempted} expected in ${result.elapsedMs}ms`);
      expect(result.httpUnexpected).toBe(0);
      expect(result.httpNotReceived).toBe(0);
    });
  });

  describe('Fixture repo sync storm', () => {
    test('Trigger sync on fixture repo concurrently', async () => {
      const REPO = FIXTURE_REPO;
      const tasks = Array.from({ length: 5 }, () => apiContractedOperation(
        `/api/repos/${REPO}/sync`,
        {
          kind: 'write', method: 'POST', body: {}, contractName: 'repo-sync',
          expectedStatuses: STATUS_SETS.MUTATION_ACCEPTED,
        }
      ));
      const result = await runContractedBurst(tasks, {
        concurrency: 2, pacing: { mode: 'legacy_batches', delayMs: 1000 },
      });
      console.log(`  Sync x5: ${result.httpExpected}/${result.attempted} expected in ${result.elapsedMs}ms`);
      expect(result.httpUnexpected).toBe(0);
      expect(result.httpNotReceived).toBe(0);
    });
  });
});
