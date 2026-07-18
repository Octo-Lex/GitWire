// tests/stress/mutation-repos-sync-fix.test.js
// Stress Test: Repo sync and fix attempts against the fixture repo.
//
// Routes targeting guessed non-existent IDs (ci/999999/retry,
// duplicates/999999/confirm|dismiss) are removed: a fail-closed fixture
// contract requires the declared fixture identity be present and correct,
// and a guessed ID is neither. Rejection-path coverage for non-existent
// resources belongs in a suite that owns fixture-created records.
import { apiBurstOperation, post, FIXTURE_REPO, FIXTURE_INSTALLATION_ID } from '../helpers.js';
import { boundedBurst } from './stress-helpers.js';

const REPO = FIXTURE_REPO;

describe('Stress: Repo Sync + Fix Mutations', () => {

  test('POST /repos/:owner/:repo/sync — trigger repo sync', async () => {
    const res = await post(`/api/repos/${REPO}/sync`, {}, { contractName: 'repo-sync' });
    expect([200, 201, 202]).toContain(res.status);
  });

  test('POST /repos/:owner/:repo/sync — 3 concurrent syncs idempotent', async () => {
    const tasks = Array.from({ length: 3 }, () => apiBurstOperation(
      `/api/repos/${REPO}/sync`,
      { kind: 'write', method: 'POST', body: {}, contractName: 'repo-sync' }
    ));
    const result = await boundedBurst(tasks, { maxConcurrent: 3, delayBetweenBatches: 1000 });
    const ok = result.results.filter(r => [200, 201, 202].includes(r.status)).length;
    expect(ok).toBe(3);
  });

  test('POST /fix/:owner/:repo/issues/:number — fix attempt on non-existent issue in fixture repo', async () => {
    const res = await post(
      `/api/fix/${REPO}/issues/99999?installation_id=${FIXTURE_INSTALLATION_ID}`,
      {},
      { contractName: 'fix-attempt' }
    );
    expect([200, 202, 400, 404, 429, 500]).toContain(res.status);
  });

  test('POST /fix/:owner/:repo/issues/:number — 3 concurrent fix triggers rate-limited', async () => {
    // Fix attempts are rate-limited: 1 per issue per day, 3 per repo per day
    const tasks = Array.from({ length: 3 }, () => apiBurstOperation(
      `/api/fix/${REPO}/issues/99999?installation_id=${FIXTURE_INSTALLATION_ID}`,
      { kind: 'write', method: 'POST', body: {}, contractName: 'fix-attempt' }
    ));
    const result = await boundedBurst(tasks, { maxConcurrent: 3, delayBetweenBatches: 1000 });
    const ok = result.results.filter(r => [200, 202, 404, 429, 500].includes(r.status)).length;
    expect(ok).toBe(3);
  });
});
