// tests/stress/mutation-enforcement.test.js
// Stress Test: Enforcement mutation routes — concurrent policy CRUD, run triggers
import { get, post, put, del, API_KEY, BASE_URL } from '../helpers.js';
import { sleep, resilientGet, boundedBurst } from './stress-helpers.js';

const POLICY_BASE = '/api/enforcement/policies';

// Unique suffix per run to avoid collisions
const uid = Date.now().toString(36);

describe('Stress: Enforcement Mutations', () => {

  test('POST /enforcement/policies — create 5 policies concurrently', async () => {
    const tasks = Array.from({ length: 5 }, (_, i) => () =>
      post(POLICY_BASE, {
        name: `stress-${uid}-${i}`,
        branch_pattern: 'main',
        min_reviews: 1 + i,
        require_linear_history: false,
        block_force_pushes: false,
        block_deletions: false,
        enforce_admins: false,
        repo_filter: null,
      })
    );
    const { succeeded, statuses } = await boundedBurst(tasks, { maxConcurrent: 5, delayBetweenBatches: 1000 });
    // All should succeed (200) or fail gracefully (400/409)
    const ok = statuses.filter(s => [200, 201, 400, 409].includes(s)).length;
    expect(ok).toBe(5);
  });

  test('POST /enforcement/run — trigger 3 concurrent enforcement runs', async () => {
    const tasks = Array.from({ length: 3 }, () => () =>
      post('/api/enforcement/run', { installation_id: 133349719 })
    );
    const { succeeded, statuses } = await boundedBurst(tasks, { maxConcurrent: 3, delayBetweenBatches: 1000 });
    const ok = statuses.filter(s => [200, 201, 202].includes(s)).length;
    expect(ok).toBe(3);
  });

  test('DELETE /enforcement/policies/:id — delete non-existent policy returns gracefully', async () => {
    const res = await del(`${POLICY_BASE}/999999`);
    expect([200, 202, 404]).toContain(res.status);
  });

  test('POST /enforcement/policies — invalid payload returns 400 not 500', async () => {
    const res = await post(POLICY_BASE, { garbage: true });
    expect(res.status).toBe(400);
  });

  test('GET after mutations — enforcement stats still valid', async () => {
    await sleep(500);
    const res = await resilientGet('/api/enforcement/stats');
    expect([200, 429]).toContain(res.status);
  });
});
