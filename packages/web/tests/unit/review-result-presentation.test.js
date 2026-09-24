// tests/unit/review-result-presentation.test.js

import { beforeEach, describe, expect, it, jest } from "@jest/globals";

const mockQuery = jest.fn();
const mockWarn = jest.fn();

await jest.unstable_mockModule("../../src/lib/db.js", () => ({
  db: { query: mockQuery },
}));

await jest.unstable_mockModule("../../src/lib/logger.js", () => ({
  logger: { warn: mockWarn, info: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));

const { normalizeReviewResultForPresentation } = await import(
  "../../src/services/reviewResultPresentation.js"
);

const base = {
  repoId: 123,
  prNumber: 42,
  headSha: "abc123",
};

beforeEach(() => {
  jest.clearAllMocks();
});

describe("normalizeReviewResultForPresentation", () => {
  it("passes explicit review results through without consulting durable state", async () => {
    const result = { verdict: "approved", blocked: false, findings: [] };
    await expect(normalizeReviewResultForPresentation({ ...base, reviewResult: result }))
      .resolves.toBe(result);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("preserves a legitimate null skip when no review receipt exists", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await expect(normalizeReviewResultForPresentation({ ...base, reviewResult: null }))
      .resolves.toBeNull();
  });

  it("preserves null when the durable review receipt is not an error", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ verdict: null, summary: null, terminal_reason: null, publication_state: null }],
    });
    await expect(normalizeReviewResultForPresentation({ ...base, reviewResult: null }))
      .resolves.toBeNull();
  });

  it("converts a legacy null error receipt into a structured unavailable result", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{
        verdict: "error",
        summary: "Review timed out after 596.371s: claude review",
        terminal_reason: "error",
        publication_state: null,
      }],
    });

    await expect(normalizeReviewResultForPresentation({ ...base, reviewResult: null }))
      .resolves.toEqual({
        unavailable: true,
        verdict: "error",
        blocked: false,
        findings: [],
        reason: "error",
        error: "Review timed out after 596.371s: claude review",
      });

    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining("WHERE repo_id = $1 AND pr_number = $2 AND commit_sha = $3"),
      [123, 42, "abc123"]
    );
  });

  it("treats a terminally failed publication as unavailable even without verdict=error", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{
        verdict: null,
        summary: "A prior publication attempt failed.",
        terminal_reason: null,
        publication_state: "failed",
      }],
    });

    const result = await normalizeReviewResultForPresentation({ ...base, reviewResult: null });
    expect(result).toEqual(expect.objectContaining({
      unavailable: true,
      reason: "publication_failed",
      error: "A prior publication attempt failed.",
    }));
  });

  it("reports unavailable when durable outcome lookup itself fails", async () => {
    mockQuery.mockRejectedValueOnce(new Error("database unavailable"));

    const result = await normalizeReviewResultForPresentation({ ...base, reviewResult: null });
    expect(result).toEqual({
      unavailable: true,
      verdict: "error",
      blocked: false,
      findings: [],
      reason: "outcome_lookup_failed",
      error: "AI review outcome could not be verified from durable review state.",
    });
    expect(mockWarn).toHaveBeenCalledTimes(1);
  });
});
