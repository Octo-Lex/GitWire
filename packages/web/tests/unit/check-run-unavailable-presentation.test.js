// tests/unit/check-run-unavailable-presentation.test.js
// Defect-sensitive coverage for #247: a completed-but-unavailable AI review
// must never collapse into the benign "no review needed" presentation.

import { beforeEach, describe, expect, it, jest } from "@jest/globals";

const mockRedisGet = jest.fn().mockResolvedValue(null);
const mockRedisDel = jest.fn().mockResolvedValue(1);
const mockRedisSetex = jest.fn().mockResolvedValue("OK");
const mockRedisEval = jest.fn().mockResolvedValue(1);
const mockUpdateCheck = jest.fn().mockResolvedValue(true);

await jest.unstable_mockModule("../../src/lib/queue.js", () => ({
  redis: { get: mockRedisGet, del: mockRedisDel, setex: mockRedisSetex, eval: mockRedisEval },
}));
await jest.unstable_mockModule("../../src/lib/checkStatus.js", () => ({
  updateGitwireCheck: mockUpdateCheck,
}));
await jest.unstable_mockModule("../../src/lib/logger.js", () => ({
  logger: { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const { finalizeGitwireCheck } = await import("../../src/services/checkRunFinalizer.js");

const baseArgs = {
  owner: "acme",
  repo: "app",
  repoId: 123,
  prNumber: 42,
  headSha: "abc123",
  checkRunId: 99999,
  octokit: {},
};

beforeEach(() => {
  jest.clearAllMocks();
  mockUpdateCheck.mockResolvedValue(true);
  mockRedisEval.mockResolvedValue(1);
});

describe("top-level GitWire unavailable presentation", () => {
  it("renders structured unavailable distinctly and includes the failure reason", async () => {
    await finalizeGitwireCheck({
      ...baseArgs,
      reviewResult: {
        unavailable: true,
        verdict: "error",
        blocked: false,
        findings: [],
        reason: "error",
        error: "Review timed out after 596.371s: claude review",
      },
    });

    const call = mockUpdateCheck.mock.calls[0][0];
    expect(call.conclusion).toBe("neutral");
    expect(call.title).toBe("GitWire — AI review unavailable");
    expect(call.summary).toContain("Review timed out after 596.371s: claude review");
    expect(call.summary).not.toContain("not configured");
    expect(call.summary).not.toContain("skipped");
  });

  it("keeps a legitimate bare-null skip as no review needed", async () => {
    await finalizeGitwireCheck({ ...baseArgs, reviewResult: null });
    const call = mockUpdateCheck.mock.calls[0][0];
    expect(call.conclusion).toBe("neutral");
    expect(call.title).toBe("GitWire — no review needed");
    expect(call.summary).toContain("not configured");
  });

  it("keeps not_activated distinct from unavailable", async () => {
    await finalizeGitwireCheck({
      ...baseArgs,
      reviewResult: {
        skipped: true,
        reason: "not_activated",
        activationUrl: "https://gitwire.example/dashboard/intelligence",
      },
    });
    const call = mockUpdateCheck.mock.calls[0][0];
    expect(call.conclusion).toBe("neutral");
    expect(call.title).toBe("GitWire — AI review not activated");
    expect(call.summary).toContain("Intelligence dashboard");
    expect(call.title).not.toContain("unavailable");
  });
});
