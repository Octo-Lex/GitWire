// tests/stress/auth-edge-cases.test.js
// Stress Test: Authentication edge cases
//
// Run individually: NODE_OPTIONS="--experimental-vm-modules" npx jest tests/stress/auth-edge-cases.test.js --testTimeout=60000 --runInBand

import { BASE_URL, API_KEY } from '../helpers.js';
import { sleep } from './stress-helpers.js';

describe('Auth Edge Cases', () => {
  beforeEach(async () => { await sleep(200); });

  test('No Authorization header → 401', async () => {
    const res = await fetch(`${BASE_URL}/api/repos`);
    expect(res.status).toBe(401);
  });

  test('Empty Bearer token → 401', async () => {
    const res = await fetch(`${BASE_URL}/api/repos`, {
      headers: { 'Authorization': 'Bearer ' },
    });
    expect(res.status).toBe(401);
  });

  test('Bearer with random string → 401', async () => {
    const res = await fetch(`${BASE_URL}/api/repos`, {
      headers: { 'Authorization': 'Bearer not-a-real-key-at-all-12345' },
    });
    expect(res.status).toBe(401);
  });

  test('Basic auth instead of Bearer → 401', async () => {
    const res = await fetch(`${BASE_URL}/api/repos`, {
      headers: { 'Authorization': 'Basic dXNlcjpwYXNz' },
    });
    expect(res.status).toBe(401);
  });

  test('API key in query string → 401 (header only)', async () => {
    const res = await fetch(`${BASE_URL}/api/repos?api_key=test`);
    expect(res.status).toBe(401);
  });

  test('/health and /webhooks/github require no auth', async () => {
    const [health, webhook] = await Promise.all([
      fetch(`${BASE_URL}/health`),
      fetch(`${BASE_URL}/webhooks/github`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      }),
    ]);
    expect(health.status).toBe(200);
    expect(webhook.status).not.toBe(401);
  });

  test('Sequential authed + unauthed: authed=200, unauthed=401', async () => {
    const results = [];
    for (let i = 0; i < 10; i++) {
      const authed = i % 2 === 0;
      const res = await fetch(`${BASE_URL}/api/repos`, {
        headers: authed ? { 'Authorization': `Bearer ${API_KEY}` } : {},
      });
      results.push({ authed, status: res.status });
      await sleep(100);
    }
    const authedStatuses = results.filter(r => r.authed).map(r => r.status);
    const unauthedStatuses = results.filter(r => !r.authed).map(r => r.status);
    console.log(`  Authed: ${authedStatuses.join(', ')}`);
    console.log(`  Unauthed: ${unauthedStatuses.join(', ')}`);
    // Authed should be 200 (or 429 if rate limited from other suites)
    authedStatuses.forEach(s => expect([200, 429]).toContain(s));
    unauthedStatuses.forEach(s => expect(s).toBe(401));
  });

  test('Very long API key → 401', async () => {
    const res = await fetch(`${BASE_URL}/api/repos`, {
      headers: { 'Authorization': `Bearer ${'A'.repeat(10000)}` },
    });
    expect(res.status).toBe(401);
  });

  test('Special characters in API key → 401', async () => {
    const res = await fetch(`${BASE_URL}/api/repos`, {
      headers: { 'Authorization': 'Bearer <script>alert(1)</script>' },
    });
    expect(res.status).toBe(401);
  });
});
