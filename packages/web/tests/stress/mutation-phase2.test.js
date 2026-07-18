// tests/stress/mutation-phase2.test.js
// Stress Test: Phase 2 mutation routes — merge queue config.
import { apiContractedOperation, STATUS_SETS } from './response-contracts.js';
import { runContractedBurst } from './burst-runner.js';
import { post, FIXTURE_REPO } from '../helpers.js';
import { sleep, resilientGet } from './stress-helpers.js';

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
    const tasks = Array.from({ length: 5 }, (_, i) => apiContractedOperation(
      `/api/phase2/queue/${REPO}/config`,
      {
        kind: 'write', method: 'POST',
        body: { enabled: true, merge_method: i % 2 === 0 ? 'squash' : 'merge', max_queue_depth: 3 + i, required_checks: [] },
        contractName: 'phase2-queue-config',
        expectedStatuses: STATUS_SETS.MUTATION_ACCEPTED,
      }
    ));
    const result = await runContractedBurst(tasks, {
      concurrency: 5, pacing: { mode: 'legacy_batches', delayMs: 1000 },
    });
    expect(result.httpExpected).toBe(result.attempted);
    expect(result.httpUnexpected).toBe(0);
  });

  test('GET /phase2/telemetry/summary — still valid after mutations', async () => {
    await sleep(500);
    const res = await resilientGet('/api/phase2/telemetry/summary');
    expect([200, 429]).toContain(res.status);
  });
});
