// tests/stress/mutation-enforcement.test.js
// Stress Test: Enforcement run — concurrent triggers against the fixture installation.
//
// Policy/rule CRUD-creation routes (POST /api/enforcement/policies etc.) are
// removed from this revision: they create new resources that do not yet carry
// a fixture identity, and the fail-closed fixture contract requires the
// declared fixture identity be present. CRUD-creation mutations belong in a
// later PR that defines a FIXTURE_RESOURCE_CREATE contract class with
// creation-budget tracking.
import { apiBurstOperation, FIXTURE_INSTALLATION_ID } from '../helpers.js';
import { boundedBurst } from './stress-helpers.js';

describe('Stress: Enforcement Mutations', () => {

  test('POST /enforcement/run — trigger 3 concurrent enforcement runs', async () => {
    const tasks = Array.from({ length: 3 }, () => apiBurstOperation(
      '/api/enforcement/run',
      {
        kind: 'write',
        method: 'POST',
        body: { installation_id: FIXTURE_INSTALLATION_ID },
        contractName: 'enforcement-run',
      }
    ));
    const result = await boundedBurst(tasks, { maxConcurrent: 3, delayBetweenBatches: 1000 });
    const ok = result.results.filter(r => [200, 201, 202].includes(r.status)).length;
    expect(ok).toBe(3);
  });
});
