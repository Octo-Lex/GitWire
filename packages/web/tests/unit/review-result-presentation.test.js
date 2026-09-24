// tests/unit/review-result-presentation.test.js

import { describe, expect, it, jest } from "@jest/globals";

const {
  createReviewPresentationTracker,
  normalizeReviewResultForPresentation,
} = await import("../../src/services/reviewResultPresentation.js");

function fakeOctokit() {
  let nextId = 100;
  const calls = [];
  return {
    calls,
    async request(route, params = {}) {
      calls.push({ route, params });
      if (route === "POST /repos/{owner}/{repo}/check-runs") {
        return { data: { id: nextId++ } };
      }
      return { data: {} };
    },
  };
}

function createReviewCheck(tracker) {
  return tracker.octokit.request(
    "POST /repos/{owner}/{repo}/check-runs",
    { owner: "o", repo: "r", name: "GitWire AI Review", head_sha: "abc123" }
  );
}

function finishReviewCheck(tracker, checkRunId, { conclusion = "neutral", title, summary }) {
  return tracker.octokit.request(
    "PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}",
    {
      owner: "o",
      repo: "r",
      check_run_id: checkRunId,
      status: "completed",
      conclusion,
      output: { title, summary },
    }
  );
}

describe("review result presentation", () => {
  it("passes explicit review results through without consulting invocation state", () => {
    const result = { verdict: "approved", blocked: false, findings: [] };
    expect(normalizeReviewResultForPresentation({ reviewResult: result, invocation: null }))
      .toBe(result);
  });

  it("preserves a null skip when reviewPR returned before attempting its dedicated check", () => {
    const tracker = createReviewPresentationTracker(fakeOctokit());
    expect(normalizeReviewResultForPresentation({
      reviewResult: null,
      invocation: tracker.snapshot(),
    })).toBeNull();
  });

  it("fails safe when the invocation-specific review check could not be created", async () => {
    const octokit = {
      request: jest.fn(async () => { throw new Error("GitHub unavailable"); }),
    };
    const tracker = createReviewPresentationTracker(octokit);

    await expect(createReviewCheck(tracker)).rejects.toThrow("GitHub unavailable");

    expect(normalizeReviewResultForPresentation({
      reviewResult: null,
      invocation: tracker.snapshot(),
    })).toEqual({
      unavailable: true,
      verdict: "error",
      blocked: false,
      findings: [],
      reason: "review_check_unavailable",
      error: "GitHub unavailable",
    });
  });

  it("preserves the explicit no-reviewable-files null contract", async () => {
    const tracker = createReviewPresentationTracker(fakeOctokit());
    const created = await createReviewCheck(tracker);
    await finishReviewCheck(tracker, created.data.id, {
      conclusion: "success",
      title: "✅ No reviewable files changed",
      summary: "All changed files are excluded by the ignore patterns.",
    });

    expect(normalizeReviewResultForPresentation({
      reviewResult: null,
      invocation: tracker.snapshot(),
    })).toBeNull();
  });

  it("preserves the explicit no-files-admitted null contract", async () => {
    const tracker = createReviewPresentationTracker(fakeOctokit());
    const created = await createReviewCheck(tracker);
    await finishReviewCheck(tracker, created.data.id, {
      title: "⚠️ AI review not run — no files admitted",
      summary: "Changed files exist but none were admitted.",
    });

    expect(normalizeReviewResultForPresentation({
      reviewResult: null,
      invocation: tracker.snapshot(),
    })).toBeNull();
  });

  it("converts an invocation-specific parse failure into unavailable with its actual summary", async () => {
    const tracker = createReviewPresentationTracker(fakeOctokit());
    const created = await createReviewCheck(tracker);
    await finishReviewCheck(tracker, created.data.id, {
      title: "⚠️ AI review: could not parse response",
      summary: "Review completed but the response format was unexpected. Strategy: none",
    });

    expect(normalizeReviewResultForPresentation({
      reviewResult: null,
      invocation: tracker.snapshot(),
    })).toEqual({
      unavailable: true,
      verdict: "error",
      blocked: false,
      findings: [],
      reason: "review_unavailable",
      error: "Review completed but the response format was unexpected. Strategy: none",
    });
  });

  it("fails safe when a null result has no verified terminal patch for its exact check", async () => {
    const tracker = createReviewPresentationTracker(fakeOctokit());
    await createReviewCheck(tracker);

    expect(normalizeReviewResultForPresentation({
      reviewResult: null,
      invocation: tracker.snapshot(),
    })).toEqual(expect.objectContaining({
      unavailable: true,
      reason: "review_outcome_unverified",
    }));
  });

  it("ignores terminal patches for a different check-run id", async () => {
    const tracker = createReviewPresentationTracker(fakeOctokit());
    const created = await createReviewCheck(tracker);
    await finishReviewCheck(tracker, created.data.id + 999, {
      title: "✅ No reviewable files changed",
      summary: "Unrelated check",
    });

    expect(normalizeReviewResultForPresentation({
      reviewResult: null,
      invocation: tracker.snapshot(),
    })).toEqual(expect.objectContaining({
      unavailable: true,
      reason: "review_outcome_unverified",
    }));
  });

  it("keeps concurrent same-head invocation outcomes isolated by immutable check-run id", async () => {
    const sharedOctokit = fakeOctokit();
    const first = createReviewPresentationTracker(sharedOctokit);
    const second = createReviewPresentationTracker(sharedOctokit);

    const firstCheck = await createReviewCheck(first);
    const secondCheck = await createReviewCheck(second);

    // Interleave terminalization in the opposite order. Shared ai_reviews
    // timestamps cannot safely represent this shape; per-invocation check ids can.
    await finishReviewCheck(second, secondCheck.data.id, {
      conclusion: "success",
      title: "✅ No reviewable files changed",
      summary: "No reviewable files.",
    });
    await finishReviewCheck(first, firstCheck.data.id, {
      title: "⚠️ AI review: validation errors",
      summary: "Review completed but findings could not be validated.",
    });

    expect(normalizeReviewResultForPresentation({
      reviewResult: null,
      invocation: first.snapshot(),
    })).toEqual(expect.objectContaining({
      unavailable: true,
      error: "Review completed but findings could not be validated.",
    }));

    expect(normalizeReviewResultForPresentation({
      reviewResult: null,
      invocation: second.snapshot(),
    })).toBeNull();
  });
});
