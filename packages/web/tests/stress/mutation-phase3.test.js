// tests/stress/mutation-phase3.test.js
// Stress Test: Phase 3 mutation routes — reconciler, dependency scanning.
import { apiContractedOperation, STATUS_SETS } from './response-contracts.js';
import { runContractedBurst } from './burst-runner.js';
import { post, put, FIXTURE_REPO, FIXTURE_INSTALLATION_ID } from '../helpers.js';

const REPO = FIXTURE_REPO;

describe('Stress: Phase 3 Mutations', () => {

  test('POST /phase3/reconciler/run — trigger reconciliation', async () => {
    const res = await post(
      '/api/phase3/reconciler/run',
      { installation_id: FIXTURE_INSTALLATION_ID },
      { contractName: 'phase3-reconciler-run' }
    );
    expect([200, 201, 202]).toContain(res.status);
  });

  test('POST /phase3/reconciler/run — 3 concurrent runs idempotent', async () => {
    const tasks = Array.from({ length: 3 }, () => apiContractedOperation(
      '/api/phase3/reconciler/run',
      {
        kind: 'write', method: 'POST',
        body: { installation_id: FIXTURE_INSTALLATION_ID },
        contractName: 'phase3-reconciler-run',
        expectedStatuses: STATUS_SETS.MUTATION_ACCEPTED,
      }
    ));
    const result = await runContractedBurst(tasks, {
      concurrency: 3, pacing: { mode: 'legacy_batches', delayMs: 1000 },
    });
    expect(result.httpExpected).toBe(result.attempted);
    expect(result.httpUnexpected).toBe(0);
  });

  test('PUT /phase3/reconciler/repos/:owner/:repo — update reconciler config', async () => {
    const res = await put(
      `/api/phase3/reconciler/repos/${REPO}`,
      { reconcile_skip: false },
      { contractName: 'phase3-reconciler-repos-config' }
    );
    expect([200, 201, 202, 404]).toContain(res.status);
  });

  test('POST /phase3/dependencies/:owner/:repo/scan — trigger dep scan', async () => {
    const res = await post(
      `/api/phase3/dependencies/${REPO}/scan`,
      {},
      { contractName: 'phase3-dependencies-scan' }
    );
    expect([200, 201, 202]).toContain(res.status);
  });

  test('POST /phase3/dependencies/:owner/:repo/batch-pr — batch update PR', async () => {
    const res = await post(
      `/api/phase3/dependencies/${REPO}/batch-pr`,
      { ecosystem: 'npm', deps: ['express'] },
      { contractName: 'phase3-dependencies-batch-pr' }
    );
    expect([200, 201, 202, 400, 404]).toContain(res.status);
  });
});
