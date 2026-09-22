// tests/unit/manual-run-recovery-notice.test.js
// Bounded UX correction (2026-09-22): a manual `/gitwire run review` whose
// worker discovers an already-published review for the exact head recovers
// it by design and posts nothing — while the command ack promised results.
// The worker must now post an explanatory notice for manual-origin jobs
// ONLY. Recovery/queue/idempotency semantics are unchanged, and a failed
// notice must never fail the job.
//
// Covers the PR #52 (ChatGPT-Web2API) incident class: 16:19:16Z request
// recovered in 5s but read as "not processed" because the surface was silent.

import { jest } from "@jest/globals";

// ── Mocks (same recipe as check-run-worker-lifecycle.test.js) ────────────────
const mockStore = new Map();
const mockRedis = {
  get: jest.fn(async (k) => mockStore.get(k) ?? null),
  setex: jest.fn(async (k, ttl, v) => { mockStore.set(k, v); }),
  del: jest.fn(async (k) => { mockStore.delete(k); }),
};
const mockFinalizeGitwireCheck = jest.fn();
const mockReviewPR = jest.fn();
const mockCheckAndMark = jest.fn();
const mockEmitWorkerEvent = jest.fn();
const mockGetConfigForRepo = jest.fn();
const mockIsPillarEnabled = jest.fn();
const mockIsDryRun = jest.fn();
const mockShouldTrigger = jest.fn();
const mockIsWaived = jest.fn();
const mockOctokitRequest = jest.fn();
const mockGetInstallationClient = jest.fn(async () => ({ request: mockOctokitRequest }));
const mockAdoptWorker = jest.fn(async () => ({ context: { principalId: "p1" } }));

jest.unstable_mockModule("../../src/lib/queue.js", () => ({
  redis: mockRedis,
  createWorker: jest.fn(),
  createQueue: jest.fn(),
  QUEUES: { PHASE4: "phase4" },
}));

jest.unstable_mockModule("../../src/services/checkRunFinalizer.js", () => ({
  finalizeGitwireCheck: mockFinalizeGitwireCheck,
  getRetryOutcome: jest.fn().mockResolvedValue(null),
  clearRetryOutcome: jest.fn(),
  replayCheckConclusion: jest.fn().mockResolvedValue(true),
}));

jest.unstable_mockModule("../../src/services/aiReviewService.js", () => ({
  reviewPR: mockReviewPR,
  supersedePublishedReviewForPr: jest.fn().mockResolvedValue({ action: "noop", reason: "no_published_review" }),
  isRetryableReviewFailure: jest.fn().mockResolvedValue(false),
}));

jest.unstable_mockModule("../../src/services/idempotencyService.js", () => ({
  checkAndMark: mockCheckAndMark,
}));

jest.unstable_mockModule("../../src/services/workerEvents.js", () => ({
  emitWorkerEvent: mockEmitWorkerEvent,
}));

jest.unstable_mockModule("../../src/services/configService.js", () => ({
  getConfigForRepo: mockGetConfigForRepo,
}));

jest.unstable_mockModule("@gitwire/rules", () => ({
  isPillarEnabled: mockIsPillarEnabled,
  isDryRun: mockIsDryRun,
  shouldTrigger: mockShouldTrigger,
}));

jest.unstable_mockModule("../../src/services/waiverService.js", () => ({
  isWaived: mockIsWaived,
}));

jest.unstable_mockModule("../../src/lib/github.js", () => ({
  getInstallationClient: mockGetInstallationClient,
}));

jest.unstable_mockModule("../../src/lib/githubWrapper.js", () => ({
  wrapOctokit: (c) => c,
}));

jest.unstable_mockModule("../../src/services/auth/workerAdoption.js", () => ({
  adoptWorker: mockAdoptWorker,
  workerPrincipalId: () => "p1",
}));

jest.unstable_mockModule("../../src/services/auditTrailService.js", () => ({
  Trail: { appendEntry: jest.fn(), aiDecision: jest.fn(), reviewGateBlock: jest.fn() },
  exportNightly: jest.fn(),
}));

jest.unstable_mockModule("@gitwire/core", () => ({
  QUEUES: { PHASE4: "phase4" },
}));

