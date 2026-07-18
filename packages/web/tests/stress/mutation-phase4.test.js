// tests/stress/mutation-phase4.test.js
// Stress Test: Phase 4 mutation routes — AI review config.
import { apiContractedOperation, STATUS_SETS } from './response-contracts.js';
import { runContractedBurst, runContractedOperation } from './burst-runner.js';
import { FIXTURE_REPO } from '../helpers.js';

const REPO = FIXTURE_REPO;

describe('Stress: Phase 4 Mutations', () => {

  test('POST /review/config/:owner/:repo — set AI review config', async () => {
    const result = await runContractedOperation(
      apiContractedOperation(`/api/review/config/${REPO}`, {
        kind: 'write', method: 'POST',
        body: { enabled: true, review_mode: 'comment', max_files: 20, repo_filter: null },
        contractName: 'review-config',
        expectedStatuses: STATUS_SETS.MUTATION_ACCEPTED,
      })
    );
    expect(result.http).toBe('expected');
  });

  test('POST /review/config/:owner/:repo — concurrent config updates', async () => {
    const tasks = Array.from({ length: 5 }, (_, i) => apiContractedOperation(
      `/api/review/config/${REPO}`,
      {
        kind: 'write', method: 'POST',
        body: { enabled: true, review_mode: i % 2 === 0 ? 'comment' : 'check_run', max_files: 10 + i * 5, repo_filter: null },
        contractName: 'review-config',
        expectedStatuses: STATUS_SETS.MUTATION_ACCEPTED,
      }
    ));
    const result = await runContractedBurst(tasks, {
      concurrency: 5, pacing: { mode: 'legacy_batches', delayMs: 1000 },
    });
    expect(result.httpExpected).toBe(result.attempted);
    expect(result.httpUnexpected).toBe(0);
  });
});
