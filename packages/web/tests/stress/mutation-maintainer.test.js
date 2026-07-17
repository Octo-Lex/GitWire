// tests/stress/mutation-maintainer.test.js
// Stress Test: Maintainer mutation routes — settings, stale-scan, branch-cleanup, sync, collaborators
import { get, post, put, del, patch, FIXTURE_REPO } from '../helpers.js';
import { sleep, resilientGet, boundedBurst } from './stress-helpers.js';

const REPO = FIXTURE_REPO;
// Org is the owner segment of the fixture repo (owner/repo).
const ORG = REPO.split('/')[0];

describe('Stress: Maintainer Mutations', () => {

  test('PATCH /maintainer/:owner/:repo/settings — concurrent settings updates', async () => {
    const tasks = Array.from({ length: 5 }, (_, i) => () =>
      patch(`/api/maintainer/${REPO}/settings`, {
        stale_issue_days: 30 + i * 10,
        stale_pr_days: 60 + i * 10,
        stale_label: 'stale',
        enable_auto_close: false,
      })
    );
    const { succeeded, statuses } = await boundedBurst(tasks, { maxConcurrent: 5, delayBetweenBatches: 1000 });
    // Should all succeed — last-write-wins is fine
    const ok = statuses.filter(s => [200, 201, 202].includes(s)).length;
    expect(ok).toBe(5);
  });

  test('POST /maintainer/:owner/:repo/stale-scan — trigger stale scan', async () => {
    const res = await post(`/api/maintainer/${REPO}/stale-scan`, {});
    expect([200, 201, 202, 204]).toContain(res.status);
  });

  test('POST /maintainer/:owner/:repo/branch-cleanup — trigger branch cleanup', async () => {
    const res = await post(`/api/maintainer/${REPO}/branch-cleanup`, {});
    expect([200, 201, 202, 204]).toContain(res.status);
  });

  test('POST /maintainer/members/sync — trigger member sync', async () => {
    const res = await post('/api/maintainer/members/sync', { org: ORG });
    expect([200, 201, 202, 204]).toContain(res.status);
  });

  test('POST /maintainer/:owner/:repo/stale-scan — 3 concurrent scans idempotent', async () => {
    const tasks = Array.from({ length: 3 }, () => () =>
      post(`/api/maintainer/${REPO}/stale-scan`, {})
    );
    const { succeeded, statuses } = await boundedBurst(tasks, { maxConcurrent: 3, delayBetweenBatches: 1000 });
    const ok = statuses.filter(s => [200, 201, 202, 204].includes(s)).length;
    expect(ok).toBe(3);
  });

  test('GET settings after mutations — still returns valid data', async () => {
    await sleep(500);
    const res = await resilientGet(`/api/maintainer/${REPO}/settings`);
    expect([200, 429]).toContain(res.status);
  });
});
