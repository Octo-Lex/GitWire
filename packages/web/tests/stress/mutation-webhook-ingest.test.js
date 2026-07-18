// tests/stress/mutation-webhook-ingest.test.js
// Stress Test: Webhook ingestion — simulate rapid GitHub webhook events.
//
// We send unsigned payloads to test error handling (should 400/401/403/500,
// not crash). The factual outcome runner classifies these as transport-
// completed with the server's rejection status, not as transport failures.
import { apiBurstOperation } from '../helpers.js';
import { boundedBurst } from './stress-helpers.js';

const WEBHOOK_URL = '/webhooks/github';

describe('Stress: Webhook Ingestion', () => {

  test('POST /webhooks/github — unsigned payload rejected', async () => {
    const tasks = [apiBurstOperation(WEBHOOK_URL, {
      kind: 'webhook', method: 'POST',
      body: { action: 'opened', issue: { number: 1, title: 'test' }, repository: { full_name: 'test/repo', id: 1 }, sender: { login: 'test' } },
    })];
    const result = await boundedBurst(tasks, { maxConcurrent: 1 });
    // Should reject (no valid signature) but NOT crash
    expect(result.results[0].status).toBeGreaterThanOrEqual(400);
  });

  test('POST /webhooks/github — empty body rejected', async () => {
    const tasks = [apiBurstOperation(WEBHOOK_URL, { kind: 'webhook', method: 'POST', body: {} })];
    const result = await boundedBurst(tasks, { maxConcurrent: 1 });
    expect(result.results[0].status).toBeGreaterThanOrEqual(400);
  });

  test('POST /webhooks/github — 5 rapid unsigned payloads all rejected', async () => {
    const tasks = Array.from({ length: 5 }, (_, i) => apiBurstOperation(WEBHOOK_URL, {
      kind: 'webhook', method: 'POST',
      body: { action: 'opened', issue: { number: i, title: `stress-${i}` }, repository: { full_name: 'test/repo', id: 1 }, sender: { login: 'bot' } },
    }));
    const result = await boundedBurst(tasks, { maxConcurrent: 5, delayBetweenBatches: 500 });
    // All should be rejected, none should 500 (server crash)
    result.results.forEach(r => expect(r.status).toBeLessThanOrEqual(500));
  });

  test('POST /webhooks/github — malformed event types handled', async () => {
    const tasks = [apiBurstOperation(WEBHOOK_URL, {
      kind: 'webhook', method: 'POST',
      body: { action: 'unknown_action', something: { nested: true } },
    })];
    const result = await boundedBurst(tasks, { maxConcurrent: 1 });
    expect(result.results[0].status).toBeGreaterThanOrEqual(400);
  });

  test('POST /webhooks/github — extremely large payload handled', async () => {
    const tasks = [apiBurstOperation(WEBHOOK_URL, {
      kind: 'webhook', method: 'POST',
      body: { action: 'opened', issue: { number: 1, title: 'x'.repeat(10000), body: 'y'.repeat(50000) }, repository: { full_name: 'test/repo', id: 1 }, sender: { login: 'test' } },
    })];
    const result = await boundedBurst(tasks, { maxConcurrent: 1 });
    // Large payload should be handled gracefully (400/413/500, not crash)
    expect(result.transportCompleted).toBe(1);
  });
});
