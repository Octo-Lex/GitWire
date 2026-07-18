// tests/stress/api-flood.test.js
// Stress Test: API Flood — high-concurrency reads across all endpoints.
//
// Run: NODE_OPTIONS="--experimental-vm-modules" npx jest tests/stress/api-flood.test.js --testTimeout=120000 --runInBand

import { apiContractedOperation, STATUS_SETS } from './response-contracts.js';
import { runContractedBurst, runContractedOperation } from './burst-runner.js';
import { sleep } from './stress-helpers.js';

const CONCURRENT = 8;
const ROUNDS = 3;

describe(`API Flood: ${CONCURRENT} concurrent × ${ROUNDS} rounds`, () => {
  beforeEach(async () => {
    await sleep(1000); // Ensure rate limit window is fresh
  });

  test('GET /api/repos survives flood', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const tasks = Array.from({ length: CONCURRENT }, () =>
        apiContractedOperation('/api/repos', {
          kind: 'read', method: 'GET', bodyMode: 'auto',
          expectedStatuses: STATUS_SETS.READ_OK_OR_RATE_LIMITED,
        })
      );
      const result = await runContractedBurst(tasks, {
        concurrency: CONCURRENT, pacing: { mode: 'none' },
      });
      console.log(`  Round ${round + 1}: ${result.httpExpected}/${result.attempted} expected in ${result.elapsedMs}ms`);
      expect(result.httpNotReceived).toBe(0);
      expect(result.httpExpected).toBe(result.attempted);
      expect(result.httpUnexpected).toBe(0);
      await sleep(500);
    }
  });

  test('GET /api/issues survives flood', async () => {
    const tasks = Array.from({ length: CONCURRENT }, () =>
      apiContractedOperation('/api/issues', {
        kind: 'read', method: 'GET', bodyMode: 'auto',
        expectedStatuses: STATUS_SETS.READ_OK_OR_RATE_LIMITED,
      })
    );
    const result = await runContractedBurst(tasks, {
      concurrency: 8, pacing: { mode: 'none' },
    });
    console.log(`  Issues: ${result.httpExpected}/${result.attempted} expected in ${result.elapsedMs}ms`);
    expect(result.httpNotReceived).toBe(0);
    expect(result.httpExpected).toBe(result.attempted);
  });

  test('GET /api/ci/stats survives flood', async () => {
    const tasks = Array.from({ length: CONCURRENT }, () =>
      apiContractedOperation('/api/ci/stats', {
        kind: 'read', method: 'GET', bodyMode: 'auto',
        expectedStatuses: STATUS_SETS.READ_OK_OR_RATE_LIMITED,
      })
    );
    const result = await runContractedBurst(tasks, {
      concurrency: 8, pacing: { mode: 'none' },
    });
    console.log(`  CI stats: ${result.httpExpected}/${result.attempted} expected in ${result.elapsedMs}ms`);
    expect(result.httpNotReceived).toBe(0);
    expect(result.httpExpected).toBe(result.attempted);
  });

  test('GET /api/insights/overview survives flood', async () => {
    const tasks = Array.from({ length: CONCURRENT }, () =>
      apiContractedOperation('/api/insights/overview', {
        kind: 'read', method: 'GET', bodyMode: 'auto',
        expectedStatuses: STATUS_SETS.READ_OK_OR_RATE_LIMITED,
      })
    );
    const result = await runContractedBurst(tasks, {
      concurrency: 8, pacing: { mode: 'none' },
    });
    console.log(`  Insights: ${result.httpExpected}/${result.attempted} expected in ${result.elapsedMs}ms`);
    expect(result.httpNotReceived).toBe(0);
    expect(result.httpExpected).toBe(result.attempted);
  });

  test('GET /health survives flood (no auth required)', async () => {
    // omitAuth:true suppresses the bearer token entirely. Strict READ_OK
    // contract — health must return exactly 200.
    const tasks = Array.from({ length: CONCURRENT }, () =>
      apiContractedOperation('/health', {
        kind: 'health', method: 'GET', bodyMode: 'none', omitAuth: true,
        expectedStatuses: STATUS_SETS.READ_OK,
      })
    );
    const result = await runContractedBurst(tasks, {
      concurrency: 8, pacing: { mode: 'none' },
    });
    console.log(`  Health: ${result.httpExpected}/${result.attempted} expected in ${result.elapsedMs}ms`);
    expect(result.httpExpected).toBe(result.attempted);
    expect(result.httpUnexpected).toBe(0);
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
    // Sequential to avoid rate limits — each uses runContractedOperation.
    let ok = 0;
    for (const ep of endpoints) {
      const result = await runContractedOperation(
        apiContractedOperation(ep, {
          kind: 'read', method: 'GET', bodyMode: 'auto',
          expectedStatuses: STATUS_SETS.READ_OK,
        })
      );
      if (result.http === 'expected') ok++;
    }
    console.log(`  Mixed ${endpoints.length} endpoints: ${ok}/${endpoints.length} OK`);
    expect(ok).toBe(endpoints.length);
  });
});
