// tests/stress/mutation-phase4.test.js
// Stress Test: Phase 4 mutation routes — AI review config, triggers, audit reports, exports
import { get, post, put, del } from '../helpers.js';
import { sleep, resilientGet, boundedBurst } from './stress-helpers.js';

const REPO = 'Elephant-Rock-Lab/GitWire';

describe('Stress: Phase 4 Mutations', () => {

  test('POST /review/config/:owner/:repo — set AI review config', async () => {
    const res = await post(`/api/review/config/${REPO}`, {
      enabled: true,
      review_mode: 'comment',
      max_files: 20,
      repo_filter: null,
    });
    expect([200, 201, 202]).toContain(res.status);
  });

  test('POST /review/config/:owner/:repo — concurrent config updates', async () => {
    const tasks = Array.from({ length: 5 }, (_, i) => () =>
      post(`/api/review/config/${REPO}`, {
        enabled: true,
        review_mode: i % 2 === 0 ? 'comment' : 'check_run',
        max_files: 10 + i * 5,
        repo_filter: null,
      })
    );
    const { succeeded, statuses } = await boundedBurst(tasks, { maxConcurrent: 5, delayBetweenBatches: 1000 });
    const ok = statuses.filter(s => [200, 201, 202].includes(s)).length;
    expect(ok).toBe(5);
  });

  test('POST /review/trigger/:owner/:repo/:pr — trigger review on non-existent PR', async () => {
    const res = await post(`/api/review/trigger/${REPO}/99999`, {});
    expect([200, 202, 404]).toContain(res.status);
  });

  test('POST /audit/reports — generate compliance report', async () => {
    const res = await post('/api/audit/reports', {
      reportType: 'SOC2',
      from: '2026-01-01',
      to: '2026-12-31',
      generatedBy: 'stress-test',
    });
    expect([200, 201, 202]).toContain(res.status);
  });

  test('POST /audit/export — export audit log', async () => {
    const res = await post('/api/audit/export', {
      from: '2026-01-01',
      to: '2026-12-31',
      format: 'json',
    });
    expect([200, 201, 202, 400]).toContain(res.status);
  });

  test('POST /audit/reports — 3 concurrent report generations', async () => {
    const tasks = Array.from({ length: 3 }, (_, i) => () =>
      post('/api/audit/reports', {
        reportType: 'custom',
        from: '2026-01-01',
        to: '2026-12-31',
        generatedBy: `stress-${i}`,
      })
    );
    const { succeeded, statuses } = await boundedBurst(tasks, { maxConcurrent: 3, delayBetweenBatches: 1000 });
    const ok = statuses.filter(s => [200, 201, 202].includes(s)).length;
    expect(ok).toBe(3);
  });

  test('GET /review/stats — still valid after mutations', async () => {
    await sleep(500);
    const res = await resilientGet('/api/review/stats');
    expect([200, 429]).toContain(res.status);
  });
});
