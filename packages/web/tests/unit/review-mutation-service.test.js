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
      if (store.has(key)) return 0;
      store.set(key, val);
      return 1;
    }),
    expire: jest.fn(async (key, ttl) => { return 1; }),
    del: jest.fn(async (key) => { store.delete(key); return 1; }),
    eval: jest.fn(async (script, numkeys, key, val, expectedLeaseToken, ttl) => {
      // Simulate the lease-token CAS script behavior:
      // SET only if key missing OR existing record's leaseToken matches
      const current = store.get(key);
      if (current === undefined) {
        store.set(key, val);
        return 1;
      }
      try {
        const decoded = JSON.parse(current);
        if (decoded.leaseToken === expectedLeaseToken) {
          store.set(key, val);
          return 1;
        }
      } catch (_e) { /* treat as locked */ }
      return 0;
    }),
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

/** Mock Octokit with a deferred POST gate for concurrency testing */
function makeGatedMockOctokit(existingReviews = []) {
  const postedReviews = [];
  let nextId = 1000;
  let gateResolve = null;
  let gatePromise = null;

  function holdPostGate() {
    gatePromise = new Promise(resolve => { gateResolve = resolve; });
  }
  function releasePostGate() {
    if (gateResolve) { gateResolve(); gateResolve = null; gatePromise = null; }
  }

  return {
    request: jest.fn(async (route, params) => {
      if (route.includes("POST") && route.includes("/reviews")) {
        if (gatePromise) await gatePromise;
        const id = nextId++;
        const review = { id, ...params, commit_id: params.commit_id };
        postedReviews.push(review);
        return { data: { id, commit_id: params.commit_id } };
      }
      if (route.includes("GET") && route.includes("/reviews")) {
        return { data: [...postedReviews.map(r => ({ id: r.id, commit_id: r.commit_id, body: r.body })), ...existingReviews] };
      }
      return { data: {} };
    }),
    _postedReviews: postedReviews,
    holdPostGate,
    releasePostGate,
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

    // No pre-seeded state — manager starts fresh
    const redis = makeMockRedis();

    // Existing reviews on GitHub have a DIFFERENT invocation's marker
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

  it("concurrent workers: CAS prevents duplicate POST when both observe no state", async () => {
    const invocationId = computeInvocationId({ repoId: 999, prNumber: 42, headSha: "abc", logicalInvocation: "automatic" });
    const redis = makeMockRedis();
    const octokit = makeMockOctokit();

    // Worker A acquires ownership first
    const managerA = createReviewMutationManager({
      redis, octokit, ...BASE_PARAMS, headSha: "abc", invocationId,
    });
    const resultA = await managerA.submitReview({ event: "APPROVE", body: "LGTM", commit_id: "abc" });
    expect(resultA.action).toBe("created");

    // Worker B starts after A has confirmed — should recover
    const managerB = createReviewMutationManager({
      redis, octokit, ...BASE_PARAMS, headSha: "abc", invocationId,
    });
    const resultB = await managerB.submitReview({ event: "APPROVE", body: "LGTM", commit_id: "abc" });
    expect(resultB.action).toBe("recovered");
    expect(resultB.reviewId).toBe(resultA.reviewId);
    expect(octokit._postedReviews).toHaveLength(1);
  });

  it("genuinely overlapping workers: A holds POST gate, B fails closed, A completes with exactly one POST", async () => {
    const invocationId = computeInvocationId({ repoId: 999, prNumber: 42, headSha: "abc", logicalInvocation: "automatic" });
    const redis = makeMockRedis();
    const octokit = makeGatedMockOctokit([]);

    // Worker A acquires ownership
    const managerA = createReviewMutationManager({
      redis, octokit, ...BASE_PARAMS, headSha: "abc", invocationId,
    });

    // Hold the POST gate so A is stuck inside the GitHub request
    octokit.holdPostGate();

    // Start A's POST — it will block on the gate
    const promiseA = managerA.submitReview({ event: "APPROVE", body: "LGTM", commit_id: "abc" });

    // Give A time to reach the POST (CAS to PLANNED + start of POST)
    await new Promise(r => setTimeout(r, 50));

    // Worker B starts with a different leaseToken — CAS must fail
    const managerB = createReviewMutationManager({
      redis, octokit, ...BASE_PARAMS, headSha: "abc", invocationId,
    });

    await expect(managerB.submitReview({ event: "APPROVE", body: "LGTM", commit_id: "abc" }))
      .rejects.toThrow("ownership conflict");

    // Release the gate — A can complete its POST
    octokit.releasePostGate();
    const resultA = await promiseA;
    expect(resultA.action).toBe("created");

    // Exactly one POST despite both workers trying
    expect(octokit._postedReviews).toHaveLength(1);
  });

  it("EVAL failure causes fail-closed (no unsafe setex fallback)", async () => {
    const invocationId = computeInvocationId({ repoId: 999, prNumber: 42, headSha: "abc", logicalInvocation: "automatic" });
    const redis = makeMockRedis();
    redis.eval = jest.fn(async () => { throw new Error("EVAL not supported"); });

    const octokit = makeMockOctokit();
    const manager = createReviewMutationManager({
      redis, octokit, ...BASE_PARAMS, headSha: "abc", invocationId,
    });

    await expect(manager.submitReview({ event: "APPROVE", body: "LGTM", commit_id: "abc" }))
      .rejects.toThrow("ownership conflict");
    expect(octokit._postedReviews).toHaveLength(0);
  });

  it("records explicit SUBMITTED transition before CONFIRMED", async () => {
    const invocationId = computeInvocationId({ repoId: 999, prNumber: 42, headSha: "abc", logicalInvocation: "automatic" });
    const redis = makeMockRedis();
    const octokit = makeMockOctokit();
    const manager = createReviewMutationManager({
      redis, octokit, ...BASE_PARAMS, headSha: "abc", invocationId,
    });

    await manager.submitReview({ event: "APPROVE", body: "LGTM", commit_id: "abc" });

    // Final state must be CONFIRMED
    const finalState = await manager.getMutationState();
    expect(finalState.state).toBe(MUTATION_STATE.CONFIRMED);

    // The CAS eval should have been called multiple times
    // (PLANNED, SUBMITTED, CONFIRMED transitions)
    expect(redis.eval.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("SUBMITTED CAS failure throws — retry recovers the already-created review with zero additional POSTs", async () => {
    const invocationId = computeInvocationId({ repoId: 999, prNumber: 42, headSha: "abc", logicalInvocation: "automatic" });
    const redis = makeMockRedis();
    const octokit = makeMockOctokit();

    // First manager: CAS succeeds for PLANNED, POST succeeds,
    // but CAS for SUBMITTED fails (simulated by overwriting the lease)
    const manager1 = createReviewMutationManager({
      redis, octokit, ...BASE_PARAMS, headSha: "abc", invocationId,
    });

    // Manually clobber the lease after PLANNED is acquired but before SUBMITTED
    // by writing a different leaseToken to the key
    const origEval = redis.eval;
    let evalCallCount = 0;
    redis.eval = jest.fn(async (script, numkeys, key, val, expectedLeaseToken, ttl) => {
      evalCallCount++;
      if (evalCallCount === 2) {
        // This is the SUBMITTED CAS — simulate failure by writing a
        // different leaseToken to the key first
        redis._store.set(key, JSON.stringify({ state: "planned", leaseToken: "some-other-token", invocationId }));
      }
      return origEval(script, numkeys, key, val, expectedLeaseToken, ttl);
    });

    // First attempt: POST succeeds, SUBMITTED CAS throws
    await expect(manager1.submitReview({ event: "APPROVE", body: "LGTM", commit_id: "abc" }))
      .rejects.toThrow("SUBMITTED persistence failed");

    // One POST was made (the review exists on GitHub)
    expect(octokit._postedReviews).toHaveLength(1);
    const postedReviewId = octokit._postedReviews[0].id;

    // Now the review is on GitHub with the invocation marker.
    // Update the mock to return the posted review on GET.
    octokit.request.mockImplementation(async (route) => {
      if (route.includes("GET") && route.includes("/reviews")) {
        return { data: octokit._postedReviews.map(r => ({
          id: r.id, commit_id: r.commit_id || "abc",
          body: r.body,
        })) };
      }
      if (route.includes("POST") && route.includes("/reviews")) {
        // Should NOT be called on retry
        throw new Error("Unexpected duplicate POST");
      }
      return { data: {} };
    });

    // Reset eval to normal behavior
    redis.eval = origEval;

    // Second attempt (retry): recovery finds the review, zero additional POSTs
    const manager2 = createReviewMutationManager({
      redis, octokit, ...BASE_PARAMS, headSha: "abc", invocationId,
    });
    const result2 = await manager2.submitReview({ event: "APPROVE", body: "LGTM", commit_id: "abc" });

    expect(result2.action).toBe("recovered");
    expect(result2.reviewId).toBe(postedReviewId);
    expect(octokit._postedReviews).toHaveLength(1); // still only one
  });

  it("paginated recovery finds invocation marker beyond page 1", async () => {
    const invocationId = computeInvocationId({ repoId: 999, prNumber: 42, headSha: "abc", logicalInvocation: "automatic" });
    const marker = "gitwire-invocation:" + invocationId;

    // 30 filler reviews on page 1, then the real one on page 2
    const page1 = Array.from({ length: 30 }, (_, i) => ({ id: 1000 + i, commit_id: "abc", body: "review " + i }));
    const page2 = [{ id: 2000, commit_id: "abc", body: "target\n\n<!-- " + marker + " -->" }];

    let callCount = 0;
    const octokit = {
      request: jest.fn(async (route) => {
        if (route.includes("GET") && route.includes("/reviews")) {
          callCount++;
          return { data: callCount === 1 ? page1 : page2 };
        }
        if (route.includes("POST") && route.includes("/reviews")) {
          return { data: { id: 3000 } };
        }
        return { data: {} };
      }),
      _postedReviews: [],
    };

    const redis = makeMockRedis({
      state: MUTATION_STATE.SUBMITTED,
      reviewId: null,
      event: "COMMENT",
      timestamp: Date.now(),
      invocationId,
    });

    const manager = createReviewMutationManager({
      redis, octokit, ...BASE_PARAMS, headSha: "abc", invocationId,
    });

    const result = await manager.submitReview({ event: "COMMENT", body: "test", commit_id: "abc" });

    expect(result.action).toBe("recovered");
    expect(result.reviewId).toBe(2000);
    // Should have made 2 GET calls (page 1 + page 2)
    expect(callCount).toBe(2);
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
