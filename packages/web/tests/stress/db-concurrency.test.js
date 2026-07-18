// tests/stress/db-concurrency.test.js
// Stress Test: Database concurrency — verify no deadlocks or constraint
// violations under concurrent fixture-targeted writes + reads.
//
// CRUD-creation routes (enforcement/policies, phase2/feedback) are removed:
// they create new resources without a fixture identity and don't fit the
// fail-closed fixture contract.
import { get, post, patch, FIXTURE_REPO } from '../helpers.js';
import { boundedBurst, sleep } from './stress-helpers.js';

const CONCURRENT = 8;

describe('DB Concurrency: parallel fixture writes + reads', () => {

  describe('Merge queue config under load', () => {
    const REPO = FIXTURE_REPO;

    test('Set queue config while reading queue status concurrently', async () => {
      const tasks = [];
      for (let i = 0; i < CONCURRENT; i++) {
        if (i % 2 === 0) {
          tasks.push(() => post(
            `/api/phase2/queue/${REPO}/config`,
            { enabled: true, merge_method: 'squash', max_queue_depth: 10 + i, check_timeout_mins: 30 },
            { contractName: 'phase2-queue-config' }
          ));
        } else {
          tasks.push(() => get(`/api/phase2/queue/${REPO}`));
        }
      }
      const result = await boundedBurst(tasks, { maxConcurrent: 4, delayBetweenBatches: 500 });
      console.log(`  Queue R/W: ${result.succeeded}/${result.total} OK in ${result.elapsed}ms`);
      const okOr404 = result.statuses.filter(s => s === 200 || s === 404 || s === 429).length;
      expect(okOr404).toBe(result.total);
    });
  });

  describe('Maintainer settings concurrent updates', () => {
    test('Update same fixture repo settings concurrently (no deadlocks)', async () => {
      const REPO = FIXTURE_REPO;
      const tasks = Array.from({ length: CONCURRENT }, (_, i) => () =>
        patch(
          `/api/maintainer/${REPO}/settings`,
          { stale_issue_days: 30 + i, stale_pr_days: 14 + i },
          { contractName: 'maintainer-settings' }
        )
      );
      const result = await boundedBurst(tasks, { maxConcurrent: 4, delayBetweenBatches: 500 });
      console.log(`  Settings: ${result.succeeded}/${result.total} OK in ${result.elapsed}ms`);
      expect(result.succeeded).toBe(result.total);
    });
  });
});
