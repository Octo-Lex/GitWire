// tests/unit/service-check-run-finalizer.test.js
// Regression test for the "stuck in queued" bug.
//
// The "GitWire" check run is created in the webhook route for every PR.
// When AI review is skipped (no config, disabled, dry-run, waiver, trigger filter),
// the phase4 worker must still finalize that check run.
//
// Before the fix, the check run ID was discarded and the check stayed in
// "queued" status forever, showing "GitWire — evaluating…" indefinitely.
//
// Updated for the boolean success contract: updateGitwireCheck returns
// true/false, and the finalizer uses atomic compare-and-delete (Lua eval).

import { jest } from "@jest/globals";

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
    // Default: PATCH succeeds, Lua eval succeeds (simulates pointer matched)
    mockUpdateCheck.mockResolvedValue(true);
    mockRedisEval.mockResolvedValue(1);
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
  });

  // ── Structured skip: not_activated (PF-B1-01) ─────────────────────────────

  it("finalizes with actionable activation message when review skipped due to not_activated", async function () {
    mockRedisGet.mockResolvedValue("99999");
    await finalizeGitwireCheck({
      ...baseArgs,
      reviewResult: { skipped: true, reason: "not_activated", activationUrl: "https://gitwire.erlab.uk/intelligence" },
    });
    expect(mockUpdateCheck).toHaveBeenCalledWith(
      expect.objectContaining({ checkRunId: 99999, conclusion: "neutral" })
    );
    const call = mockUpdateCheck.mock.calls[0][0];
    expect(call.title).toContain("not activated");
    expect(call.summary).toContain("Intelligence dashboard");
    expect(call.summary).toContain("https://gitwire.erlab.uk/intelligence");
    expect(call.summary).not.toContain("not configured for this repository");
  });

  // ── Review passed ────────────────────────────────────────────────────────

  it("finalizes as success for an approved review", async function () {
    mockRedisGet.mockResolvedValue("99999");
    await finalizeGitwireCheck({
      ...baseArgs,
      reviewResult: { verdict: "approved", blocked: false, findings: [] },
    });
    expect(mockUpdateCheck).toHaveBeenCalledWith(
      expect.objectContaining({ checkRunId: 99999, conclusion: "success" })
    );
  });

  // ── Check-run truthfulness (v1.2.1 / Track A) ────────────────────────────
  // PR #205 is the pinned regression: judgment NEEDS_DISCUSSION, integrity
  // INCOMPLETE, authority ADVISORY must NEVER surface as "review passed".

  function presentationTitle(reviewResult) {
    const call = mockUpdateCheck.mock.calls[0][0];
    return call.title;
  }

  it("#205 shape: NEEDS_DISCUSSION + INCOMPLETE + ADVISORY → incomplete title, never 'review passed', conclusion success", async function () {
    mockRedisGet.mockResolvedValue("99999");
    await finalizeGitwireCheck({
      ...baseArgs,
      reviewResult: {
        verdict: "needs_discussion", blocked: false, findings: [{ title: "x" }],
        publication: {
          judgment: "NEEDS_DISCUSSION", publishedOutcome: "INCOMPLETE",
          integrityState: "INCOMPLETE", authorityState: "ADVISORY",
          githubReviewEvent: "COMMENT",
        },
      },
    });
    const call = mockUpdateCheck.mock.calls[0][0];
    expect(call.conclusion).toBe("success");
    expect(call.title).toContain("incomplete");
    expect(call.title).not.toContain("review passed");
  });

  it("COMPLETE + APPROVE → 'AI review: approve' title, conclusion success", async function () {
    mockRedisGet.mockResolvedValue("99999");
    await finalizeGitwireCheck({
      ...baseArgs,
      reviewResult: {
        verdict: "approved", blocked: false, findings: [],
        publication: { judgment: "APPROVE", integrityState: "COMPLETE", publishedOutcome: "APPROVE", authorityState: "ADVISORY" },
      },
    });
    const call = mockUpdateCheck.mock.calls[0][0];
    expect(call.conclusion).toBe("success");
    expect(call.title).toContain("approve");
    expect(call.title).not.toContain("review passed");
  });

  it("legacy result without publication (approved) → truthful approve title, not 'review passed'", async function () {
    mockRedisGet.mockResolvedValue("99999");
    await finalizeGitwireCheck({
      ...baseArgs,
      reviewResult: { verdict: "approved", blocked: false, findings: [] },
    });
    const call = mockUpdateCheck.mock.calls[0][0];
    expect(call.conclusion).toBe("success");
    expect(call.title).not.toContain("review passed");
    expect(call.title).toContain("approve");
  });

  it("COMPLETE + NEEDS_DISCUSSION → 'needs discussion' title, conclusion success", async function () {
    mockRedisGet.mockResolvedValue("99999");
    await finalizeGitwireCheck({
      ...baseArgs,
      reviewResult: {
        verdict: "needs_discussion", blocked: false, findings: [{ title: "x" }],
        publication: { judgment: "NEEDS_DISCUSSION", integrityState: "COMPLETE", publishedOutcome: "NEEDS_DISCUSSION", authorityState: "ADVISORY" },
      },
    });
    const call = mockUpdateCheck.mock.calls[0][0];
    expect(call.conclusion).toBe("success");
    expect(call.title).toContain("needs discussion");
    expect(call.title).not.toContain("review passed");
  });

  it("COMPLETE + REQUEST_CHANGES unblocked → 'changes requested' title, conclusion success", async function () {
    mockRedisGet.mockResolvedValue("99999");
    await finalizeGitwireCheck({
      ...baseArgs,
      reviewResult: {
        verdict: "request_changes", blocked: false, findings: [{ title: "x" }],
        publication: { judgment: "REQUEST_CHANGES", integrityState: "COMPLETE", publishedOutcome: "REQUEST_CHANGES", authorityState: "ADVISORY" },
      },
    });
    const call = mockUpdateCheck.mock.calls[0][0];
    expect(call.conclusion).toBe("success");
    expect(call.title).toContain("changes requested");
    expect(call.title).not.toContain("review passed");
  });

  it("INCOMPLETE takes precedence over judgment in the short title (REQUEST_CHANGES + INCOMPLETE)", async function () {
    mockRedisGet.mockResolvedValue("99999");
    await finalizeGitwireCheck({
      ...baseArgs,
      reviewResult: {
        verdict: "request_changes", blocked: false, findings: [],
        publication: { judgment: "REQUEST_CHANGES", integrityState: "INCOMPLETE", publishedOutcome: "REQUEST_CHANGES", authorityState: "ADVISORY" },
      },
    });
    const call = mockUpdateCheck.mock.calls[0][0];
    expect(call.title).toContain("incomplete");
    expect(call.title).not.toContain("changes requested");
    expect(call.title).not.toContain("review passed");
  });

  it("blocked semantics unchanged: failure + 'review blocked merge'", async function () {
    mockRedisGet.mockResolvedValue("99999");
    await finalizeGitwireCheck({
      ...baseArgs,
      reviewResult: {
        verdict: "request_changes", blocked: true, findings: [{ title: "x" }],
        publication: { judgment: "REQUEST_CHANGES", integrityState: "COMPLETE", publishedOutcome: "REQUEST_CHANGES", authorityState: "POLICY_BLOCKED" },
      },
    });
    const call = mockUpdateCheck.mock.calls[0][0];
    expect(call.conclusion).toBe("failure");
    expect(call.title).toContain("review blocked merge");
  });

  // ── Review superseded (advisory v1.2 WP-3) ──────────────────────────────

  it("finalizes as neutral superseded when the PR head moved during review", async function () {
    mockRedisGet.mockResolvedValue("99999");
    await finalizeGitwireCheck({
      ...baseArgs,
      reviewResult: {
        verdict: "superseded",
        superseded: true,
        blocked: false,
        findings: [],
        reviewedHeadSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        currentHeadSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      },
    });
    const call = mockUpdateCheck.mock.calls[0][0];
    expect(call.conclusion).toBe("neutral");
    expect(call.title).toContain("superseded");
    expect(call.summary).toContain("aaaaaaaaaaaa");
    expect(call.summary).toContain("bbbbbbbbbbbb");
    expect(call.summary).toContain("No review was published");
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

  // ── Cleanup (via atomic Lua compare-and-delete) ──────────────────────────

  it("uses atomic compare-and-delete to clean up Redis pointer", async function () {
    mockRedisGet.mockResolvedValue("88888");
    await finalizeGitwireCheck({ ...baseArgs, reviewResult: null });
    // Lua eval should be called for atomic compare-and-delete
    expect(mockRedisEval).toHaveBeenCalledTimes(1);
    expect(mockRedisEval).toHaveBeenCalledWith(
      expect.any(String),    // script
      1,                     // numkeys
      "gitwire:check:123:42:abc123",  // key
      "88888",               // expected value (String(resolvedCheckRunId))
    );
  });
});
