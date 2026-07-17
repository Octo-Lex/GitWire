// tests/stress/mutation-phase3.test.js
// Stress Test: Phase 3 mutation routes — reconciler, dependency scanning, flaky tests
import { get, post, put, del, FIXTURE_REPO, FIXTURE_INSTALLATION_ID } from '../helpers.js';
import { sleep, resilientGet, boundedBurst } from './stress-helpers.js';

const REPO = FIXTURE_REPO;

describe('Stress: Phase 3 Mutations', () => {

  test('POST /phase3/reconciler/run — trigger reconciliation', async () => {
    const res = await post('/api/phase3/reconciler/run', { installation_id: FIXTURE_INSTALLATION_ID });
    expect([200, 201, 202]).toContain(res.status);
  });

  test('POST /phase3/reconciler/run — 3 concurrent runs idempotent', async () => {
    const tasks = Array.from({ length: 3 }, () => () =>
      post('/api/phase3/reconciler/run', { installation_id: FIXTURE_INSTALLATION_ID })
    );
    const { succeeded, statuses } = await boundedBurst(tasks, { maxConcurrent: 3, delayBetweenBatches: 1000 });
    const ok = statuses.filter(s => [200, 201, 202].includes(s)).length;
    expect(ok).toBe(3);
  });

  test('PUT /phase3/reconciler/repos/:owner/:repo — update reconciler config', async () => {
    const res = await put(`/api/phase3/reconciler/repos/${REPO}`, {
      reconcile_skip: false,
    });
    expect([200, 201, 202, 404]).toContain(res.status);
  });

  test('POST /phase3/dependencies/:owner/:repo/scan — trigger dep scan', async () => {
    const res = await post(`/api/phase3/dependencies/${REPO}/scan`, {});
    expect([200, 201, 202]).toContain(res.status);
  });

  test('POST /phase3/flaky/:id/graduate — graduate non-existent test returns gracefully', async () => {
    const res = await post('/api/phase3/flaky/999999/graduate', {});
    expect([200, 202, 404]).toContain(res.status);
  });

  test('POST /phase3/flaky/:id/dismiss — dismiss non-existent test returns gracefully', async () => {
    const res = await post('/api/phase3/flaky/999999/dismiss', {});
    expect([200, 202, 404]).toContain(res.status);
  });

  test('POST /phase3/dependencies/vuln/:id/dismiss — dismiss non-existent vuln', async () => {
    const res = await post('/api/phase3/dependencies/vuln/999999/dismiss', { reason: 'stress test' });
    expect([200, 202, 404]).toContain(res.status);
  });

  test('POST /phase3/dependencies/:owner/:repo/batch-pr — batch update PR', async () => {
    const res = await post(`/api/phase3/dependencies/${REPO}/batch-pr`, {
      ecosystem: 'npm',
      deps: ['express'],
    });
    expect([200, 201, 202, 400, 404]).toContain(res.status);
  });
});
