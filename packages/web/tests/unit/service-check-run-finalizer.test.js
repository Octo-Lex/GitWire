// tests/unit/service-check-run-finalizer.test.js
// Regression test for the "stuck in queued" bug.
//
// The "GitWire" check run is created in the webhook route for every PR.
// When AI review is skipped (no config, disabled, dry-run, waiver, trigger filter),
// the phase4 worker must still finalize that check run.
//
// Before the fix, the check run ID was discarded and the check stayed in
// "queued" status forever, showing "GitWire — evaluating…" indefinitely.

import { jest } from "@jest/globals";

const mockRedisGet = jest.fn();
const mockRedisDel = jest.fn();
const mockUpdateCheck = jest.fn();

await jest.unstable_mockModule("../../src/lib/queue.js", () => ({
  redis: { get: mockRedisGet, del: mockRedisDel, setex: jest.fn() },
}));

await jest.unstable_mockModule("../../src/lib/checkStatus.js", () => ({
  updateGitwireCheck: mockUpdateCheck,
}));

await jest.unstable_mockModule("../../src/lib/logger.js", () => ({
  logger: { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const { finalizeGitwireCheck, checkRunKey } = await import("../../src/services/checkRunFinalizer.js");

describe("finalizeGitwireCheck", function () {

  const baseArgs = {
    owner: "acme",
    repo: "app",
    repoId: 123,
    prNumber: 42,
    headSha: "abc123",
    octokit: {},
  };

  beforeEach(function () {
    jest.clearAllMocks();
  });

  // ── Redis key format ─────────────────────────────────────────────────────

  it("builds correct Redis key", function () {
    expect(checkRunKey(123, 42, "abc123")).toBe("gitwire:check:123:42:abc123");
  });

  // ── No check run in Redis ────────────────────────────────────────────────

  it("does nothing when no check run ID in Redis", async function () {
    mockRedisGet.mockResolvedValue(null);
    await finalizeGitwireCheck({ ...baseArgs, reviewResult: null });
    expect(mockUpdateCheck).not.toHaveBeenCalled();
    expect(mockRedisDel).not.toHaveBeenCalled();
  });

  it("does nothing when check run ID is not a number", async function () {
    mockRedisGet.mockResolvedValue("not-a-number");
    await finalizeGitwireCheck({ ...baseArgs, reviewResult: null });
    expect(mockUpdateCheck).not.toHaveBeenCalled();
  });

  // ── Skipped review (null result) ─────────────────────────────────────────

  it("finalizes as neutral when reviewResult is null", async function () {
    mockRedisGet.mockResolvedValue("99999");
    await finalizeGitwireCheck({ ...baseArgs, reviewResult: null });
    expect(mockUpdateCheck).toHaveBeenCalledWith(
      expect.objectContaining({ checkRunId: 99999, conclusion: "neutral" })
    );
    expect(mockRedisDel).toHaveBeenCalledWith("gitwire:check:123:42:abc123");
  });

  // ── Review passed ────────────────────────────────────────────────────────

  it("finalizes as success when review passed", async function () {
    mockRedisGet.mockResolvedValue("99999");
    await finalizeGitwireCheck({
      ...baseArgs,
      reviewResult: { verdict: "approved", blocked: false, findings: [] },
    });
    expect(mockUpdateCheck).toHaveBeenCalledWith(
      expect.objectContaining({ checkRunId: 99999, conclusion: "success" })
    );
    expect(mockRedisDel).toHaveBeenCalled();
  });

  // ── Review blocked merge ─────────────────────────────────────────────────

  it("finalizes as failure when review blocked merge", async function () {
    mockRedisGet.mockResolvedValue("99999");
    await finalizeGitwireCheck({
      ...baseArgs,
      reviewResult: {
        verdict: "request_changes",
        blocked: true,
        findings: [{ title: "SQL injection" }, { title: "XSS" }],
      },
    });
    expect(mockUpdateCheck).toHaveBeenCalledWith(
      expect.objectContaining({ checkRunId: 99999, conclusion: "failure" })
    );
    const call = mockUpdateCheck.mock.calls[0][0];
    expect(call.summary).toContain("2 finding(s)");
  });

  // ── Review with findings but not blocked ─────────────────────────────────

  it("finalizes as success when review has findings but did not block", async function () {
    mockRedisGet.mockResolvedValue("99999");
    await finalizeGitwireCheck({
      ...baseArgs,
      reviewResult: { verdict: "needs_discussion", blocked: false, findings: [{ title: "Style" }] },
    });
    expect(mockUpdateCheck).toHaveBeenCalledWith(
      expect.objectContaining({ checkRunId: 99999, conclusion: "success" })
    );
  });

  // ── Cleanup ──────────────────────────────────────────────────────────────

  it("deletes Redis key after finalization", async function () {
    mockRedisGet.mockResolvedValue("88888");
    await finalizeGitwireCheck({ ...baseArgs, reviewResult: null });
    expect(mockRedisDel).toHaveBeenCalledTimes(1);
    expect(mockRedisDel).toHaveBeenCalledWith("gitwire:check:123:42:abc123");
  });
});
