// tests/api.fix.test.js
// Autonomous Contributor — fix attempts

import { get, expectOk } from './helpers.js';

describe('Autonomous Contributor', () => {
  test('GET /api/fix/Elephant-Rock-Lab/GitWire/attempts returns attempts', async () => {
    const res = await get('/api/fix/Elephant-Rock-Lab/GitWire/attempts');
    expectOk(res);
    expect(res.body.repo).toBe('Elephant-Rock-Lab/GitWire');
    expect(res.body.attempts).toBeInstanceOf(Array);
  });

  test('Fix attempts have expected fields', async () => {
    const res = await get('/api/fix/Elephant-Rock-Lab/GitWire/attempts');
    expectOk(res);
    if (res.body.attempts.length > 0) {
      const attempt = res.body.attempts[0];
      expect(attempt.issue_number).toBeDefined();
      expect(attempt.status).toBeDefined();
      expect(['submitted', 'failed', 'pending']).toContain(attempt.status);
    }
  });

  test('GET /api/fix/xjeddah/MyShell/attempts returns attempts', async () => {
    const res = await get('/api/fix/xjeddah/MyShell/attempts');
    expectOk(res);
    expect(res.body.repo).toBe('xjeddah/MyShell');
    expect(res.body.attempts).toBeInstanceOf(Array);
  });
});
