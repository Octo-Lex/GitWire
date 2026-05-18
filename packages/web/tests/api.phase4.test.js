// tests/api.phase4.test.js
// Phase 4 — AI Review Gate + Audit Trail

import { get, post, expectOk } from './helpers.js';

describe('Phase 4: AI Review Gate', () => {
  test('GET /api/review/stats returns stats', async () => {
    const res = await get('/api/review/stats');
    expectOk(res);
    expect(res.body.summary).toBeDefined();
    expect(res.body.summary.total_reviews).toBeDefined();
    expect(res.body.summary.repos_enabled).toBeDefined();
  });

  test('GET /api/review/results returns paginated reviews', async () => {
    const res = await get('/api/review/results');
    expectOk(res);
    expect(res.body.data).toBeInstanceOf(Array);
    expect(res.body.meta).toBeDefined();
  });

  test('Review results have expected fields when present', async () => {
    const res = await get('/api/review/results');
    expectOk(res);
    if (res.body.data.length > 0) {
      const review = res.body.data[0];
      expect(review.repo_full_name).toBeDefined();
      expect(review.verdict).toBeDefined();
      expect(['approve', 'request_changes', 'comment', 'approved']).toContain(review.verdict);
    }
  });

  test('GET /api/review/config/Elephant-Rock-Lab/GitWire returns config', async () => {
    const res = await get('/api/review/config/Elephant-Rock-Lab/GitWire');
    expectOk(res);
    expect(res.body).toBeDefined();
  });
});

describe('Phase 4: Audit Trail', () => {
  test('GET /api/audit/stats returns stats', async () => {
    const res = await get('/api/audit/stats');
    expectOk(res);
    expect(res.body.totals).toBeDefined();
    expect(res.body.totals.total_entries).toBeDefined();
    expect(res.body.by_category).toBeInstanceOf(Array);
  });

  test('GET /api/audit/entries returns paginated entries', async () => {
    const res = await get('/api/audit/entries');
    expectOk(res);
    expect(res.body.data).toBeInstanceOf(Array);
    expect(res.body.meta).toBeDefined();
  });

  test('Audit entries have required fields', async () => {
    const res = await get('/api/audit/entries');
    expectOk(res);
    if (res.body.data.length > 0) {
      const entry = res.body.data[0];
      expect(entry.category).toBeDefined();
      expect(entry.event_type).toBeDefined();
      expect(entry.actor).toBeDefined();
      expect(entry.payload_hash).toBeDefined();
    }
  });

  test('GET /api/audit/verify returns valid chain', async () => {
    const res = await get('/api/audit/verify');
    expectOk(res);
    expect(res.body.valid).toBe(true);
    expect(res.body.entries_checked).toBeGreaterThan(0);
  });

  test('GET /api/audit/reports returns reports list', async () => {
    const res = await get('/api/audit/reports');
    expectOk(res);
    expect(res.body.data).toBeInstanceOf(Array);
  });
});
