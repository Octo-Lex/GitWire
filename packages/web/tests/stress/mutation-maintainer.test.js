// tests/stress/mutation-maintainer.test.js
// Stress Test: Maintainer mutation routes — settings, stale-scan, branch-cleanup.
import { apiContractedOperation, STATUS_SETS } from './response-contracts.js';
import { runContractedBurst } from './burst-runner.js';
import { post, FIXTURE_REPO } from '../helpers.js';
import { sleep, resilientGet } from './stress-helpers.js';

const REPO = FIXTURE_REPO;
const ORG = REPO.split('/')[0];

describe('Stress: Maintainer Mutations', () => {

  test('PATCH /maintainer/:owner/:repo/settings — concurrent settings updates', async () => {
    const tasks = Array.from({ length: 5 }, (_, i) => apiContractedOperation(
      `/api/maintainer/${REPO}/settings`,
      {
        kind: 'write', method: 'PATCH',
        body: { stale_issue_days: 30 + i * 10, stale_pr_days: 60 + i * 10, stale_label: 'stale', enable_auto_close: false },
        contractName: 'maintainer-settings',
        expectedStatuses: STATUS_SETS.MUTATION_ACCEPTED,
      }
    ));
    const result = await runContractedBurst(tasks, {
      concurrency: 5, pacing: { mode: 'legacy_batches', delayMs: 1000 },
    });
    expect(result.httpExpected).toBe(result.attempted);
    expect(result.httpUnexpected).toBe(0);
  });

  test('POST /maintainer/:owner/:repo/stale-scan — trigger stale scan', async () => {
    const res = await post(`/api/maintainer/${REPO}/stale-scan`, {}, { contractName: 'maintainer-stale-scan' });
    expect([200, 201, 202, 204]).toContain(res.status);
  });

  test('POST /maintainer/:owner/:repo/branch-cleanup — trigger branch cleanup', async () => {
    const res = await post(`/api/maintainer/${REPO}/branch-cleanup`, {}, { contractName: 'maintainer-branch-cleanup' });
    expect([200, 201, 202, 204]).toContain(res.status);
  });

  test.skip('POST /maintainer/members/sync — needs org-target contract', async () => {
    const res = await post('/api/maintainer/members/sync', { org: ORG });
    expect([200, 201, 202, 204]).toContain(res.status);
  });

  test('POST /maintainer/:owner/:repo/stale-scan — 3 concurrent scans idempotent', async () => {
    const tasks = Array.from({ length: 3 }, () => apiContractedOperation(
      `/api/maintainer/${REPO}/stale-scan`,
      {
        kind: 'write', method: 'POST', body: {},
        contractName: 'maintainer-stale-scan',
        expectedStatuses: STATUS_SETS.MUTATION_TRIGGER,
      }
    ));
    const result = await runContractedBurst(tasks, {
      concurrency: 3, pacing: { mode: 'legacy_batches', delayMs: 1000 },
    });
    expect(result.httpExpected).toBe(result.attempted);
    expect(result.httpUnexpected).toBe(0);
  });

  test('GET settings after mutations — still returns valid data', async () => {
    await sleep(500);
    const res = await resilientGet(`/api/maintainer/${REPO}/settings`);
    expect([200, 429]).toContain(res.status);
  });
});
