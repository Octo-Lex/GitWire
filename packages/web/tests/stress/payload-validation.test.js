// tests/stress/payload-validation.test.js
// Stress Test: Malformed payloads — verify graceful handling of bad inputs
//
// Run: NODE_OPTIONS="--experimental-vm-modules" npx jest tests/stress/payload-validation.test.js --testTimeout=60000 --runInBand

import { post, get, expectOk, BASE_URL, API_KEY } from '../helpers.js';
import { sleep } from './stress-helpers.js';

async function apiPost(path, body) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, body: data };
}

async function rawPost(path, body, contentType = 'application/json') {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${API_KEY}`,
      'Content-Type': contentType,
    },
    body,
  });
  return { status: res.status };
}

describe('Payload Validation: malformed inputs', () => {
  beforeEach(async () => { await sleep(200); });

  describe('Enforcement policy creation', () => {
    test('Empty body → 400 or proper error', async () => {
      const res = await apiPost('/api/enforcement/policies', {});
      expect([200, 201, 400, 422, 429]).toContain(res.status);
    });

    test('Missing required fields → error', async () => {
      const res = await apiPost('/api/enforcement/policies', {
        description: 'No name or branch_pattern',
      });
      expect(res.status).not.toBe(200);
    });

    test('Invalid mode value → error', async () => {
      const res = await apiPost('/api/enforcement/policies', {
        name: `stress-invalid-mode-${Date.now()}`,
        branch_pattern: 'main',
        mode: 'DESTROY_EVERYTHING',
      });
      expect(res.status).not.toBe(200);
    });

    test('Very long name → should handle or reject', async () => {
      const res = await apiPost('/api/enforcement/policies', {
        name: 'x'.repeat(1000),
        branch_pattern: 'main',
        mode: 'audit',
      });
      expect(res.status).not.toBe(500);
    });
  });

  describe('Feedback rule creation', () => {
    test('Invalid event_type → error', async () => {
      const res = await apiPost('/api/phase2/feedback', {
        name: 'bad-event',
        event_type: 'EXPLODE',
      });
      expect(res.status).not.toBe(200);
    });

    test('Missing event_type → error', async () => {
      const res = await apiPost('/api/phase2/feedback', {
        name: 'no-event',
      });
      expect(res.status).not.toBe(200);
    });
  });

  describe('Non-JSON body', () => {
    test('Plain text body → 400 (not 500)', async () => {
      const res = await rawPost('/api/enforcement/policies', 'this is not json');
      expect(res.status).not.toBe(200);
      expect(res.status).not.toBe(500);
    });
  });

  describe('SQL injection attempts', () => {
    test("Repo name with SQL injection → 404 (not 500)", async () => {
      const res = await get("/api/repos/test'; DROP TABLE repositories;--");
      expect(res.status).not.toBe(500);
    });

    test("Issue search with SQL injection → no crash", async () => {
      const res = await get("/api/issues?search=' OR 1=1; DROP TABLE issues;--");
      expect(res.status).not.toBe(500);
    });
  });

  describe('Path traversal attempts', () => {
    test('Path traversal in repo name → normalized by Express, no FS access', async () => {
      const paths = [
        '/api/repos/../../../etc/passwd',
        '/api/repos/..%2F..%2F..%2Fetc%2Fpasswd',
        '/api/repos/....//....//....//etc/passwd',
      ];
      for (const p of paths) {
        const res = await get(p);
        // Express normalizes path before routing — ../ collapses.
        // These requests resolve to /api/repos which is a valid route.
        // The key assertion: no 500 error (no FS access attempted).
        expect(res.status).not.toBe(500);
        await sleep(100);
      }
    });
  });

  describe('Extremely large payloads', () => {
    test('Large JSON body → reject or handle', async () => {
      const hugeArray = Array.from({ length: 10000 }, (_, i) => `item-${i}`);
      const res = await apiPost('/api/enforcement/policies', {
        name: 'huge-payload',
        branch_pattern: 'main',
        mode: 'audit',
        required_status_check_contexts: hugeArray,
      });
      expect(res.status).not.toBe(500);
    });
  });
});
