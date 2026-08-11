// tests/unit/review-mutation-service.test.js
// Tests for RI-7: review mutation idempotency.
//
// Proves the frozen contract:
//   exactly one GitHub review mutation per review invocation
//   manual rerun creates separate invocation
//   worker retry does not
//   crash recovery (submitted → confirmed)

import { jest } from "@jest/globals";
import {
  MUTATION_STATE,
  computeInvocationId,
  createReviewMutationManager,
} from "../../src/services/reviewMutationService.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeMockRedis(storedState) {
  const store = new Map();
  const initialStateJson = storedState ? JSON.stringify(storedState) : null;
  return {
    get: jest.fn(async (key) => {
      if (store.has(key)) return store.get(key);
      if (initialStateJson && !store.has("__consumed__")) {
        store.set("__consumed__", "1");
        store.set(key, initialStateJson);
        return initialStateJson;
      }
      return null;
    }),
    setex: jest.fn(async (key, ttl, val) => { store.set(key, val); return "OK"; }),
    setnx: jest.fn(async (key, val) => {
      if (store.has(key)) return 0; // key exists — not set
      store.set(key, val);
      return 1; // key was set
    }),
    expire: jest.fn(async (key, ttl) => { return 1; }),
    del: jest.fn(async (key) => { store.delete(key); return 1; }),
    _store: store,
  };
}

function makeMockOctokit(existingReviews = []) {
  const postedReviews = [];
  let nextId = 1000;
  return {
    request: jest.fn(async (route, params) => {
      if (route.includes("POST") && route.includes("/reviews")) {
        const id = nextId++;
        const review = { id, ...params };
        postedReviews.push(review);
        return { data: { id, commit_id: params.commit_id } };
      }
      if (route.includes("GET") && route.includes("/reviews")) {
        return { data: existingReviews };
      }
      return { data: {} };
    }),
    _postedReviews: postedReviews,
  };
}

const BASE_PARAMS = {
  owner: "org",
  repo: "repo",
  prNumber: 42,
  headSha: "head123",
};

// ── Invocation ID ────────────────────────────────────────────────────────────

describe("RI-7: computeInvocationId", () => {

  it("is deterministic for the same inputs", () => {
    const id1 = computeInvocationId({ repoId: 999, prNumber: 42, headSha: "abc", logicalInvocation: "automatic" });
    const id2 = computeInvocationId({ repoId: 999, prNumber: 42, headSha: "abc", logicalInvocation: "automatic" });
    expect(id1).toBe(id2);
  });

  it("differs for different logical invocations (automatic vs manual)", () => {
    const auto = computeInvocationId({ repoId: 999, prNumber: 42, headSha: "abc", logicalInvocation: "automatic" });
    const manual = computeInvocationId({ repoId: 999, prNumber: 42, headSha: "abc", logicalInvocation: "manual-123" });
    expect(auto).not.toBe(manual);
  });

  it("differs for different head SHAs", () => {
    const sha1 = computeInvocationId({ repoId: 999, prNumber: 42, headSha: "aaa", logicalInvocation: "automatic" });
    const sha2 = computeInvocationId({ repoId: 999, prNumber: 42, headSha: "bbb", logicalInvocation: "automatic" });
    expect(sha1).not.toBe(sha2);
  });
});

// ── Mutation idempotency ────────────────────────────────────────────────────

