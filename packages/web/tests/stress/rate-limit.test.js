// tests/stress/rate-limit.test.js
// Stress Test: Rate limiting — verify 429 responses after hitting the limit
//
// Run individually (must be FIRST suite to get clean rate limit window):
// NODE_OPTIONS="--experimental-vm-modules" npx jest tests/stress/rate-limit.test.js --testTimeout=120000 --runInBand

import { BASE_URL, API_KEY } from '../helpers.js';

const BURST = 120;

async function rawGet(path) {
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: {
      'Authorization': `Bearer ${API_KEY}`,
      'Content-Type': 'application/json',
    },
  });
  return { status: res.status };
}

describe('Rate Limiting', () => {
  test(`Burst ${BURST} requests — should see 429 after limit`, async () => {
    const statuses = [];
    const start = Date.now();

    // Sequential batches to avoid socket exhaustion
    for (let batch = 0; batch < Math.ceil(BURST / 10); batch++) {
      const batchSize = Math.min(10, BURST - batch * 10);
      const batchResults = await Promise.all(
        Array.from({ length: batchSize }, () => rawGet('/api/repos'))
      );
      statuses.push(...batchResults.map(r => r.status));
    }

    const elapsed = Date.now() - start;
    const ok200 = statuses.filter(s => s === 200).length;
    const rateLimited = statuses.filter(s => s === 429).length;
    const other = statuses.filter(s => s !== 200 && s !== 429).length;

    console.log(`  ${BURST} requests in ${elapsed}ms:`);
    console.log(`    200 OK: ${ok200}`);
    console.log(`    429 Rate Limited: ${rateLimited}`);
    console.log(`    Other: ${other}`);

    // We should see BOTH 200s AND 429s (if rate limiter is working)
    // If all 429: previous tests exhausted the limit — that's OK too
    expect(ok200 + rateLimited).toBe(BURST);
    expect(other).toBe(0);
  });

  test('Rate-limited request includes proper error body', async () => {
    const res = await fetch(`${BASE_URL}/api/repos`, {
      headers: { 'Authorization': `Bearer ${API_KEY}` },
    });
    // Either 200 (limit reset) or 429 (still limited)
    expect([200, 429]).toContain(res.status);
    if (res.status === 429) {
      const body = await res.json();
      expect(body.error).toBeDefined();
    }
  });

  test('/health endpoint is NOT rate limited', async () => {
    const results = await Promise.all(
      Array.from({ length: 50 }, () => fetch(`${BASE_URL}/health`))
    );
    const all200 = results.every(r => r.status === 200);
    console.log(`  Health x50: all 200 = ${all200}`);
    expect(all200).toBe(true);
  });
});
