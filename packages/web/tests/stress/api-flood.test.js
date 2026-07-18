// tests/stress/api-flood.test.js
// Stress Test: API Flood — high-concurrency reads across all endpoints.
//
// Run: NODE_OPTIONS="--experimental-vm-modules" npx jest tests/stress/api-flood.test.js --testTimeout=120000 --runInBand

import { apiBurstOperation, get } from '../helpers.js';
import { boundedBurst, sleep } from './stress-helpers.js';

const CONCURRENT = 8;
const ROUNDS = 3;

describe(`API Flood: ${CONCURRENT} concurrent × ${ROUNDS} rounds`, () => {
  beforeEach(async () => {
    await sleep(1000); // Ensure rate limit window is fresh
  });

  test('GET /api/repos survives flood', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const tasks = Array.from({ length: CONCURRENT }, () => apiBurstOperation('/api/repos', { kind: 'read' }));
      const result = await boundedBurst(tasks, { maxConcurrent: CONCURRENT });
      console.log(`  Round ${round + 1}: ${result.transportCompleted}/${result.attempted} transport-OK in ${result.elapsedMs}ms`);
      expect(result.transportCompleted).toBe(result.attempted);
      // Allow 429 in later rounds (rate limit)
      const okStatuses = result.results.filter(r => r.status === 200 || r.status === 429);
      expect(okStatuses.length).toBe(result.attempted);
      await sleep(500);
    }
  });

  test('GET /api/issues survives flood', async () => {
    const tasks = Array.from({ length: CONCURRENT }, () => apiBurstOperation('/api/issues', { kind: 'read' }));
    const result = await boundedBurst(tasks);
    console.log(`  Issues: ${result.transportCompleted}/${result.attempted} transport-OK in ${result.elapsedMs}ms`);
    expect(result.transportCompleted).toBe(result.attempted);
  });

  test('GET /api/ci/stats survives flood', async () => {
    const tasks = Array.from({ length: CONCURRENT }, () => apiBurstOperation('/api/ci/stats', { kind: 'read' }));
    const result = await boundedBurst(tasks);
    console.log(`  CI stats: ${result.transportCompleted}/${result.attempted} transport-OK in ${result.elapsedMs}ms`);
    expect(result.transportCompleted).toBe(result.attempted);
  });

  test('GET /api/insights/overview survives flood', async () => {
    const tasks = Array.from({ length: CONCURRENT }, () => apiBurstOperation('/api/insights/overview', { kind: 'read' }));
    const result = await boundedBurst(tasks);
    console.log(`  Insights: ${result.transportCompleted}/${result.attempted} transport-OK in ${result.elapsedMs}ms`);
    expect(result.transportCompleted).toBe(result.attempted);
  });

  test('GET /health survives flood (no auth required)', async () => {
    const tasks = Array.from({ length: CONCURRENT }, () => ({
      kind: 'health',
      method: 'GET',
      run: async () => {
        // /health does not require auth; use raw fetch via the base URL.
        const { BASE_URL } = await import('../helpers.js');
        const res = await fetch(`${BASE_URL}/health`);
        return {
          transport: 'completed',
          status: res.status,
          body: { state: 'not_read', value: null, error: null },
          error: null,
        };
      },
    }));
    const result = await boundedBurst(tasks);
    console.log(`  Health: ${result.transportCompleted}/${result.attempted} transport-OK in ${result.elapsedMs}ms`);
    expect(result.transportCompleted).toBe(result.attempted);
    expect(result.results.every(r => r.status === 200)).toBe(true);
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
    let ok = 0;
    for (const ep of endpoints) {
      const res = await get(ep);
      if (res.status === 200) ok++;
    }
    console.log(`  Mixed ${endpoints.length} endpoints: ${ok}/${endpoints.length} OK`);
    expect(ok).toBe(endpoints.length);
  });
});
