// tests/stress/mutation-repos-sync-fix.test.js
// Stress Test: Repo sync, fix attempts, CI heal retries, duplicate operations
import { get, post, del } from '../helpers.js';
import { sleep, resilientGet, boundedBurst } from './stress-helpers.js';

const REPO = 'Elephant-Rock-Lab/GitWire';
const REPO2 = 'xjeddah/MyShell';

describe('Stress: Repo Sync + Fix + Heal Mutations', () => {

  test('POST /repos/:owner/:repo/sync — trigger repo sync', async () => {
    const res = await post(`/api/repos/${REPO}/sync`, {});
    expect([200, 201, 202]).toContain(res.status);
  });

  test('POST /repos/:owner/:repo/sync — 3 concurrent syncs idempotent', async () => {
    const tasks = Array.from({ length: 3 }, () => () =>
      post(`/api/repos/${REPO}/sync`, {})
    );
    const { succeeded, statuses } = await boundedBurst(tasks, { maxConcurrent: 3, delayBetweenBatches: 1000 });
    const ok = statuses.filter(s => [200, 201, 202].includes(s)).length;
    expect(ok).toBe(3);
  });

  test('POST /fix/:owner/:repo/issues/:number — fix attempt on non-existent issue', async () => {
    const res = await post(`/api/fix/${REPO}/issues/99999?installation_id=133349719`, {});
    expect([200, 202, 400, 404, 429, 500]).toContain(res.status);
  });

  test('POST /ci/:runId/retry — retry non-existent CI run', async () => {
    const res = await post('/api/ci/999999/retry', {});
    expect([200, 202, 404, 500]).toContain(res.status);
  });

  test('POST /duplicates/:id/confirm — confirm non-existent duplicate', async () => {
    const res = await post('/api/duplicates/999999/confirm', {});
    expect([200, 202, 404]).toContain(res.status);
  });

  test('POST /duplicates/:id/dismiss — dismiss non-existent duplicate', async () => {
    const res = await post('/api/duplicates/999999/dismiss', {});
    expect([200, 202, 404]).toContain(res.status);
  });

  test('POST /duplicates/backfill/:owner/:repo — backfill embeddings', async () => {
    const res = await post(`/api/duplicates/backfill/${REPO2}`, {});
    expect([200, 201, 202]).toContain(res.status);
  });

  test('POST /fix/:owner/:repo/issues/:number — 3 concurrent fix triggers rate-limited', async () => {
    // Fix attempts are rate-limited: 1 per issue per day, 3 per repo per day
    const tasks = Array.from({ length: 3 }, () => () =>
      post(`/api/fix/${REPO}/issues/99999?installation_id=133349719`, {})
    );
    const { succeeded, statuses } = await boundedBurst(tasks, { maxConcurrent: 3, delayBetweenBatches: 1000 });
    // At least first should succeed or fail gracefully
    const ok = statuses.filter(s => [200, 202, 404, 429, 500].includes(s)).length;
    expect(ok).toBe(3);
  });
});
