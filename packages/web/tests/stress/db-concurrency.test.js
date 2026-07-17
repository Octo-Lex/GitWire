// tests/stress/db-concurrency.test.js
// Stress Test: Database concurrency — verify no deadlocks or constraint violations under load
//
// Run: NODE_OPTIONS="--experimental-vm-modules" npx jest tests/stress/db-concurrency.test.js --testTimeout=120000 --runInBand

import { get, post, del, FIXTURE_REPO } from '../helpers.js';
import { boundedBurst, sleep } from './stress-helpers.js';

const CONCURRENT = 8;

describe('DB Concurrency: parallel writes + reads', () => {

  describe('Enforcement policy CRUD under load', () => {
    const createdPolicyIds = [];

    afterAll(async () => {
      for (const id of createdPolicyIds) {
        try { await del(`/api/enforcement/policies/${id}`); } catch {}
      }
    });

    test(`Create ${CONCURRENT} policies concurrently`, async () => {
      const tasks = Array.from({ length: CONCURRENT }, (_, i) => () =>
        post('/api/enforcement/policies', {
          name: `stress-policy-${Date.now()}-${i}`,
          description: `Stress test policy ${i}`,
          branch_pattern: `stress/${i}`,
          min_reviews: 1,
          mode: 'audit',
          enabled: true,
        })
      );
      const result = await boundedBurst(tasks, { maxConcurrent: 4, delayBetweenBatches: 500 });
      console.log(`  Create: ${result.succeeded}/${result.total} OK in ${result.elapsed}ms`);

      result.results.forEach(r => {
        if (r.status === 'fulfilled' && r.value?.body?.id) {
          createdPolicyIds.push(r.value.body.id);
        }
      });
      expect(result.succeeded).toBe(result.total);
    });

    test('Read policies while listing concurrently', async () => {
      const tasks = Array.from({ length: CONCURRENT }, () => () => get('/api/enforcement/policies'));
      const result = await boundedBurst(tasks);
      console.log(`  Read: ${result.succeeded}/${result.total} OK in ${result.elapsed}ms`);
      expect(result.succeeded).toBe(result.total);
    });
  });

  describe('Merge queue config under load', () => {
    const REPO = FIXTURE_REPO;

    test('Set queue config while reading queue status concurrently', async () => {
      const tasks = [];
      for (let i = 0; i < CONCURRENT; i++) {
        if (i % 2 === 0) {
          tasks.push(() => post(`/api/phase2/queue/${REPO}/config`, {
            enabled: true,
            merge_method: 'squash',
            max_queue_depth: 10 + i,
            check_timeout_mins: 30,
          }));
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

  describe('Feedback rules CRUD under load', () => {
    const createdRuleIds = [];

    afterAll(async () => {
      for (const id of createdRuleIds) {
        try { await del(`/api/phase2/feedback/${id}`); } catch {}
      }
    });

    test(`Create ${CONCURRENT} feedback rules concurrently`, async () => {
      const tasks = Array.from({ length: CONCURRENT }, (_, i) => () =>
        post('/api/phase2/feedback', {
          name: `stress-rule-${Date.now()}-${i}`,
          event_type: 'merge_success',
          post_pr_comment: true,
          enabled: true,
        })
      );
      const result = await boundedBurst(tasks, { maxConcurrent: 4, delayBetweenBatches: 500 });
      console.log(`  Feedback: ${result.succeeded}/${result.total} OK in ${result.elapsed}ms`);

      result.results.forEach(r => {
        if (r.status === 'fulfilled' && r.value?.body?.id) {
          createdRuleIds.push(r.value.body.id);
        }
      });
      expect(result.succeeded).toBe(result.total);
    });
  });

  describe('Maintainer settings concurrent updates', () => {
    test('Update same repo settings concurrently (no deadlocks)', async () => {
      const REPO = FIXTURE_REPO;
      const tasks = Array.from({ length: CONCURRENT }, (_, i) => () =>
        post(`/api/maintainer/${REPO}/settings`, {
          stale_issue_days: 30 + i,
          stale_pr_days: 14 + i,
        })
      );
      const result = await boundedBurst(tasks, { maxConcurrent: 4, delayBetweenBatches: 500 });
      console.log(`  Settings: ${result.succeeded}/${result.total} OK in ${result.elapsed}ms`);
      expect(result.succeeded).toBe(result.total);
    });
  });
});
