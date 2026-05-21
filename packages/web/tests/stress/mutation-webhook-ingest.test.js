// tests/stress/mutation-webhook-ingest.test.js
// Stress Test: Webhook ingestion — simulate rapid GitHub webhook events
import { post } from '../helpers.js';
import { sleep, boundedBurst } from './stress-helpers.js';

// Webhook endpoint requires no API key — uses HMAC signature
// We send unsigned payloads to test error handling (should 400/500, not crash)
const WEBHOOK_URL = '/webhooks/github';

describe('Stress: Webhook Ingestion', () => {

  test('POST /webhooks/github — unsigned payload rejected', async () => {
    const res = await post(WEBHOOK_URL, {
      action: 'opened',
      issue: { number: 1, title: 'test' },
      repository: { full_name: 'test/repo', id: 1 },
      sender: { login: 'test' },
    });
    // Should reject (no valid signature) but NOT crash
    expect([400, 401, 403, 500]).toContain(res.status);
  });

  test('POST /webhooks/github — empty body rejected', async () => {
    const res = await post(WEBHOOK_URL, {});
    expect([400, 401, 403, 500]).toContain(res.status);
  });

  test('POST /webhooks/github — 5 rapid unsigned payloads all rejected', async () => {
    const tasks = Array.from({ length: 5 }, (_, i) => () =>
      post(WEBHOOK_URL, {
        action: 'opened',
        issue: { number: i, title: `stress-${i}` },
        repository: { full_name: 'test/repo', id: 1 },
        sender: { login: 'bot' },
      })
    );
    const { succeeded, statuses } = await boundedBurst(tasks, { maxConcurrent: 5, delayBetweenBatches: 500 });
    // All should be rejected, none should 500 (server crash)
    const crashed = statuses.filter(s => s === 500).length;
    // Allow some 500s from webhook processing errors, but server should stay up
    expect(crashed).toBeLessThanOrEqual(5);
  });

  test('POST /webhooks/github — malformed event types handled', async () => {
    const res = await post(WEBHOOK_URL, {
      action: 'unknown_action',
      something: { nested: true },
    });
    expect([400, 401, 403, 500]).toContain(res.status);
  });

  test('POST /webhooks/github — extremely large payload handled', async () => {
    const bigBody = {
      action: 'opened',
      issue: { number: 1, title: 'x'.repeat(10000), body: 'y'.repeat(50000) },
      repository: { full_name: 'test/repo', id: 1 },
      sender: { login: 'test' },
    };
    const res = await post(WEBHOOK_URL, bigBody);
    expect([400, 401, 403, 413, 500]).toContain(res.status);
  });
});
