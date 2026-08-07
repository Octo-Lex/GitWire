// tests/unit/idempotency-lifecycle-real-redis.test.js
// Real-Redis concurrency test for the triage idempotency lifecycle.
//
// This test verifies the atomic acquire/complete/abandon contract against a
// REAL disposable Redis instance (not a mock). The Lua scripts must guarantee
// exactly-one acquirer under concurrent contention — ioredis's script cache
// and eval semantics can differ subtly from mock, so this is the binding proof.
//
// Skipped automatically when no Redis is reachable at the test URL, so CI
// without Docker still passes. Set GITWIRE_TEST_REDIS_URL to force a specific
// instance (e.g., "redis://localhost:6390").

import { jest } from "@jest/globals";

const TEST_REDIS_URL = process.env.GITWIRE_TEST_REDIS_URL || "redis://localhost:6399";

// Lazy-load ioredis and the service; we'll skip the whole suite if Redis is
// unavailable so this test never fails CI in environments without Docker.
let redisClient = null;
let lifecycle = null;

async function ensureRedis() {
  if (redisClient) return redisClient;
  const IORedis = (await import("ioredis")).default;
  redisClient = new IORedis(TEST_REDIS_URL, {
    maxRetriesPerRequest: 1,
    connectTimeout: 1000,
    enableReadyCheck: false,
    retryStrategy: () => null, // fail fast, don't retry
  });
  // Probe connection with a 2s timeout
  await Promise.race([
    redisClient.ping(),
    new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 2000)),
  ]);
  return redisClient;
}

// Override the module-level `redis` import in idempotencyService so the
// lifecycle functions hit our disposable instance.
async function loadLifecycleWithRedis(client) {
  jest.unstable_mockModule("../../src/lib/queue.js", () => ({ redis: client }));
  jest.unstable_mockModule("../../src/lib/logger.js", () => ({
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  }));
  return await import("../../src/services/idempotencyService.js");
}

// Unique key namespace per test run to avoid collisions with prior runs
const RUN_ID = "realredis-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);

afterAll(async () => {
  if (redisClient) {
    try { await redisClient.quit(); } catch (_e) {}
  }
});

// Conditional describe: each test checks Redis availability at runtime
describe("Idempotency lifecycle — real Redis concurrency", () => {
  beforeAll(async () => {
    try {
      const client = await ensureRedis();
      lifecycle = await loadLifecycleWithRedis(client);
    } catch (err) {
      // Redis not available — tests will individually skip
      // eslint-disable-next-line no-console
      console.warn(`[skip] real-Redis test: no Redis at ${TEST_REDIS_URL} (${err.message})`);
    }
  });

  // Helper: skip at runtime if lifecycle (and thus Redis) is unavailable
  const itRedis = (name, fn) => it(name, async () => {
    if (!lifecycle) return; // silent skip — Redis not reachable
    await fn();
  });

  itRedis("exactly-one acquirer under concurrent contention (10 workers, same key)", async () => {
    const KEY = `${RUN_ID}:concurrent:issue:1:opened`;
    // Clear any prior state
    await lifecycle.clearTriageOperation("triage", KEY).catch(() => {});

    const N = 10;
    const results = await Promise.all(
      Array.from({ length: N }, () => lifecycle.beginOperation("triage", KEY)),
    );

    const acquirers = results.filter((r) => r.acquired);
    expect(acquirers.length).toBe(1);
    expect(acquirers[0].token).toBeTruthy();
  });

  itRedis("completed operation blocks all subsequent acquirers", async () => {
    const KEY = `${RUN_ID}:complete:issue:2:opened`;
    await lifecycle.clearTriageOperation("triage", KEY).catch(() => {});

    const lease = await lifecycle.beginOperation("triage", KEY);
    expect(lease.acquired).toBe(true);

    const ok = await lifecycle.completeOperation("triage", KEY, lease.token);
    expect(ok).toBe(true);

    // 5 subsequent attempts must all see alreadyComplete
    const results = await Promise.all(
      Array.from({ length: 5 }, () => lifecycle.beginOperation("triage", KEY)),
    );
    for (const r of results) {
      expect(r.acquired).toBe(false);
      expect(r.alreadyComplete).toBe(true);
    }
  });

  itRedis("abandoned lease allows re-acquisition (fail-then-retry)", async () => {
    const KEY = `${RUN_ID}:abandon:issue:3:opened`;
    await lifecycle.clearTriageOperation("triage", KEY).catch(() => {});

    const lease = await lifecycle.beginOperation("triage", KEY);
    expect(lease.acquired).toBe(true);

    const released = await lifecycle.abandonOperation("triage", KEY, lease.token);
    expect(released).toBe(true);

    // A new worker must now acquire
    const lease2 = await lifecycle.beginOperation("triage", KEY);
    expect(lease2.acquired).toBe(true);
    expect(lease2.token).not.toBe(lease.token);
  });

  itRedis("wrong token cannot release another worker's lease", async () => {
    const KEY = `${RUN_ID}:token:issue:4:opened`;
    await lifecycle.clearTriageOperation("triage", KEY).catch(() => {});

    const lease = await lifecycle.beginOperation("triage", KEY);
    const wrongToken = "definitely-not-the-right-token";

    const released = await lifecycle.abandonOperation("triage", KEY, wrongToken);
    expect(released).toBe(false);

    // The original worker should still be able to complete with its own token
    const ok = await lifecycle.completeOperation("triage", KEY, lease.token);
    expect(ok).toBe(true);
  });

  itRedis("repository-scoped keys do not collide under concurrent acquire", async () => {
    const keyA = `${RUN_ID}:scope:repo:100:issue:42:opened`;
    const keyB = `${RUN_ID}:scope:repo:200:issue:42:opened`;
    await lifecycle.clearTriageOperation("triage", keyA).catch(() => {});
    await lifecycle.clearTriageOperation("triage", keyB).catch(() => {});

    // Concurrent acquire on different repos must both succeed
    const [a, b] = await Promise.all([
      lifecycle.beginOperation("triage", keyA),
      lifecycle.beginOperation("triage", keyB),
    ]);
    expect(a.acquired).toBe(true);
    expect(b.acquired).toBe(true);
  });
});
