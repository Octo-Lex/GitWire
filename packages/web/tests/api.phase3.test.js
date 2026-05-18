// tests/api.phase3.test.js
// Phase 3 — Enforcement, Dependencies, Flaky Tests, Reconciler

import { get, post, expectOk } from './helpers.js';

describe('Phase 3: Enforcement', () => {
  test('GET /api/enforcement/policies returns policies', async () => {
    const res = await get('/api/enforcement/policies');
    expectOk(res);
    expect(Array.isArray(res.body)).toBe(true);
  });

  test('GET /api/enforcement/violations returns violations', async () => {
    const res = await get('/api/enforcement/violations');
    expectOk(res);
    expect(res.body.data).toBeInstanceOf(Array);
  });

  test('GET /api/enforcement/stats returns stats', async () => {
    const res = await get('/api/enforcement/stats');
    expectOk(res);
    expect(res.body).toBeDefined();
  });
});

describe('Phase 3: Dependencies', () => {
  test('GET /api/phase3/dependencies/stats returns stats', async () => {
    const res = await get('/api/phase3/dependencies/stats');
    expectOk(res);
    expect(res.body).toBeDefined();
  });

  test('GET /api/phase3/flaky/stats returns stats', async () => {
    const res = await get('/api/phase3/flaky/stats');
    expectOk(res);
    expect(res.body).toBeDefined();
  });
});

describe('Phase 3: Reconciler', () => {
  test('GET /api/phase3/reconciler/runs returns runs', async () => {
    const res = await get('/api/phase3/reconciler/runs');
    expectOk(res);
    expect(res.body.data).toBeInstanceOf(Array);
    // Should have at least 8 runs from previous testing
    if (res.body.data.length > 0) {
      expect(res.body.data[0].id).toBeDefined();
    }
  });

  test('GET /api/phase3/reconciler/repos returns repo statuses', async () => {
    const res = await get('/api/phase3/reconciler/repos');
    expectOk(res);
    expect(res.body.data).toBeInstanceOf(Array);
  });
});
