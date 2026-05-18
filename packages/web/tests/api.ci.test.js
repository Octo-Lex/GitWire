// tests/api.ci.test.js
// CI healing — runs, stats, heal history

import { get, expectOk } from './helpers.js';

describe('CI Healing', () => {
  test('GET /api/ci/stats returns stats', async () => {
    const res = await get('/api/ci/stats');
    expectOk(res);
    expect(res.body.summary).toBeDefined();
    expect(res.body.summary.total_runs).toBeDefined();
    expect(res.body.summary.pass_rate).toBeDefined();
    expect(res.body.summary.auto_healed).toBeDefined();
  });

  test('GET /api/ci returns paginated runs', async () => {
    const res = await get('/api/ci');
    expectOk(res);
    expect(res.body.data).toBeInstanceOf(Array);
    expect(res.body.meta).toBeDefined();
  });

  test('GET /api/ci?conclusion=failure filters failures', async () => {
    const res = await get('/api/ci?conclusion=failure');
    expectOk(res);
    for (const run of res.body.data) {
      expect(run.conclusion).toBe('failure');
    }
  });

  test('CI runs have expected fields', async () => {
    const res = await get('/api/ci?per_page=5');
    expectOk(res);
    if (res.body.data.length > 0) {
      const run = res.body.data[0];
      expect(run.id).toBeDefined();
      expect(run.conclusion).toBeDefined();
      expect(run.heal_status).toBeDefined();
    }
  });

  test('GET /api/heal/stats returns heal stats', async () => {
    const res = await get('/api/heal/stats');
    expectOk(res);
    expect(res.body.summary).toBeDefined();
    expect(res.body.summary.total_heals).toBeDefined();
  });

  test('GET /api/heal returns heal history', async () => {
    const res = await get('/api/heal');
    expectOk(res);
    // Response may be paginated or a list
    expect(res.body).toBeDefined();
  });
});
