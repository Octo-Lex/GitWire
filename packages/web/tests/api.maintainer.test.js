// tests/api.maintainer.test.js
// Maintainer — settings, stats, audit

import { get, expectOk } from './helpers.js';

describe('Maintainer', () => {
  test('GET /api/maintainer/xjeddah/MyShell/settings returns settings', async () => {
    const res = await get('/api/maintainer/xjeddah/MyShell/settings');
    expectOk(res);
    expect(res.body.repo_id).toBeDefined();
    expect(res.body.stale_issue_days).toBeDefined();
    expect(res.body.enabled).toBeDefined();
  });

  test('GET /api/maintainer/xjeddah/MyShell/stats returns stats', async () => {
    const res = await get('/api/maintainer/xjeddah/MyShell/stats');
    expectOk(res);
    expect(res.body).toBeDefined();
  });

  test('GET /api/maintainer/audit returns audit log', async () => {
    const res = await get('/api/maintainer/audit');
    expectOk(res);
    expect(res.body.data).toBeInstanceOf(Array);
  });

  test('Audit entries have expected fields', async () => {
    const res = await get('/api/maintainer/audit');
    expectOk(res);
    if (res.body.data.length > 0) {
      const entry = res.body.data[0];
      expect(entry.action_type).toBeDefined();
      expect(entry.repo_full_name).toBeDefined();
      expect(entry.created_at).toBeDefined();
    }
  });
});
