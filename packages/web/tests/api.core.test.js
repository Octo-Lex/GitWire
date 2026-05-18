// tests/api.core.test.js
// Core API endpoints — health, repos, sync

import { get, post, expectOk, expectShape } from './helpers.js';

describe('Core API', () => {
  test('GET /health returns ok', async () => {
    const res = await get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.service).toBe('gitops-hub');
    expect(res.body.ts).toBeDefined();
  });

  test('GET /api/repos returns paginated list', async () => {
    const res = await get('/api/repos');
    expectOk(res);
    expect(res.body.data).toBeInstanceOf(Array);
    expect(res.body.meta).toBeDefined();
    expect(res.body.meta.page).toBeDefined();
    expect(res.body.meta.total).toBeGreaterThan(0);
  });

  test('GET /api/repos?per_page=3 limits results', async () => {
    const res = await get('/api/repos?per_page=3');
    expectOk(res);
    expect(res.body.data.length).toBeLessThanOrEqual(3);
    expect(res.body.meta.per_page).toBe(3);
  });

  test('GET /api/repos/:owner/:repo returns repo detail', async () => {
    const res = await get('/api/repos/Elephant-Rock-Lab/GitWire');
    expectOk(res);
    expect(res.body.full_name).toBe('Elephant-Rock-Lab/GitWire');
    expect(res.body.github_id).toBeDefined();
    expect(res.body.installation_id).toBeDefined();
  });

  test('GET /api/repos/:owner/:repo 404 for unknown repo', async () => {
    const res = await get('/api/repos/nonexistent/fakerepo');
    expect(res.status).toBe(404);
  });

  test('GET without API key returns 401', async () => {
    const res = await fetch(`${process.env.GITWIRE_BASE_URL || 'https://gitwire.erlab.uk'}/api/repos`);
    expect(res.status).toBe(401);
  });
});
