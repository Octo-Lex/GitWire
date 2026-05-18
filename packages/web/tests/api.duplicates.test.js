// tests/api.duplicates.test.js
// Duplicate detection

import { get, post, expectOk } from './helpers.js';

describe('Duplicate Detection', () => {
  test('GET /api/duplicates/stats returns stats', async () => {
    const res = await get('/api/duplicates/stats');
    expectOk(res);
    expect(res.body.summary).toBeDefined();
    expect(res.body.summary.total_signals).toBeDefined();
    expect(res.body.coverage).toBeDefined();
    expect(res.body.coverage.coverage_pct).toBeDefined();
  });

  test('GET /api/duplicates returns signals', async () => {
    const res = await get('/api/duplicates');
    expectOk(res);
    expect(res.body.data).toBeInstanceOf(Array);
  });

  test('Coverage is 100% for embedded issues', async () => {
    const res = await get('/api/duplicates/stats');
    expectOk(res);
    expect(Number(res.body.coverage.coverage_pct)).toBe(100);
  });
});
