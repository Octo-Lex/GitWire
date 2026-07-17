// tests/stress/mutation-phase2.test.js
// Stress Test: Phase 2 mutation routes — merge queue config, feedback rules, queue operations
import { get, post, put, del, FIXTURE_REPO } from '../helpers.js';
import { sleep, resilientGet, boundedBurst } from './stress-helpers.js';

const REPO = FIXTURE_REPO;
const uid = Date.now().toString(36);

describe('Stress: Phase 2 Mutations', () => {

  test('POST /phase2/queue/:owner/:repo/config — set merge queue config', async () => {
    const res = await post(`/api/phase2/queue/${REPO}/config`, {
      enabled: true,
      merge_method: 'squash',
      max_queue_depth: 5,
      required_checks: [],
    });
    expect([200, 201, 202]).toContain(res.status);
  });

  test('POST /phase2/queue/:owner/:repo/config — concurrent config updates', async () => {
    const tasks = Array.from({ length: 5 }, (_, i) => () =>
      post(`/api/phase2/queue/${REPO}/config`, {
        enabled: true,
        merge_method: i % 2 === 0 ? 'squash' : 'merge',
        max_queue_depth: 3 + i,
        required_checks: [],
      })
    );
    const { succeeded, statuses } = await boundedBurst(tasks, { maxConcurrent: 5, delayBetweenBatches: 1000 });
    const ok = statuses.filter(s => [200, 201, 202].includes(s)).length;
    expect(ok).toBe(5);
  });

  test('POST /phase2/feedback — create feedback rule', async () => {
    const res = await post('/api/phase2/feedback', {
      event_type: 'ci_failure',
      post_pr_comment: true,
      slack_webhook: null,
      teams_webhook: null,
      repo_filter: null,
    });
    expect([200, 201, 400, 409]).toContain(res.status);
  });

  test('POST /phase2/feedback — create 5 feedback rules concurrently', async () => {
    const tasks = Array.from({ length: 5 }, (_, i) => () =>
      post('/api/phase2/feedback', {
        event_type: `stress-event-${uid}-${i}`,
        post_pr_comment: true,
        slack_webhook: null,
        teams_webhook: null,
        repo_filter: null,
      })
    );
    const { succeeded, statuses } = await boundedBurst(tasks, { maxConcurrent: 5, delayBetweenBatches: 1000 });
    const ok = statuses.filter(s => [200, 201, 400, 409].includes(s)).length;
    expect(ok).toBe(5);
  });

  test('DELETE /phase2/feedback/:id — delete non-existent rule gracefully', async () => {
    const res = await del('/api/phase2/feedback/999999');
    expect([200, 202, 404]).toContain(res.status);
  });

  test('GET /phase2/telemetry/summary — still valid after mutations', async () => {
    await sleep(500);
    const res = await resilientGet('/api/phase2/telemetry/summary');
    expect([200, 429]).toContain(res.status);
  });
});