describe("RI-7: exactly one review per invocation", () => {

  it("posts exactly one review on first call", async () => {
    const redis = makeMockRedis();
    const octokit = makeMockOctokit();
    const invocationId = computeInvocationId({ repoId: 999, prNumber: 42, headSha: "abc", logicalInvocation: "automatic" });
    const manager = createReviewMutationManager({
      redis, octokit, ...BASE_PARAMS, headSha: "abc", invocationId,
    });

    const result = await manager.submitReview({ event: "APPROVE", body: "LGTM", commit_id: "abc" });

    expect(result.action).toBe("created");
    expect(result.reviewId).toBeDefined();
    expect(octokit._postedReviews).toHaveLength(1);

    // State should be CONFIRMED
    const state = await manager.getMutationState();
    expect(state.state).toBe(MUTATION_STATE.CONFIRMED);
    expect(state.reviewId).toBe(result.reviewId);
  });

  it("returns existing review on retry (no second POST)", async () => {
    const invocationId = computeInvocationId({ repoId: 999, prNumber: 42, headSha: "abc", logicalInvocation: "automatic" });

    // Simulate a previous successful submission
    const redis = makeMockRedis({
      state: MUTATION_STATE.CONFIRMED,
      reviewId: 500,
      event: "APPROVE",
      timestamp: Date.now(),
    });
    const octokit = makeMockOctokit();

    const manager = createReviewMutationManager({
      redis, octokit, ...BASE_PARAMS, headSha: "abc", invocationId,
    });

    const result = await manager.submitReview({ event: "APPROVE", body: "LGTM", commit_id: "abc" });

    expect(result.action).toBe("recovered");
    expect(result.reviewId).toBe(500);
    expect(octokit._postedReviews).toHaveLength(0); // no POST!
  });

  it("recovers from SUBMITTED state (crash after POST, before confirm) — invocation-specific", async () => {
    const invocationId = computeInvocationId({ repoId: 999, prNumber: 42, headSha: "abc", logicalInvocation: "automatic" });

    // Simulate crash: POST was accepted but process died before confirmation
    const redis = makeMockRedis({
      state: MUTATION_STATE.SUBMITTED,
      reviewId: 777,
      event: "COMMENT",
      timestamp: Date.now(),
      invocationId,
    });

    // The recovery query finds a review containing THIS invocation's marker
    const octokit = makeMockOctokit([
      { id: 777, commit_id: "abc", user: { login: "gitwire-hq[bot]" }, body: "test\n\n<!-- gitwire-invocation:" + invocationId + " -->" },
    ]);

    const manager = createReviewMutationManager({
      redis, octokit, ...BASE_PARAMS, headSha: "abc", invocationId,
    });

    const result = await manager.submitReview({ event: "COMMENT", body: "test", commit_id: "abc" });

    expect(result.action).toBe("recovered");
    expect(result.reviewId).toBe(777);
    expect(octokit._postedReviews).toHaveLength(0);

    const state = await manager.getMutationState();
    expect(state.state).toBe(MUTATION_STATE.CONFIRMED);
  });

  it("recovers from PLANNED state (crash after POST, before SUBMITTED persisted)", async () => {
    // This is the frozen crash window: GitHub accepted POST, Redis still PLANNED
    const invocationId = computeInvocationId({ repoId: 999, prNumber: 42, headSha: "abc", logicalInvocation: "automatic" });

    const redis = makeMockRedis({
      state: MUTATION_STATE.PLANNED,
      reviewId: null,
      event: "APPROVE",
      timestamp: Date.now(),
      invocationId,
    });

    // Recovery finds the review with this invocation's marker
    const octokit = makeMockOctokit([
      { id: 888, commit_id: "abc", body: "LGTM\n\n<!-- gitwire-invocation:" + invocationId + " -->" },
    ]);

    const manager = createReviewMutationManager({
      redis, octokit, ...BASE_PARAMS, headSha: "abc", invocationId,
    });

    const result = await manager.submitReview({ event: "APPROVE", body: "LGTM", commit_id: "abc" });

    expect(result.action).toBe("recovered");
    expect(result.reviewId).toBe(888);
    expect(octokit._postedReviews).toHaveLength(0); // no duplicate POST
  });

  it("does NOT recover a different invocation's review at the same SHA", async () => {
    const invocationId = computeInvocationId({ repoId: 999, prNumber: 42, headSha: "abc", logicalInvocation: "automatic" });
    const otherInvocationId = computeInvocationId({ repoId: 999, prNumber: 42, headSha: "abc", logicalInvocation: "manual-123" });

    const redis = makeMockRedis({
      state: MUTATION_STATE.SUBMITTED,
      reviewId: null,
      event: "COMMENT",
      timestamp: Date.now(),
      invocationId,
    });

    // Existing reviews have a DIFFERENT invocation's marker
    const octokit = makeMockOctokit([
      { id: 999, commit_id: "abc", body: "other\n\n<!-- gitwire-invocation:" + otherInvocationId + " -->" },
      { id: 998, commit_id: "abc", body: "unrelated bot\n\nsome other content", user: { login: "codex-bot[bot]" } },
    ]);

    const manager = createReviewMutationManager({
      redis, octokit, ...BASE_PARAMS, headSha: "abc", invocationId,
    });

    const result = await manager.submitReview({ event: "COMMENT", body: "test", commit_id: "abc" });

    // Should NOT recover the other invocation's review — must POST a new one
    expect(result.action).toBe("created");
    expect(result.reviewId).not.toBe(999);
    expect(octokit._postedReviews).toHaveLength(1);
  });

  it("concurrent workers: SETNX prevents duplicate POST", async () => {
    const invocationId = computeInvocationId({ repoId: 999, prNumber: 42, headSha: "abc", logicalInvocation: "automatic" });
    const redis = makeMockRedis();
    const octokit = makeMockOctokit();

    const manager = createReviewMutationManager({
      redis, octokit, ...BASE_PARAMS, headSha: "abc", invocationId,
    });

    // First call succeeds
    const result1 = await manager.submitReview({ event: "APPROVE", body: "LGTM", commit_id: "abc" });
    expect(result1.action).toBe("created");

    // Simulate second concurrent worker: setnx will fail because key exists
    const manager2 = createReviewMutationManager({
      redis, octokit, ...BASE_PARAMS, headSha: "abc", invocationId,
    });

    // Second call should recover (state is CONFIRMED after first call)
    const result2 = await manager2.submitReview({ event: "APPROVE", body: "LGTM", commit_id: "abc" });
    expect(result2.action).toBe("recovered");
    expect(result2.reviewId).toBe(result1.reviewId);
    expect(octokit._postedReviews).toHaveLength(1); // still only one POST
  });

  it("manual rerun creates a separate invocation (may post a new review)", async () => {
    const redis = makeMockRedis();
    const octokit = makeMockOctokit();

    const autoInvocation = computeInvocationId({ repoId: 999, prNumber: 42, headSha: "abc", logicalInvocation: "automatic" });
    const manualInvocation = computeInvocationId({ repoId: 999, prNumber: 42, headSha: "abc", logicalInvocation: "manual-456" });

    expect(autoInvocation).not.toBe(manualInvocation);

    // Automatic review
    const autoManager = createReviewMutationManager({
      redis, octokit, ...BASE_PARAMS, headSha: "abc", invocationId: autoInvocation,
    });
    const autoResult = await autoManager.submitReview({ event: "APPROVE", body: "auto", commit_id: "abc" });

    // Manual rerun — separate invocation, separate record
    const manualManager = createReviewMutationManager({
      redis, octokit, ...BASE_PARAMS, headSha: "abc", invocationId: manualInvocation,
    });
    const manualResult = await manualManager.submitReview({ event: "COMMENT", body: "manual rerun", commit_id: "abc" });

    expect(autoResult.action).toBe("created");
    expect(manualResult.action).toBe("created"); // new POST is expected
    expect(octokit._postedReviews).toHaveLength(2); // two distinct reviews
    expect(autoResult.reviewId).not.toBe(manualResult.reviewId);
  });

  it("records FAILED state when POST fails", async () => {
    const redis = makeMockRedis();
    const octokit = {
      request: jest.fn().mockRejectedValue(new Error("GitHub API error")),
    };
    const invocationId = computeInvocationId({ repoId: 999, prNumber: 42, headSha: "abc", logicalInvocation: "automatic" });
    const manager = createReviewMutationManager({
      redis, octokit, ...BASE_PARAMS, headSha: "abc", invocationId,
    });

    await expect(manager.submitReview({ event: "APPROVE", body: "test" }))
      .rejects.toThrow("GitHub API error");

    const state = await manager.getMutationState();
    expect(state.state).toBe(MUTATION_STATE.FAILED);
    expect(state.error).toContain("GitHub API error");
  });
});
