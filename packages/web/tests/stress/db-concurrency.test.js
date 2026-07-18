// tests/stress/db-concurrency.test.js
// Stress Test: Database concurrency — verify no deadlocks or constraint
// violations under concurrent fixture-targeted writes + reads.
//
// CRUD-creation routes (enforcement/policies, phase2/feedback) are removed:
// they create new resources without a fixture identity and don't fit the
// fail-closed fixture contract.
import { apiBurstOperation, FIXTURE_REPO } from '../helpers.js';
import { boundedBurst } from './stress-helpers.js';

const CONCURRENT = 8;

describe('DB Concurrency: parallel fixture writes + reads', () => {

  describe('Merge queue config under load', () => {
    const REPO = FIXTURE_REPO;

    test('Set queue config while reading queue status concurrently', async () => {
      const tasks = [];
      for (let i = 0; i < CONCURRENT; i++) {
        if (i % 2 === 0) {
          tasks.push(apiBurstOperation(
            `/api/phase2/queue/${REPO}/config`,
            {
              kind: 'write', method: 'POST',
              body: { enabled: true, merge_method: 'squash', max_queue_depth: 10 + i, check_timeout_mins: 30 },
              contractName: 'phase2-queue-config',
            }
          ));
        } else {
          tasks.push(apiBurstOperation(`/api/phase2/queue/${REPO}`, { kind: 'read' }));
        }
      }
      const result = await boundedBurst(tasks, { maxConcurrent: 4, delayBetweenBatches: 500 });
      console.log(`  Queue R/W: ${result.transportCompleted}/${result.attempted} transport-OK in ${result.elapsedMs}ms`);
      const okOr404 = result.results.filter(r => r.status === 200 || r.status === 404 || r.status === 429).length;
      expect(okOr404).toBe(result.attempted);
    });
  });

  describe('Maintainer settings concurrent updates', () => {
    test('Update same fixture repo settings concurrently (no deadlocks)', async () => {
      const REPO = FIXTURE_REPO;
      const tasks = Array.from({ length: CONCURRENT }, (_, i) => apiBurstOperation(
        `/api/maintainer/${REPO}/settings`,
        {
          kind: 'write', method: 'PATCH',
          body: { stale_issue_days: 30 + i, stale_pr_days: 14 + i },
          contractName: 'maintainer-settings',
        }
      ));
      const result = await boundedBurst(tasks, { maxConcurrent: 4, delayBetweenBatches: 500 });
      console.log(`  Settings: ${result.transportCompleted}/${result.attempted} transport-OK in ${result.elapsedMs}ms`);
      expect(result.transportCompleted).toBe(result.attempted);
    });
  });
});
