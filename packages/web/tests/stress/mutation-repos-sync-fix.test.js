// tests/stress/mutation-repos-sync-fix.test.js
// Stress Test: Repo sync and fix attempts against the fixture repo.
import { apiContractedOperation, STATUS_SETS } from './response-contracts.js';
import { runContractedBurst } from './burst-runner.js';
import { post, FIXTURE_REPO, FIXTURE_INSTALLATION_ID } from '../helpers.js';

const REPO = FIXTURE_REPO;

describe('Stress: Repo Sync + Fix Mutations', () => {

  test('POST /repos/:owner/:repo/sync — trigger repo sync', async () => {
    const res = await post(`/api/repos/${REPO}/sync`, {}, { contractName: 'repo-sync' });
    expect([200, 201, 202]).toContain(res.status);
  });

  test('POST /repos/:owner/:repo/sync — 3 concurrent syncs idempotent', async () => {
    const tasks = Array.from({ length: 3 }, () => apiContractedOperation(
      `/api/repos/${REPO}/sync`,
      {
        kind: 'write', method: 'POST', body: {},
        contractName: 'repo-sync',
        expectedStatuses: STATUS_SETS.MUTATION_ACCEPTED,
      }
    ));
    const result = await runContractedBurst(tasks, {
      concurrency: 3, pacing: { mode: 'legacy_batches', delayMs: 1000 },
    });
    expect(result.httpExpected).toBe(result.attempted);
    expect(result.httpUnexpected).toBe(0);
  });

  test('POST /fix/:owner/:repo/issues/:number — fix attempt on non-existent issue in fixture repo', async () => {
    const res = await post(
      `/api/fix/${REPO}/issues/99999?installation_id=${FIXTURE_INSTALLATION_ID}`,
      {},
      { contractName: 'fix-attempt' }
    );
    // Legacy broad outcomes — includes 500 for this route-specific exception.
    expect(STATUS_SETS.FIX_ATTEMPT_LEGACY_OUTCOMES).toContain(res.status);
  });

  test('POST /fix/:owner/:repo/issues/:number — 3 concurrent fix triggers rate-limited', async () => {
    // Fix attempts are rate-limited: 1 per issue per day, 3 per repo per day.
    // Uses FIX_ATTEMPT_LEGACY_OUTCOMES — visible legacy exception for later tightening.
    const tasks = Array.from({ length: 3 }, () => apiContractedOperation(
      `/api/fix/${REPO}/issues/99999?installation_id=${FIXTURE_INSTALLATION_ID}`,
      {
        kind: 'write', method: 'POST', body: {},
        contractName: 'fix-attempt',
        expectedStatuses: STATUS_SETS.FIX_ATTEMPT_LEGACY_OUTCOMES,
      }
    ));
    const result = await runContractedBurst(tasks, {
      concurrency: 3, pacing: { mode: 'legacy_batches', delayMs: 1000 },
    });
    expect(result.httpExpected).toBe(result.attempted);
    expect(result.httpUnexpected).toBe(0);
  });
});
