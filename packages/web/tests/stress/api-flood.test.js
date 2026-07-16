// tests/stress/api-flood.test.js
// Stress Test: API Flood — high-concurrency reads across all endpoints
//
// Run: NODE_OPTIONS="--experimental-vm-modules" npx jest tests/stress/api-flood.test.js --testTimeout=120000 --runInBand

import { get } from '../helpers.js';
import { boundedBurst, sleep } from './stress-helpers.js';

const CONCURRENT = 8;
const ROUNDS = 3;

describe(`API Flood: ${CONCURRENT} concurrent × ${ROUNDS} rounds`, () => {
  beforeEach(async () => {
    await sleep(1000); // Ensure rate limit window is fresh
  });

  test('GET /api/repos survives flood', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const tasks = Array.from({ length: CONCURRENT }, () => () => get('/api/repos'));
      const result = await boundedBurst(tasks, { maxConcurrent: CONCURRENT });
      console.log(`  Round ${round + 1}: ${result.succeeded}/${result.total} OK in ${result.elapsed}ms`);
      expect(result.succeeded).toBe(result.total);
      // Allow 429 in later rounds (rate limit)
      const okStatuses = result.statuses.filter(s => s === 200 || s === 429);
      expect(okStatuses.length).toBe(result.total);
      await sleep(500);
    }
  });

  test('GET /api/issues survives flood', async () => {
    const tasks = Array.from({ length: CONCURRENT }, () => () => get('/api/issues'));
    const result = await boundedBurst(tasks);
    console.log(`  Issues: ${result.succeeded}/${result.total} OK in ${result.elapsed}ms`);
    expect(result.succeeded).toBe(result.total);
  });

  test('GET /api/ci/stats survives flood', async () => {
    const tasks = Array.from({ length: CONCURRENT }, () => () => get('/api/ci/stats'));
    const result = await boundedBurst(tasks);
    console.log(`  CI stats: ${result.succeeded}/${result.total} OK in ${result.elapsed}ms`);
    expect(result.succeeded).toBe(result.total);
  });

  test('GET /api/insights/overview survives flood', async () => {
    const tasks = Array.from({ length: CONCURRENT }, () => () => get('/api/insights/overview'));
    const result = await boundedBurst(tasks);
    console.log(`  Insights: ${result.succeeded}/${result.total} OK in ${result.elapsed}ms`);
    expect(result.succeeded).toBe(result.total);
  });

  test('GET /health survives flood (no auth required)', async () => {
    const tasks = Array.from({ length: CONCURRENT }, () => () =>
      fetch(`${process.env.GITWIRE_BASE_URL || (() => { throw new Error("GITWIRE_BASE_URL is required"); })()}/health`)
        .then(r => ({ status: r.status }))
    );
    const result = await boundedBurst(tasks);
    console.log(`  Health: ${result.succeeded}/${result.total} OK in ${result.elapsed}ms`);
    expect(result.succeeded).toBe(result.total);
    expect(result.statuses.every(s => s === 200)).toBe(true);
  });

  test('Mixed 18 endpoints all return 200', async () => {
    const endpoints = [
      '/api/repos', '/api/issues', '/api/pull-requests', '/api/ci',
      '/api/ci/stats', '/api/insights/overview', '/api/insights/repos',
      '/api/insights/velocity', '/api/insights/ci-trend', '/api/duplicates',
      '/api/duplicates/stats', '/api/heal/stats', '/api/maintainer/members',
      '/api/enforcement/stats', '/api/phase2/queue',
      '/api/phase2/telemetry/summary', '/api/review/stats', '/api/audit/stats',
    ];
    // Sequential to avoid rate limits
    const start = Date.now();
    const statuses = [];
    for (const ep of endpoints) {
      const res = await get(ep);
      statuses.push(res.status);
    }
    const elapsed = Date.now() - start;
    const ok = statuses.filter(s => s === 200).length;
    console.log(`  Mixed ${endpoints.length} endpoints: ${ok}/${endpoints.length} OK in ${elapsed}ms`);
    expect(ok).toBe(endpoints.length);
  });
});
