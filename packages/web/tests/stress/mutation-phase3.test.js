// tests/stress/mutation-phase3.test.js
// Stress Test: Phase 3 mutation routes — reconciler, dependency scanning.
//
// Only fixture-targeted mutations are exercised. Routes that previously
// targeted guessed non-existent IDs (flaky/999999/graduate, vuln/999999/dismiss)
// are removed: a fail-closed fixture contract requires the declared fixture
// identity be present and correct, and a guessed ID is neither. Rejection-path
// coverage for non-existent resources is a separate concern and belongs in a
// suite that owns fixture-created records.
import { post, put, FIXTURE_REPO, FIXTURE_INSTALLATION_ID } from '../helpers.js';
import { boundedBurst } from './stress-helpers.js';

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
    const tasks = Array.from({ length: 3 }, () => () =>
      post(
        '/api/phase3/reconciler/run',
        { installation_id: FIXTURE_INSTALLATION_ID },
        { contractName: 'phase3-reconciler-run' }
      )
    );
    const { succeeded, statuses } = await boundedBurst(tasks, { maxConcurrent: 3, delayBetweenBatches: 1000 });
    const ok = statuses.filter(s => [200, 201, 202].includes(s)).length;
    expect(ok).toBe(3);
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
