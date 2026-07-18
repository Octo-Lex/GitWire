// tests/stress/mutation-phase3.test.js
// Stress Test: Phase 3 mutation routes — reconciler, dependency scanning.
import { apiContractedOperation, STATUS_SETS } from './response-contracts.js';
import { runContractedBurst, runContractedOperation } from './burst-runner.js';
import { FIXTURE_REPO, FIXTURE_INSTALLATION_ID } from '../helpers.js';

const REPO = FIXTURE_REPO;

describe('Stress: Phase 3 Mutations', () => {

  test('POST /phase3/reconciler/run — trigger reconciliation', async () => {
    const result = await runContractedOperation(
      apiContractedOperation('/api/phase3/reconciler/run', {
        kind: 'write', method: 'POST',
        body: { installation_id: FIXTURE_INSTALLATION_ID },
        contractName: 'phase3-reconciler-run',
        expectedStatuses: STATUS_SETS.MUTATION_ACCEPTED,
      })
    );
    expect(result.http).toBe('expected');
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
    const result = await runContractedOperation(
      apiContractedOperation(`/api/phase3/reconciler/repos/${REPO}`, {
        kind: 'write', method: 'PUT',
        body: { reconcile_skip: false },
        contractName: 'phase3-reconciler-repos-config',
        expectedStatuses: STATUS_SETS.MUTATION_ACCEPTED_OR_NOT_FOUND,
      })
    );
    expect(result.http).toBe('expected');
  });

  test('POST /phase3/dependencies/:owner/:repo/scan — trigger dep scan', async () => {
    const result = await runContractedOperation(
      apiContractedOperation(`/api/phase3/dependencies/${REPO}/scan`, {
        kind: 'write', method: 'POST', body: {},
        contractName: 'phase3-dependencies-scan',
        expectedStatuses: STATUS_SETS.MUTATION_ACCEPTED,
      })
    );
    expect(result.http).toBe('expected');
  });

  test('POST /phase3/dependencies/:owner/:repo/batch-pr — batch update PR', async () => {
    const result = await runContractedOperation(
      apiContractedOperation(`/api/phase3/dependencies/${REPO}/batch-pr`, {
        kind: 'write', method: 'POST',
        body: { ecosystem: 'npm', deps: ['express'] },
        contractName: 'phase3-dependencies-batch-pr',
        expectedStatuses: STATUS_SETS.MUTATION_ACCEPTED_OR_BAD_REQUEST_OR_NOT_FOUND,
      })
    );
    expect(result.http).toBe('expected');
  });
});
