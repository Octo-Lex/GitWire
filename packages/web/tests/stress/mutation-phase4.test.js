// tests/stress/mutation-phase4.test.js
// Stress Test: Phase 4 mutation routes — AI review config.
//
// Audit report/export routes (POST /api/audit/*) are removed: they generate
// reports without targeting a fixture identity and don't fit the fail-closed
// fixture contract. Review-trigger on a guessed PR number is also removed
// (the PR is not a fixture-owned record). Belongs in a later PR.
import { apiBurstOperation, post, FIXTURE_REPO } from '../helpers.js';
import { boundedBurst } from './stress-helpers.js';

const REPO = FIXTURE_REPO;

describe('Stress: Phase 4 Mutations', () => {

  test('POST /review/config/:owner/:repo — set AI review config', async () => {
    const res = await post(
      `/api/review/config/${REPO}`,
      { enabled: true, review_mode: 'comment', max_files: 20, repo_filter: null },
      { contractName: 'review-config' }
    );
    expect([200, 201, 202]).toContain(res.status);
  });

  test('POST /review/config/:owner/:repo — concurrent config updates', async () => {
    const tasks = Array.from({ length: 5 }, (_, i) => apiBurstOperation(
      `/api/review/config/${REPO}`,
      {
        kind: 'write', method: 'POST',
        body: { enabled: true, review_mode: i % 2 === 0 ? 'comment' : 'check_run', max_files: 10 + i * 5, repo_filter: null },
        contractName: 'review-config',
      }
    ));
    const result = await boundedBurst(tasks, { maxConcurrent: 5, delayBetweenBatches: 1000 });
    const ok = result.results.filter(r => [200, 201, 202].includes(r.status)).length;
    expect(ok).toBe(5);
  });
});
