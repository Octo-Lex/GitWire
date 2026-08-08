// tests/unit/idempotency-lifecycle.test.js
// Unit tests for the success-bound triage idempotency lifecycle.
//
// Covers the 10 lifecycle cases from the implementation plan §4:
//   1. First worker acquires the lease
//   2. Concurrent worker does NOT acquire (returns in-flight)
//   3. Failure releases the lease
//   4. Released operation can be acquired again
//   5. Success creates the complete marker
//   6. Completed operation cannot run again
//   7. Expired active lease can be reacquired (TTL simulation)
//   8. Incorrect token cannot abandon another worker's lease
//   9. Repository-scoped keys do not collide
//  10. Redis failure throws IdempotencyStoreUnavailable
//
// Also covers key-builder identity + manual-run integration.

import { jest } from "@jest/globals";

// ── Mock Redis client ────────────────────────────────────────────────────────
// The mock captures keys/values/tokens so we can assert on state transitions.
const store = new Map();

const mockRedis = {
  eval: jest.fn(),
  del: jest.fn(async (...keys) => {
    let n = 0;
    for (const k of keys) if (store.delete(k)) n++;
    return n;
  }),
  exists: jest.fn(async (k) => (store.has(k) ? 1 : 0)),
  // Internal helpers for test setup/inspection
  __store: store,
  __reset() { store.clear(); },
};

