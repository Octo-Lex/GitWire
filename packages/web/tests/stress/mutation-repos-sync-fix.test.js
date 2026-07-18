// tests/stress/mutation-repos-sync-fix.test.js
// Stress Test: Repo sync and fix attempts against the fixture repo.
import { apiContractedOperation, STATUS_SETS } from './response-contracts.js';
import { runContractedBurst, runContractedOperation } from './burst-runner.js';
import { FIXTURE_REPO, FIXTURE_INSTALLATION_ID } from '../helpers.js';

const REPO = FIXTURE_REPO;

describe('Stress: Repo Sync + Fix Mutations', () => {

  test('POST /repos/:owner/:repo/sync — trigger repo sync', async () => {
    const result = await runContractedOperation(
      apiContractedOperation(`/api/repos/${REPO}/sync`, {
        kind: 'write', method: 'POST', body: {},
        contractName: 'repo-sync',
        expectedStatuses: STATUS_SETS.MUTATION_ACCEPTED,
      })
    );
    expect(result.http).toBe('expected');
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
    const result = await runContractedOperation(
      apiContractedOperation(
        `/api/fix/${REPO}/issues/99999?installation_id=${FIXTURE_INSTALLATION_ID}`,
        {
          kind: 'write', method: 'POST', body: {},
          contractName: 'fix-attempt',
          expectedStatuses: STATUS_SETS.FIX_ATTEMPT_LEGACY_OUTCOMES,
        }
      )
    );
    expect(result.http).toBe('expected');
  });

  test('POST /fix/:owner/:repo/issues/:number — 3 concurrent fix triggers rate-limited', async () => {
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
