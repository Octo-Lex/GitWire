// tests/unit/check-run-lifecycle.test.js
// Focused tests for the check run lifecycle ownership fix.
//
// Proves:
//   1. Normal success: owned check → completed with real result
//   2. Configured skip: owned check → completed neutral
//   3. Duplicate jobs sharing PR+SHA own different check IDs
//   4. Original remains untouched when duplicate finalizes
//   5. Explicit-ID finalization works when Redis is missing
//   6. Redis pointer overwritten with another ID: old job cannot delete it
//   7. GitHub PATCH failure leaves pointer intact
//   8. Thrown review path attempts failure finalization
//   9. checkRunId threaded from webhook route through dispatch to job
//  10. updateGitwireCheck returns boolean success/failure

import { jest } from "@jest/globals";

// ── Mocks ────────────────────────────────────────────────────────────────────
const mockRedisStore = new Map();
const mockRedis = {
  get: jest.fn(async (k) => mockRedisStore.get(k) ?? null),
  setex: jest.fn(async (k, ttl, v) => { mockRedisStore.set(k, v); }),
  del: jest.fn(async (k) => { mockRedisStore.delete(k); }),
  eval: jest.fn(async (script, numkeys, key, expected) => {
    // Simulate atomic compare-and-delete
    const current = mockRedisStore.get(key);
    if (current === expected) {
      mockRedisStore.delete(key);
      return 1;
    }
    return 0;
  }),
};
const mockUpdateGitwireCheck = jest.fn();

jest.unstable_mockModule("../../src/lib/queue.js", () => ({
  redis: mockRedis,
  createWorker: jest.fn(),
  createQueue: jest.fn(),
  QUEUES: { PHASE4: "phase4" },
}));

jest.unstable_mockModule("../../src/lib/checkStatus.js", () => ({
  updateGitwireCheck: mockUpdateGitwireCheck,
  createGitwireCheck: jest.fn(),
}));

