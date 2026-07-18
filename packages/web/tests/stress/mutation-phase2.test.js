// tests/stress/mutation-phase2.test.js
// Stress Test: Phase 2 mutation routes — merge queue config.
//
// Feedback-rule CRUD-creation routes (POST /api/phase2/feedback) are removed:
// they create new resources without a fixture identity and don't fit the
// fail-closed fixture contract. Belongs in a later FIXTURE_RESOURCE_CREATE PR.
import { apiBurstOperation, post, FIXTURE_REPO } from '../helpers.js';
import { sleep, resilientGet, boundedBurst } from './stress-helpers.js';

const REPO = FIXTURE_REPO;

describe('Stress: Phase 2 Mutations', () => {

  test('POST /phase2/queue/:owner/:repo/config — set merge queue config', async () => {
    const res = await post(
      `/api/phase2/queue/${REPO}/config`,
      { enabled: true, merge_method: 'squash', max_queue_depth: 5, required_checks: [] },
      { contractName: 'phase2-queue-config' }
    );
    expect([200, 201, 202]).toContain(res.status);
  });

  test('POST /phase2/queue/:owner/:repo/config — concurrent config updates', async () => {
    const tasks = Array.from({ length: 5 }, (_, i) => apiBurstOperation(
      `/api/phase2/queue/${REPO}/config`,
      {
        kind: 'write', method: 'POST',
        body: { enabled: true, merge_method: i % 2 === 0 ? 'squash' : 'merge', max_queue_depth: 3 + i, required_checks: [] },
        contractName: 'phase2-queue-config',
      }
    ));
    const result = await boundedBurst(tasks, { maxConcurrent: 5, delayBetweenBatches: 1000 });
    const ok = result.results.filter(r => [200, 201, 202].includes(r.status)).length;
    expect(ok).toBe(5);
  });

  test('GET /phase2/telemetry/summary — still valid after mutations', async () => {
    await sleep(500);
    const res = await resilientGet('/api/phase2/telemetry/summary');
    expect([200, 429]).toContain(res.status);
  });
});
