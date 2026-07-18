// tests/stress/mutation-enforcement.test.js
// Stress Test: Enforcement run — concurrent triggers against the fixture installation.
import { apiContractedOperation, STATUS_SETS } from './response-contracts.js';
import { runContractedBurst } from './burst-runner.js';
import { FIXTURE_INSTALLATION_ID } from '../helpers.js';

describe('Stress: Enforcement Mutations', () => {
  test('POST /enforcement/run — trigger 3 concurrent enforcement runs', async () => {
    const tasks = Array.from({ length: 3 }, () => apiContractedOperation(
      '/api/enforcement/run',
      {
        kind: 'write', method: 'POST',
        body: { installation_id: FIXTURE_INSTALLATION_ID },
        contractName: 'enforcement-run',
        expectedStatuses: STATUS_SETS.MUTATION_ACCEPTED,
      }
    ));
    const result = await runContractedBurst(tasks, {
      concurrency: 3, pacing: { mode: 'legacy_batches', delayMs: 1000 },
    });
    expect(result.httpExpected).toBe(result.attempted);
    expect(result.httpUnexpected).toBe(0);
  });
});
