// tests/stress/db-concurrency.test.js
// Stress Test: Database concurrency — verify no deadlocks or constraint
// violations under concurrent fixture-targeted writes + reads.
import { apiContractedOperation, STATUS_SETS } from './response-contracts.js';
import { runContractedBurst } from './burst-runner.js';
import { FIXTURE_REPO } from '../helpers.js';

const CONCURRENT = 8;

describe('DB Concurrency: parallel fixture writes + reads', () => {

  describe('Merge queue config under load', () => {
    const REPO = FIXTURE_REPO;

    test('Set queue config while reading queue status concurrently', async () => {
      const tasks = [];
      for (let i = 0; i < CONCURRENT; i++) {
        if (i % 2 === 0) {
          tasks.push(apiContractedOperation(
            `/api/phase2/queue/${REPO}/config`,
            {
              kind: 'write', method: 'POST',
              body: { enabled: true, merge_method: 'squash', max_queue_depth: 10 + i, check_timeout_mins: 30 },
              contractName: 'phase2-queue-config',
              expectedStatuses: STATUS_SETS.MUTATION_ACCEPTED,
            }
          ));
        } else {
          tasks.push(apiContractedOperation(
            `/api/phase2/queue/${REPO}`,
            {
              kind: 'read', method: 'GET',
              expectedStatuses: STATUS_SETS.READ_OK_OR_NOT_FOUND_OR_RATE_LIMITED,
            }
          ));
        }
      }
      const result = await runContractedBurst(tasks, {
        concurrency: 4, pacing: { mode: 'legacy_batches', delayMs: 500 },
      });
      console.log(`  Queue R/W: ${result.httpExpected}/${result.attempted} expected in ${result.elapsedMs}ms`);
      expect(result.httpNotReceived).toBe(0);
      expect(result.httpExpected).toBe(result.attempted);
    });
  });

  describe('Maintainer settings concurrent updates', () => {
    test('Update same fixture repo settings concurrently (no deadlocks)', async () => {
      const REPO = FIXTURE_REPO;
      const tasks = Array.from({ length: CONCURRENT }, (_, i) => apiContractedOperation(
        `/api/maintainer/${REPO}/settings`,
        {
          kind: 'write', method: 'PATCH',
          body: { stale_issue_days: 30 + i, stale_pr_days: 14 + i },
          contractName: 'maintainer-settings',
          expectedStatuses: STATUS_SETS.MUTATION_ACCEPTED,
        }
      ));
      const result = await runContractedBurst(tasks, {
        concurrency: 4, pacing: { mode: 'legacy_batches', delayMs: 500 },
      });
      console.log(`  Settings: ${result.httpExpected}/${result.attempted} expected in ${result.elapsedMs}ms`);
      expect(result.httpExpected).toBe(result.attempted);
      expect(result.httpUnexpected).toBe(0);
    });
  });
});