jest.unstable_mockModule("../../src/lib/logger.js", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const { startPhase4Worker } = await import("../../src/workers/phase4Worker.js");

const COMMENT_ROUTE = "POST /repos/{owner}/{repo}/issues/{issue_number}/comments";

function commentPosts() {
  return mockOctokitRequest.mock.calls.filter(([route]) => route === COMMENT_ROUTE);
}

async function processReviewJob(jobData) {
  const { createWorker } = await import("../../src/lib/queue.js");
  startPhase4Worker();
  const processorArg = createWorker.mock.calls[createWorker.mock.calls.length - 1][1];
  return processorArg({
    name: "ai-review",
    data: jobData,
    attemptsMade: 0,
    attemptsStarted: 0,
  });
}

beforeEach(() => {
  mockStore.clear();
  jest.clearAllMocks();
  mockGetConfigForRepo.mockResolvedValue({});
  mockIsPillarEnabled.mockReturnValue(true);
  mockShouldTrigger.mockReturnValue(true);
  mockIsWaived.mockResolvedValue(null);
  mockIsDryRun.mockReturnValue(false);
  mockCheckAndMark.mockResolvedValue(true);
  mockEmitWorkerEvent.mockResolvedValue(undefined);
  mockFinalizeGitwireCheck.mockResolvedValue(true);
  mockOctokitRequest.mockResolvedValue({ data: {} });
});

const PR = { number: 52, head: { sha: "611f53a" }, base: { ref: "main" }, user: { login: "Alajmah" }, id: 4242 };
const REPOSITORY = { id: 999, full_name: "Octo-Lex/ChatGPT-Web2API", name: "ChatGPT-Web2API", owner: { login: "Octo-Lex" } };
const INSTALLATION = { id: 11111 };

const RECOVERED_RESULT = {
  verdict: "needs_discussion",
  recovered: true,
  reviewId: 5272356562,
  blocked: false,
  findings: [],
  publication: { publishedOutcome: "NEEDS DISCUSSION", publicationAllowed: false },
};

describe("manual-run recovery notice (bounded UX correction)", () => {
  test("manual-origin recovery posts the already-published notice with review link", async () => {
    mockReviewPR.mockResolvedValue(RECOVERED_RESULT);

    await processReviewJob({ pr: PR, repository: REPOSITORY, installation: INSTALLATION, origin: "manual-run" });

    const posts = commentPosts();
    expect(posts).toHaveLength(1);
    const { owner, repo, issue_number, body } = posts[0][1];
    expect(owner).toBe("Octo-Lex");
    expect(repo).toBe("ChatGPT-Web2API");
    expect(issue_number).toBe(52);
    expect(body).toContain("A review is already published for this head");
    expect(body).toContain("NEEDS DISCUSSION");
    expect(body).toContain("#pullrequestreview-5272356562");

    // Pipeline unaffected: the recovered result still finalizes normally.
    const successCalls = mockFinalizeGitwireCheck.mock.calls.filter(
      ([args]) => args.reviewResult && !args.errorContext
    );
    expect(successCalls).toHaveLength(1);
    expect(successCalls[0][0].reviewResult.recovered).toBe(true);
  });

  test("automatic-origin recovery stays silent (no behavior change)", async () => {
    mockReviewPR.mockResolvedValue(RECOVERED_RESULT);

    await processReviewJob({ pr: PR, repository: REPOSITORY, installation: INSTALLATION });

    expect(commentPosts()).toHaveLength(0);
    expect(mockFinalizeGitwireCheck.mock.calls.filter(([a]) => a.reviewResult)).toHaveLength(1);
  });

  test("fresh manual run (no recovery) posts no notice", async () => {
    mockReviewPR.mockResolvedValue({ verdict: "approved", blocked: false, findings: [] });

    await processReviewJob({ pr: PR, repository: REPOSITORY, installation: INSTALLATION, origin: "manual-run" });

    expect(commentPosts()).toHaveLength(0);
  });

  test("notice failure never fails the job", async () => {
    mockReviewPR.mockResolvedValue(RECOVERED_RESULT);
    mockOctokitRequest.mockRejectedValue(new Error("secondary rate limit"));

    await expect(
      processReviewJob({ pr: PR, repository: REPOSITORY, installation: INSTALLATION, origin: "manual-run" })
    ).resolves.toBeUndefined();

    expect(mockFinalizeGitwireCheck.mock.calls.filter(([a]) => a.reviewResult)).toHaveLength(1);
  });
});
