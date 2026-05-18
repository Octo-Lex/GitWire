// tests/api.triage.test.js
// Issue triage — stats, list, triage fields

import { get, expectOk } from './helpers.js';

describe('Issue Triage', () => {
  test('GET /api/issues/stats returns stats', async () => {
    const res = await get('/api/issues/stats');
    expectOk(res);
    expect(res.body.summary).toBeDefined();
    expect(res.body.summary.total_open).toBeDefined();
    expect(res.body.by_type).toBeInstanceOf(Array);
  });

  test('GET /api/issues returns paginated issues', async () => {
    const res = await get('/api/issues');
    expectOk(res);
    expect(res.body.data).toBeInstanceOf(Array);
    expect(res.body.meta).toBeDefined();
  });

  test('GET /api/issues?repo= filters by repo', async () => {
    const res = await get('/api/issues?repo=Elephant-Rock-Lab/Pharabius');
    expectOk(res);
    expect(res.body.data).toBeInstanceOf(Array);
  });

  test('Triaged issues have triage fields', async () => {
    const res = await get('/api/issues?per_page=50');
    expectOk(res);
    const triaged = res.body.data.filter(i => i.triage_type !== null && i.triage_type !== 'untriaged');
    if (triaged.length > 0) {
      const first = triaged[0];
      expect(first.triage_type).toBeDefined();
      expect(first.triage_priority).toBeDefined();
      expect(first.triage_summary).toBeDefined();
    }
  });
});
