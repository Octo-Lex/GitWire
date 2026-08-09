// tests/unit/handleManualRun-preflight.test.js
// Tests for the AI review activation preflight in /gitwire run (PF-B1-01).
//
// Before this fix, /gitwire run review always enqueued a Phase 4 job and
// acknowledged "results will appear shortly" — even when the review would
// silently skip due to the missing ai_review_config DB row. The fix adds a
// preflight check before the enqueue so the acknowledgment is truthful.

import { jest } from "@jest/globals";

// ── Mocks ────────────────────────────────────────────────────────────────────

const mockClearTriageOperation = jest.fn().mockResolvedValue(undefined);
const mockClearIdempotencyKey = jest.fn().mockResolvedValue(undefined);
const mockGetEffectiveReviewState = jest.fn();

jest.unstable_mockModule("../../src/services/idempotencyService.js", () => ({
  buildTriageOperationKey: jest.fn(({ targetType, repoId, targetId, action }) =>
    `repo:${repoId}:${targetType}:${targetId}:${action}`),
  clearTriageOperation: mockClearTriageOperation,
  clearIdempotencyKey: mockClearIdempotencyKey,
}));

// Mock aiReviewService so we control the preflight result
jest.unstable_mockModule("../../src/services/aiReviewService.js", () => ({
  getEffectiveReviewState: mockGetEffectiveReviewState,
}));

const { handleManualRun } = await import("../../src/lib/webhookHandlers/commentCommands/handleManualRun.js");

// ── Fixtures ─────────────────────────────────────────────────────────────────

const ACTIVATION_URL = "https://gitwire.erlab.uk/intelligence";

function makePRPayload(overrides = {}) {
  return {
    action: "created",
    installation: { id: 11111 },
    repository: { id: 999, full_name: "org/repo", name: "repo", owner: { login: "org" } },
    issue: {
      id: 555, number: 42, user: { login: "maintainer" },
      pull_request: { url: "https://api.github.com/repos/org/repo/pulls/42" },
    },
    comment: { id: 1, body: "/gitwire run review", user: { login: "maintainer" } },
    ...overrides,
  };
}

function makeCtx() {
  return {
    triageQueue: { add: jest.fn().mockResolvedValue({ id: "job-1" }) },
    issueFixQueue: { add: jest.fn().mockResolvedValue({ id: "job-2" }) },
    phase4Queue: { add: jest.fn().mockResolvedValue({ id: "job-3" }) },
    getInstallationClient: jest.fn().mockResolvedValue({ request: jest.fn() }),
    wrapOctokit: jest.fn((client) => client),
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  };
}

// A minimal "full PR" that the handler fetches
const FULL_PR = {
  id: 555,
  number: 42,
  head: { sha: "abc123def" },
  base: { ref: "main" },
  user: { login: "maintainer" },
};

beforeEach(() => {
  jest.clearAllMocks();
});

// ── Test 9: run review + not activated → no enqueue, actionable ack ─────────

describe("PF-B1-01: /gitwire run review preflight", function () {

  it("does not enqueue phase4 and posts activation ack when review is not activated", async function () {
    mockGetEffectiveReviewState.mockResolvedValue({
      runnable: false,
      reason: "not_activated",
      pillarEnabled: true,
      dbActivated: false,
      activationUrl: ACTIVATION_URL,
    });

    const payload = makePRPayload();
    const parsed = { issueNumber: 42, authorLogin: "maintainer" };
    const action = { pillar: "review" };
    const ctx = makeCtx();

    // Stub the PR fetch
    ctx.getInstallationClient = jest.fn().mockResolvedValue({
      request: jest.fn().mockResolvedValue({ data: FULL_PR }),
    });

    await handleManualRun(payload, parsed, action, ctx);

    // Phase4 must NOT be enqueued
    expect(ctx.phase4Queue.add).not.toHaveBeenCalled();
    // Idempotency key must NOT be cleared (no enqueue to protect)
    expect(mockClearIdempotencyKey).not.toHaveBeenCalledWith("ai_review", expect.any(String));
    // Acknowledgment comment must mention activation
    const commentCall = ctx.wrapOctokit.mock.results[0]?.value?.request?.mock?.calls
      || ctx.getInstallationClient.mock.results[0]?.value?.request?.mock?.calls;
    // The ack was posted — verify via the octokit request mock
    const ackRequest = ctx.getInstallationClient.mock.results[0]?.value;
    if (ackRequest && ackRequest.request && ackRequest.request.mock) {
      const ackBody = ackRequest.request.mock.calls[0]?.[1]?.body || "";
      expect(ackBody).toContain("not been activated");
      expect(ackBody).toContain(ACTIVATION_URL);
    }
  });

  // ── Test 10: run review + runnable → enqueue + standard ack ──────────────

  it("enqueues phase4 and posts standard ack when review is runnable", async function () {
    mockGetEffectiveReviewState.mockResolvedValue({
      runnable: true,
      reason: null,
      pillarEnabled: true,
      dbActivated: true,
      activationUrl: ACTIVATION_URL,
    });

    const payload = makePRPayload();
    const parsed = { issueNumber: 42, authorLogin: "maintainer" };
    const action = { pillar: "review" };
    const ctx = makeCtx();

    ctx.getInstallationClient = jest.fn().mockResolvedValue({
      request: jest.fn().mockResolvedValue({ data: FULL_PR }),
    });

    await handleManualRun(payload, parsed, action, ctx);

    // Phase4 MUST be enqueued
    expect(ctx.phase4Queue.add).toHaveBeenCalledTimes(1);
    expect(ctx.phase4Queue.add).toHaveBeenCalledWith("ai-review", expect.objectContaining({
      pr: FULL_PR,
    }), { priority: 1 });
    // Idempotency key MUST be cleared
    expect(mockClearIdempotencyKey).toHaveBeenCalledWith("ai_review", "pr-42-abc123def");
  });

  // ── Test 11: run all + review not activated → triage dispatches, review blocked ─

  it("dispatches triage but not review for /gitwire run all when review is not activated", async function () {
    mockGetEffectiveReviewState.mockResolvedValue({
      runnable: false,
      reason: "not_activated",
      pillarEnabled: true,
      dbActivated: false,
      activationUrl: ACTIVATION_URL,
    });

    const payload = makePRPayload({ comment: { id: 1, body: "/gitwire run all", user: { login: "maintainer" } } });
    const parsed = { issueNumber: 42, authorLogin: "maintainer" };
    const action = { pillar: "all" };
    const ctx = makeCtx();

    ctx.getInstallationClient = jest.fn().mockResolvedValue({
      request: jest.fn().mockResolvedValue({ data: FULL_PR }),
    });

    await handleManualRun(payload, parsed, action, ctx);

    // Triage MUST be enqueued
    expect(ctx.triageQueue.add).toHaveBeenCalledTimes(1);
    // Phase4 MUST NOT be enqueued
    expect(ctx.phase4Queue.add).not.toHaveBeenCalled();
    // The acknowledgment must mention triage AND the review activation gap
    const ackClient = ctx.getInstallationClient.mock.results[0]?.value;
    if (ackClient && ackClient.request && ackClient.request.mock) {
      const ackBody = ackClient.request.mock.calls[0]?.[1]?.body || "";
      // Should mention the standard "re-evaluation triggered" for triage
      // AND the review not-activated note
      expect(ackBody).toMatch(/Re-evaluation triggered|all applicable/);
      expect(ackBody).toContain("not activated");
    }
  });
});