jest.unstable_mockModule("../../src/lib/queue.js", () => ({ redis: mockRedis }));
jest.unstable_mockModule("../../src/lib/logger.js", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// ── Wire the mock eval to the lifecycle behavior ────────────────────────────
// Each lifecycle function calls redis.eval(script, numkeys, ...keys, ...args).
// We simulate the Lua logic in JS so tests can verify behavior without a real
// Redis. The "real Redis" concurrency test lives separately and uses a
// disposable container.
function simulateLua(script, numkeys, ...rest) {
  const keys = rest.slice(0, numkeys);
  const args = rest.slice(numkeys);

  // Trim leading newlines from script for matching
  const s = script.replace(/\n\s+/g, " ").trim();

  // ACQUIRE: check no active AND no complete, then write active lease
  if (s.includes("local active") && s.includes("EXISTS") && s.includes("ARGV")) {
    if (store.has(keys[0])) return 0; // active exists
    if (store.has(keys[1])) return 0; // complete exists
    store.set(keys[0], args[0]); // active = token
    // Note: we don't honor TTL in mock (TTL expiry tested separately)
    return 1;
  }
  // COMPLETE: verify active token, delete active, write complete
  if (s.includes("GET") && s.includes("DEL") && s.includes("ARGV")) {
    const held = store.get(keys[0]);
    if (held === undefined) {
      // active gone — check if complete exists
      return store.has(keys[1]) ? 1 : 0;
    }
    if (held !== args[0]) return 0; // token mismatch
    store.delete(keys[0]);
    store.set(keys[1], "1");
    return 1;
  }
  // ABANDON: token-gated release of active
  if (s.includes("GET") && s.includes("DEL") && s.includes("ARGV")) {
    const held = store.get(keys[0]);
    if (held === undefined) return 1;
    if (held !== args[0]) return 0;
    store.delete(keys[0]);
    return 1;
  }
  // CHECK_COMPLETE
  if (s.includes("EXISTS") && script.length < 80) {
    return store.has(keys[0]) ? 1 : 0;
  }
  throw new Error("Unmatched Lua script in mock: " + s.slice(0, 60));
}

mockRedis.eval.mockImplementation(async (script, numkeys, ...rest) =>
  simulateLua(script, numkeys, ...rest));

const {
  beginOperation,
  completeOperation,
  abandonOperation,
  buildTriageOperationKey,
  clearTriageOperation,
  isOperationComplete,
  IdempotencyStoreUnavailable,
} = await import("../../src/services/idempotencyService.js");

const SOURCE = "triage";

beforeEach(() => {
  mockRedis.__reset();
  mockRedis.eval.mockClear();
  mockRedis.del.mockClear();
  mockRedis.exists.mockClear();
  // Restore default implementation (tests that simulate Redis failure will override)
  mockRedis.eval.mockImplementation(async (script, numkeys, ...rest) =>
    simulateLua(script, numkeys, ...rest));
});

describe("Idempotency lifecycle — 10 required cases", () => {
  const KEY = "repo:1:issue:10:opened";

  it("1. First worker acquires the lease", async () => {
    const lease = await beginOperation(SOURCE, KEY);
    expect(lease.acquired).toBe(true);
    expect(lease.alreadyComplete).toBe(false);
    expect(lease.token).toBeTruthy();
  });

  it("2. Concurrent worker does NOT acquire (in-flight)", async () => {
    const first = await beginOperation(SOURCE, KEY);
    expect(first.acquired).toBe(true);

    const second = await beginOperation(SOURCE, KEY);
    expect(second.acquired).toBe(false);
    expect(second.alreadyComplete).toBe(false);
    expect(second.token).toBeNull();
  });

  it("3. Failure releases the lease via abandonOperation", async () => {
    const lease = await beginOperation(SOURCE, KEY);
    const released = await abandonOperation(SOURCE, KEY, lease.token);
    expect(released).toBe(true);

    // After abandon, a new worker should be able to acquire
    const reacquired = await beginOperation(SOURCE, KEY);
    expect(reacquired.acquired).toBe(true);
  });

  it("4. Released operation can be acquired again", async () => {
    const lease1 = await beginOperation(SOURCE, KEY);
    await abandonOperation(SOURCE, KEY, lease1.token);

    const lease2 = await beginOperation(SOURCE, KEY);
    expect(lease2.acquired).toBe(true);
    expect(lease2.token).not.toBe(lease1.token);
  });

  it("5. Success creates the complete marker (via completeOperation)", async () => {
    const lease = await beginOperation(SOURCE, KEY);
    const ok = await completeOperation(SOURCE, KEY, lease.token);
    expect(ok).toBe(true);

    // The complete marker must now exist
    const complete = await isOperationComplete(SOURCE, KEY);
    expect(complete).toBe(true);
  });

  it("6. Completed operation cannot run again", async () => {
    const lease = await beginOperation(SOURCE, KEY);
    await completeOperation(SOURCE, KEY, lease.token);

    const second = await beginOperation(SOURCE, KEY);
    expect(second.acquired).toBe(false);
    expect(second.alreadyComplete).toBe(true);
  });

  it("7. Expired active lease can be reacquired (simulated TTL expiry)", async () => {
    const lease = await beginOperation(SOURCE, KEY);
    // Simulate TTL expiry by manually deleting the active key
    const activeKey = `gitwire:idem:${SOURCE}:${KEY}:active`;
    mockRedis.__store.delete(activeKey);

    // A new worker should now be able to acquire (no active, no complete)
    const reacquired = await beginOperation(SOURCE, KEY);
    expect(reacquired.acquired).toBe(true);
  });

  it("8. Incorrect token cannot abandon another worker's lease", async () => {
    const lease = await beginOperation(SOURCE, KEY);
    const wrongToken = "not-the-real-token";

    const released = await abandonOperation(SOURCE, KEY, wrongToken);
    expect(released).toBe(false);

    // The original worker's lease should still be held
    const activeKey = `gitwire:idem:${SOURCE}:${KEY}:active`;
    expect(mockRedis.__store.get(activeKey)).toBe(lease.token);
  });

  it("9. Repository-scoped keys do not collide", async () => {
    const repoA = buildTriageOperationKey({ targetType: "issue", repoId: 100, targetId: 42, action: "opened" });
    const repoB = buildTriageOperationKey({ targetType: "issue", repoId: 200, targetId: 42, action: "opened" });
    expect(repoA).not.toBe(repoB);

    // Acquiring on repo A must not block repo B
    const leaseA = await beginOperation(SOURCE, repoA);
    const leaseB = await beginOperation(SOURCE, repoB);
    expect(leaseA.acquired).toBe(true);
    expect(leaseB.acquired).toBe(true);
  });

  it("10. Redis failure throws IdempotencyStoreUnavailable", async () => {
    mockRedis.eval.mockRejectedValue(new Error("ECONNREFUSED"));

    await expect(beginOperation(SOURCE, KEY)).rejects.toThrow(IdempotencyStoreUnavailable);
    await expect(completeOperation(SOURCE, KEY, "tok")).rejects.toThrow(IdempotencyStoreUnavailable);
    await expect(abandonOperation(SOURCE, KEY, "tok")).rejects.toThrow(IdempotencyStoreUnavailable);
  });
});

describe("Key builder identity", () => {
  it("builds a repo-scoped issue key", () => {
    const key = buildTriageOperationKey({
      targetType: "issue", repoId: 123, targetId: 456, action: "opened",
    });
    expect(key).toBe("repo:123:issue:456:opened");
  });

  it("builds a repo-scoped PR key", () => {
    const key = buildTriageOperationKey({
      targetType: "pr", repoId: 123, targetId: 789, action: "reopened",
    });
    expect(key).toBe("repo:123:pr:789:reopened");
  });

  it("supports the manual-run action variant", () => {
    const key = buildTriageOperationKey({
      targetType: "issue", repoId: 123, targetId: 456, action: "manual-run",
    });
    expect(key).toBe("repo:123:issue:456:manual-run");
  });

  it("rejects missing required fields", () => {
    expect(() => buildTriageOperationKey({ targetType: "issue", repoId: 1, targetId: 2 }))
      .toThrow();
    expect(() => buildTriageOperationKey({ repoId: 1, targetId: 2, action: "opened" }))
      .toThrow();
  });

  it("does not collide across different actions on the same target", () => {
    const opened = buildTriageOperationKey({ targetType: "issue", repoId: 1, targetId: 1, action: "opened" });
    const reopened = buildTriageOperationKey({ targetType: "issue", repoId: 1, targetId: 1, action: "reopened" });
    const edited = buildTriageOperationKey({ targetType: "issue", repoId: 1, targetId: 1, action: "edited" });
    expect(new Set([opened, reopened, edited]).size).toBe(3);
  });
});

describe("clearTriageOperation (manual-run path)", () => {
  it("clears both active and complete markers", async () => {
    const KEY = "repo:1:issue:5:manual-run";
    const lease = await beginOperation(SOURCE, KEY);
    await completeOperation(SOURCE, KEY, lease.token);

    // After clear, the operation should be acquirable again
    await clearTriageOperation(SOURCE, KEY);
    const reacquired = await beginOperation(SOURCE, KEY);
    expect(reacquired.acquired).toBe(true);
  });

  it("throws IdempotencyStoreUnavailable on Redis failure", async () => {
    mockRedis.del.mockRejectedValue(new Error("ECONNREFUSED"));
    await expect(clearTriageOperation(SOURCE, "any-key")).rejects.toThrow(IdempotencyStoreUnavailable);
  });
});
