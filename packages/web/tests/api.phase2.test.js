// tests/api.phase2.test.js
// Phase 2 — Merge Queue, Feedback, Telemetry

import { get, post, expectOk } from './helpers.js';

describe('Phase 2: Merge Queue', () => {
  test('GET /api/phase2/queue returns entries', async () => {
    const res = await get('/api/phase2/queue');
    expectOk(res);
    expect(res.body.data).toBeInstanceOf(Array);
    expect(res.body.meta).toBeDefined();
  });

  test('GET /api/phase2/queue/xjeddah/MyShell returns repo queue', async () => {
    const res = await get('/api/phase2/queue/xjeddah/MyShell');
    expectOk(res);
    expect(res.body.entries).toBeInstanceOf(Array);
    // Config should exist now
    expect(res.body.config).toBeDefined();
    // enabled may be returned as string from PG
    expect([true, 'true', false, 'false']).toContain(res.body.config.enabled);
  });
});

describe('Phase 2: Feedback', () => {
  test('GET /api/phase2/feedback returns rules', async () => {
    const res = await get('/api/phase2/feedback');
    expectOk(res);
    // May be array directly or paginated
    expect(Array.isArray(res.body)).toBe(true);
  });
});

describe('Phase 2: Telemetry', () => {
  test('GET /api/phase2/telemetry/summary returns summary', async () => {
    const res = await get('/api/phase2/telemetry/summary');
    expectOk(res);
    expect(res.body.merges).toBeDefined();
    expect(res.body.ci_pass_rate).toBeDefined();
  });

  test('GET /api/phase2/telemetry/events returns events', async () => {
    const res = await get('/api/phase2/telemetry/events');
    expectOk(res);
    expect(res.body.data).toBeInstanceOf(Array);
  });

  test('GET /api/phase2/telemetry/ci-health returns health', async () => {
    const res = await get('/api/phase2/telemetry/ci-health');
    expectOk(res);
    expect(res.body).toBeDefined();
  });
});

describe('Phase 2: Rollbacks', () => {
  test('GET /api/phase2/rollbacks returns list', async () => {
    const res = await get('/api/phase2/rollbacks');
    expectOk(res);
    expect(res.body.data).toBeInstanceOf(Array);
  });
});
