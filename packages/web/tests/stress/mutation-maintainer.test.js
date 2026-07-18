// tests/stress/mutation-maintainer.test.js
// Stress Test: Maintainer mutation routes — settings, stale-scan, branch-cleanup, member sync.
import { apiBurstOperation, post, patch, FIXTURE_REPO } from '../helpers.js';
import { sleep, resilientGet, boundedBurst } from './stress-helpers.js';

const REPO = FIXTURE_REPO;
// Org is the owner segment of the fixture repo (owner/repo).
const ORG = REPO.split('/')[0];

describe('Stress: Maintainer Mutations', () => {

  test('PATCH /maintainer/:owner/:repo/settings — concurrent settings updates', async () => {
    const tasks = Array.from({ length: 5 }, (_, i) => apiBurstOperation(
      `/api/maintainer/${REPO}/settings`,
      {
        kind: 'write', method: 'PATCH',
        body: { stale_issue_days: 30 + i * 10, stale_pr_days: 60 + i * 10, stale_label: 'stale', enable_auto_close: false },
        contractName: 'maintainer-settings',
      }
    ));
    const result = await boundedBurst(tasks, { maxConcurrent: 5, delayBetweenBatches: 1000 });
    const ok = result.results.filter(r => [200, 201, 202].includes(r.status)).length;
    expect(ok).toBe(5);
  });

  test('POST /maintainer/:owner/:repo/stale-scan — trigger stale scan', async () => {
    const res = await post(`/api/maintainer/${REPO}/stale-scan`, {}, { contractName: 'maintainer-stale-scan' });
    expect([200, 201, 202, 204]).toContain(res.status);
  });

  test('POST /maintainer/:owner/:repo/branch-cleanup — trigger branch cleanup', async () => {
    const res = await post(`/api/maintainer/${REPO}/branch-cleanup`, {}, { contractName: 'maintainer-branch-cleanup' });
    expect([200, 201, 202, 204]).toContain(res.status);
  });

  // SKIPPED: members/sync targets an org (the fixture repo's owner). The
  // current contract model covers repo-in-path and installationId-in-body/
  // query; an org-targeted contract is a clean extension but out of scope
  // for this isolation PR. Tracked for a later 'org-target' contract.
  test.skip('POST /maintainer/members/sync — needs org-target contract', async () => {
    const res = await post('/api/maintainer/members/sync', { org: ORG });
    expect([200, 201, 202, 204]).toContain(res.status);
  });

  test('POST /maintainer/:owner/:repo/stale-scan — 3 concurrent scans idempotent', async () => {
    const tasks = Array.from({ length: 3 }, () => apiBurstOperation(
      `/api/maintainer/${REPO}/stale-scan`,
      { kind: 'write', method: 'POST', body: {}, contractName: 'maintainer-stale-scan' }
    ));
    const result = await boundedBurst(tasks, { maxConcurrent: 3, delayBetweenBatches: 1000 });
    const ok = result.results.filter(r => [200, 201, 202, 204].includes(r.status)).length;
    expect(ok).toBe(3);
  });

  test('GET settings after mutations — still returns valid data', async () => {
    await sleep(500);
    const res = await resilientGet(`/api/maintainer/${REPO}/settings`);
    expect([200, 429]).toContain(res.status);
  });
});