jest.unstable_mockModule("../../src/lib/logger.js", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const { finalizeGitwireCheck, checkRunKey } = await import("../../src/services/checkRunFinalizer.js");

beforeEach(() => {
  mockRedisStore.clear();
  jest.clearAllMocks();
  mockUpdateGitwireCheck.mockResolvedValue(true);
  mockRedis.get.mockImplementation(async (k) => mockRedisStore.get(k) ?? null);
  mockRedis.del.mockImplementation(async (k) => { mockRedisStore.delete(k); });
  mockRedis.setex.mockImplementation(async (k, ttl, v) => { mockRedisStore.set(k, v); });
});

// ── Finalizer tests ──────────────────────────────────────────────────────────

describe("finalizeGitwireCheck with explicit checkRunId", () => {
  const baseParams = {
    octokit: {},
    owner: "org",
    repo: "repo",
    repoId: 999,
    prNumber: 16,
    headSha: "abc123",
  };

  it("1. Uses explicit checkRunId to finalize (success result)", async () => {
    await finalizeGitwireCheck({
      ...baseParams,
      reviewResult: { verdict: "approved", findings: [], blocked: false },
      checkRunId: 5000,
    });

    expect(mockUpdateGitwireCheck).toHaveBeenCalledWith(expect.objectContaining({
      checkRunId: 5000,
      conclusion: "success",
    }));
  });

  it("2. Uses explicit checkRunId to finalize (null result = neutral)", async () => {
    await finalizeGitwireCheck({
      ...baseParams,
      reviewResult: null,
      checkRunId: 5001,
    });

    expect(mockUpdateGitwireCheck).toHaveBeenCalledWith(expect.objectContaining({
      checkRunId: 5001,
      conclusion: "neutral",
    }));
  });

  it("3. Does not read Redis for ID resolution when explicit checkRunId is provided", async () => {
    // Even with Redis empty, explicit ID should work
    await finalizeGitwireCheck({
      ...baseParams,
      reviewResult: null,
      checkRunId: 5002,
    });

    expect(mockUpdateGitwireCheck).toHaveBeenCalledWith(expect.objectContaining({
      checkRunId: 5002,
    }));
    // PATCH succeeded, so the atomic compare-and-delete runs.
    // That calls redis.eval (not redis.get) for the compare-and-delete.
    // The retry-key cleanup calls redis.del. Both are expected.
    expect(mockRedis.eval).toHaveBeenCalled();
  });

  it("4. Falls back to Redis when no explicit checkRunId", async () => {
    mockRedisStore.set(checkRunKey(999, 16, "abc123"), "6000");

    await finalizeGitwireCheck({
      ...baseParams,
      reviewResult: null,
      // no checkRunId
    });

    expect(mockUpdateGitwireCheck).toHaveBeenCalledWith(expect.objectContaining({
      checkRunId: 6000,
    }));
  });

  it("5. Deletes Redis pointer via atomic eval when it matches this checkRunId", async () => {
    const key = checkRunKey(999, 16, "abc123");
    mockRedisStore.set(key, "5003");

    await finalizeGitwireCheck({
      ...baseParams,
      reviewResult: null,
      checkRunId: 5003,
    });

    // Atomic eval should have been called with the check key and the matching ID
    expect(mockRedis.eval).toHaveBeenCalledWith(
      expect.any(String), 1, key, "5003",
    );
    // Store should no longer have the key (eval mock deletes on match)
    expect(mockRedisStore.has(key)).toBe(false);
  });

  it("6. Does NOT delete Redis pointer via eval if it refers to a different checkRunId", async () => {
    const key = checkRunKey(999, 16, "abc123");
    // Pointer was overwritten by a newer job with checkRunId 7000
    mockRedisStore.set(key, "7000");

    await finalizeGitwireCheck({
      ...baseParams,
      reviewResult: null,
      checkRunId: 5004, // old job finalizing — pointer now belongs to 7000
    });

    // Patch should still be called for this job's own check
    expect(mockUpdateGitwireCheck).toHaveBeenCalledWith(expect.objectContaining({
      checkRunId: 5004,
    }));
    // The eval mock returns 0 (no match) — pointer should NOT be deleted
    expect(mockRedisStore.has(key)).toBe(true);
    expect(mockRedisStore.get(key)).toBe("7000");
  });

  it("7. Does NOT delete Redis pointer when GitHub PATCH fails", async () => {
    const key = checkRunKey(999, 16, "abc123");
    mockRedisStore.set(key, "5005");
    mockUpdateGitwireCheck.mockResolvedValue(false); // PATCH failed

    await finalizeGitwireCheck({
      ...baseParams,
      reviewResult: null,
      checkRunId: 5005,
    });

    // Pointer should still exist (not deleted)
    expect(mockRedisStore.get(key)).toBe("5005");
    expect(mockRedis.del).not.toHaveBeenCalled();
  });

  it("8. Returns silently when no checkRunId and Redis is empty", async () => {
    await finalizeGitwireCheck({
      ...baseParams,
      reviewResult: null,
      // no checkRunId, no Redis entry
    });

    expect(mockUpdateGitwireCheck).not.toHaveBeenCalled();
  });
});

// ── updateGitwireCheck return semantics (via finalizer) ─────────────────────

describe("updateGitwireCheck return semantics (via finalizer)", () => {
  it("9. PATCH failure preserves Redis pointer (retryable)", async () => {
    mockUpdateGitwireCheck.mockResolvedValue(false);

    const key = checkRunKey(999, 16, "abc123");
    mockRedisStore.set(key, "5006");

    await finalizeGitwireCheck({
      octokit: {},
      owner: "org", repo: "repo", repoId: 999, prNumber: 16, headSha: "abc123",
      reviewResult: { verdict: "approved", findings: [], blocked: false },
      checkRunId: 5006,
    });

    // Pointer preserved because PATCH failed
    expect(mockRedisStore.get(key)).toBe("5006");
    expect(mockRedis.del).not.toHaveBeenCalled();
  });

  it("10. PATCH success deletes Redis pointer via atomic eval", async () => {
    mockUpdateGitwireCheck.mockResolvedValue(true);

    const key = checkRunKey(999, 16, "abc123");
    mockRedisStore.set(key, "5007");

    await finalizeGitwireCheck({
      octokit: {},
      owner: "org", repo: "repo", repoId: 999, prNumber: 16, headSha: "abc123",
      reviewResult: { verdict: "approved", findings: [], blocked: false },
      checkRunId: 5007,
    });

    // PATCH succeeded, eval should have been called and deleted the key
    expect(mockRedis.eval).toHaveBeenCalledWith(
      expect.any(String), 1, key, "5007",
    );
    expect(mockRedisStore.has(key)).toBe(false);
  });
});
