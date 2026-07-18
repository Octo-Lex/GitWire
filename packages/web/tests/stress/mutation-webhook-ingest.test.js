// tests/stress/mutation-webhook-ingest.test.js
//
// SKIPPED: Webhook ingestion stress testing is unrunnable in the current
// harness. Every webhook call is a POST to /webhooks/github, which the PR1
// policy rejects unless mutations are enabled AND a registered contract is
// supplied. Signed webhook ingestion and its contract are explicitly out of
// scope for PR2a (tracked as ST-04 in the stress-test plan).
//
// Additionally, the previous assertions were defective:
// - "all rejected, none should 500" checked only status <= 500, so both 200
//   and 500 would pass.
// - The large-payload test checked only transport completion, so a successful
//   2xx response would also pass without validating rejection behavior.
//
// This suite is skipped until ST-04 (signed webhook ingestion with a real
// HMAC-signed payload contract) is implemented. Using describe.skip so none
// of these tests count as passing coverage.

describe.skip('Stress: Webhook Ingestion (ST-04 follow-up)', () => {
  test('POST /webhooks/github — unsigned payload rejected', async () => {
    // Requires ST-04: signed HMAC payload contract
  });
  test('POST /webhooks/github — empty body rejected', async () => {
    // Requires ST-04
  });
  test('POST /webhooks/github — 5 rapid unsigned payloads all rejected', async () => {
    // Requires ST-04
  });
  test('POST /webhooks/github — malformed event types handled', async () => {
    // Requires ST-04
  });
  test('POST /webhooks/github — extremely large payload handled', async () => {
    // Requires ST-04
  });
});
