// tests/unit/triage-mutation-recovery.test.js
// Tests for the triage mutation-recovery paths added in Commit 2.
//
// Covers required cases 7-11:
//   7.  previous marked triage comment is updated/reused, not duplicated
//   8.  ambiguous marker prevents another comment
//   9.  completed label action prevents duplicate GitHub label mutation
//  10.  successful retry after prior failure completes the lifecycle
//  11.  post-mutation/complete-marker-failure produces exactly one logical mutation

import { jest } from "@jest/globals";

// ── Mock state ──────────────────────────────────────────────────────────────
const mockBeginOperation = jest.fn();
const mockCompleteOperation = jest.fn();
const mockAbandonOperation = jest.fn();
const mockBuildTriageOperationKey = jest.fn(({ targetType, repoId, targetId, action }) =>
  `repo:${repoId}:${targetType}:${targetId}:${action}`);
const mockGetConfigForRepo = jest.fn();
const mockIsWaived = jest.fn();
const mockLogDecision = jest.fn();
const mockNotifyTriage = jest.fn();
const mockGetInstallationClient = jest.fn();
const mockAnthropicCreate = jest.fn();
const mockPropose = jest.fn();
const mockApprove = jest.fn();
const mockExecute = jest.fn();
const mockSucceed = jest.fn();
const mockFail = jest.fn();
const mockFindCompletedTriageAction = jest.fn();
const mockPostMarkedComment = jest.fn();
const mockSaveTriage = jest.fn();
const mockDetectDuplicates = jest.fn();

// ── Mock modules ────────────────────────────────────────────────────────────
await jest.unstable_mockModule("../../config/index.js", () => ({
  config: {
    anthropic: { apiKey: "test-key", baseURL: "http://test" },
    redis: { url: "redis://test" },
    github: { appId: "123", privateKey: "test" },
  },
}));

await jest.unstable_mockModule("../../src/lib/logger.js", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

await jest.unstable_mockModule("../../src/lib/db.js", () => ({
  db: { query: jest.fn(async () => ({ rows: [] })) },
}));

await jest.unstable_mockModule("../../src/lib/queue.js", () => ({
  redis: { setex: jest.fn(), get: jest.fn(), del: jest.fn(), eval: jest.fn() },
  createWorker: jest.fn(),
  QUEUES: { TRIAGE: "triage" },
}));

await jest.unstable_mockModule("../../src/lib/github.js", () => ({ getInstallationClient: mockGetInstallationClient }));
await jest.unstable_mockModule("../../src/lib/githubWrapper.js", () => ({ wrapOctokit: (c) => c }));

await jest.unstable_mockModule("../../src/services/idempotencyService.js", () => ({
  checkAndMark: jest.fn().mockResolvedValue(true),
  beginOperation: mockBeginOperation,
  completeOperation: mockCompleteOperation,
  abandonOperation: mockAbandonOperation,
  buildTriageOperationKey: mockBuildTriageOperationKey,
}));

await jest.unstable_mockModule("../../src/services/configService.js", () => ({ getConfigForRepo: mockGetConfigForRepo }));
await jest.unstable_mockModule("../../src/services/waiverService.js", () => ({ isWaived: mockIsWaived }));
await jest.unstable_mockModule("../../src/services/decisionLogService.js", () => ({ logDecision: mockLogDecision }));
await jest.unstable_mockModule("../../src/services/actionStateMachine.js", () => ({
  propose: mockPropose, approve: mockApprove, execute: mockExecute,
  succeed: mockSucceed, fail: mockFail, cancel: jest.fn(),
  findCompletedTriageAction: mockFindCompletedTriageAction,
}));
await jest.unstable_mockModule("../../src/services/telegramNotifyService.js", () => ({ notifyTriage: mockNotifyTriage }));
await jest.unstable_mockModule("../../src/services/issueService.js", () => ({ issueService: { saveTriage: mockSaveTriage } }));
await jest.unstable_mockModule("../../src/services/duplicateDetectionService.js", () => ({
  detectDuplicates: mockDetectDuplicates,
}));
await jest.unstable_mockModule("../../src/lib/commentMarkers.js", () => ({
  postMarkedComment: mockPostMarkedComment,
  buildMarker: jest.fn((type, id) => `<!-- gitwire:${type}:${id} -->`),
  buildMarkedComment: jest.fn((type, id, body) => `<!-- gitwire:${type}:${id} -->\n${body}`),
  findCommentByMarker: jest.fn(),
}));

await jest.unstable_mockModule("../../src/services/auth/authorize.js", () => ({
  authorize: jest.fn().mockResolvedValue({ allowed: true, principalId: "p1", code: "ok" }),
}));
await jest.unstable_mockModule("../../src/services/auth/decisionLog.js", () => ({
  logDecision: jest.fn(), countRecentDisagreements: jest.fn().mockResolvedValue(0),
}));
await jest.unstable_mockModule("../../src/services/auth/principalResolver.js", () => ({
  getInstallationPrincipal: jest.fn().mockResolvedValue({ id: "p1", principal_type: "installation", status: "active", auth_epoch: 0 }),
  getSystemPrincipal: jest.fn().mockResolvedValue(null),
  getPrincipalById: jest.fn().mockResolvedValue(null),
  principalValidityCode: jest.fn(() => "valid"),
}));
await jest.unstable_mockModule("../../src/services/triageFailureService.js", () => ({
  classifyTriageFailure: jest.fn((e) => ({ failureClass: "unknown", retryable: true, statusCode: null, safeMessage: "test", failedAt: "2026-01-01T00:00:00Z" })),
  isPermanentFailure: jest.fn(() => false),
  sanitizeForRetention: jest.fn((c) => ({ ...c, attempts: 1, firstFailedAt: c.failedAt, latestFailedAt: c.failedAt })),
}));

await jest.unstable_mockModule("@anthropic-ai/sdk", () => ({
  default: class { messages = { create: mockAnthropicCreate }; },
}));

const { triageIssue } = await import("../../src/workers/triageWorker.js");

function buildIssuePayload(overrides = {}) {
  return {
    payload: {
      action: "opened",
      installation: { id: 11111 },
      repository: { id: 999, full_name: "org/repo", name: "repo", owner: { login: "org" } },
      issue: { id: 555, number: 42, title: "Bug", body: "desc", user: { login: "user" }, labels: [] },
      ...overrides,
    },
  };
}

function mockOctokit() {
  return {
    request: jest.fn().mockResolvedValue({ data: [{ name: "bug" }, { name: "invalid" }] }),
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockBeginOperation.mockResolvedValue({ acquired: true, alreadyComplete: false, token: "lease-1" });
  mockCompleteOperation.mockResolvedValue(true);
  mockAbandonOperation.mockResolvedValue(true);
  mockGetConfigForRepo.mockResolvedValue({});
  mockIsWaived.mockResolvedValue(null);
  mockLogDecision.mockResolvedValue(undefined);
  mockNotifyTriage.mockResolvedValue(null);
  mockSaveTriage.mockResolvedValue({});
  mockDetectDuplicates.mockResolvedValue({ duplicates: [], related: [] });
  mockFindCompletedTriageAction.mockResolvedValue(null);
  mockAnthropicCreate.mockResolvedValue({
    content: [{ text: JSON.stringify({
      type: "bug", priority: "low", labels: ["bug"],
      needs_more_info: true, duplicate_hint: null, triage_summary: "test summary",
    }) }],
  });
  mockPropose.mockResolvedValue({ id: "a1" });
  mockApprove.mockResolvedValue({});
  mockExecute.mockResolvedValue({});
  mockSucceed.mockResolvedValue({});
  mockFail.mockResolvedValue({});
  mockPostMarkedComment.mockResolvedValue({ action: "created", comment_id: 9999 });
  mockGetInstallationClient.mockResolvedValue(mockOctokit());
});

describe("Mutation recovery (cases 7-9, 11)", () => {
  it("7. previous marked triage comment is updated/reused, not duplicated", async () => {
    // postMarkedComment returns action:"updated" — simulating a prior comment exists
    mockPostMarkedComment.mockResolvedValue({ action: "updated", comment_id: 8888 });

    await triageIssue(buildIssuePayload());

    // postMarkedComment should have been called exactly once (the marker path)
    expect(mockPostMarkedComment).toHaveBeenCalledTimes(1);
    // The action should succeed with the EXISTING comment_id (8888), not a new one
    expect(mockSucceed).toHaveBeenCalledWith("a1", expect.objectContaining({ githubId: 8888, action: "updated" }));
  });

  it("8. ambiguous marker prevents another comment (throws, no duplicate)", async () => {
    mockPostMarkedComment.mockResolvedValue({
      action: "blocked",
      reason: "marker_ambiguous",
      detail: { matchCount: 2 },
    });

    await expect(triageIssue(buildIssuePayload())).rejects.toThrow(/ambiguous/);

    // The job threw, so abandonOperation should have been called (lease released)
    expect(mockAbandonOperation).toHaveBeenCalled();
    // No succeed call for the comment action (it never got there)
    // completeOperation should NOT have been called (failure path)
    expect(mockCompleteOperation).not.toHaveBeenCalled();
  });

  it("9. completed label action prevents duplicate GitHub label mutation", async () => {
    // Simulate a prior successful label action for the same repo+issue+labels
    mockFindCompletedTriageAction.mockResolvedValue({ id: 777, status: "succeeded" });

    const payload = buildIssuePayload();
    await triageIssue(payload);

    // findCompletedTriageAction should have been called for the label action
    expect(mockFindCompletedTriageAction).toHaveBeenCalledWith(expect.objectContaining({
      repoFullName: "org/repo",
      targetType: "issue",
      targetNumber: 42,
    }));

    // No new label propose/execute should have occurred (recovered as no-op)
    expect(mockPropose).not.toHaveBeenCalledWith(expect.objectContaining({ actionType: "add-label" }));

    // A recovery decision should have been logged
    const recoveryCall = mockLogDecision.mock.calls.find(
      c => c[0]?.source === "triage-recovery" && c[0]?.decision === "succeeded",
    );
    expect(recoveryCall).toBeTruthy();

    // completeOperation should still fire (the overall triage succeeded)
    expect(mockCompleteOperation).toHaveBeenCalled();
  });

  it("11. post-mutation / complete-marker-failure → retry produces exactly one logical label mutation", async () => {
    // First attempt: label mutation succeeds, but completeOperation fails
    mockCompleteOperation.mockRejectedValueOnce(new Error("Redis ECONNREFUSED"));

    const payload = buildIssuePayload();
    // First attempt throws (completeOperation failed)
    await expect(triageIssue(payload)).rejects.toThrow("Redis ECONNREFUSED");
    // The label mutation DID happen (propose+execute+succeed were called)
    expect(mockPropose).toHaveBeenCalledWith(expect.objectContaining({ actionType: "add-label" }));

    // Now simulate the retry: the prior label action exists (from attempt 1),
    // so the dedup guard should prevent a second mutation.
    mockFindCompletedTriageAction.mockResolvedValue({ id: 777, status: "succeeded" });
    mockCompleteOperation.mockResolvedValueOnce(true); // this retry succeeds

    jest.clearAllMocks();
    mockBeginOperation.mockResolvedValue({ acquired: true, alreadyComplete: false, token: "lease-2" });
    mockGetInstallationClient.mockResolvedValue(mockOctokit());
    mockGetConfigForRepo.mockResolvedValue({});
    mockAnthropicCreate.mockResolvedValue({
      content: [{ text: JSON.stringify({
        type: "bug", priority: "low", labels: ["bug"],
        needs_more_info: false, duplicate_hint: null, triage_summary: "test",
      }) }],
    });
    mockNotifyTriage.mockResolvedValue(null);
    mockSaveTriage.mockResolvedValue({});
    mockDetectDuplicates.mockResolvedValue({ duplicates: [], related: [] });
    mockPostMarkedComment.mockResolvedValue({ action: "updated", comment_id: 8888 });

    await triageIssue(payload);

    // The retry must NOT have proposed a new label action (dedup guard fired)
    expect(mockPropose).not.toHaveBeenCalledWith(expect.objectContaining({ actionType: "add-label" }));
    // completeOperation succeeded on this attempt
    expect(mockCompleteOperation).toHaveBeenCalledWith("triage", expect.any(String), "lease-2");
  });
});

describe("Lifecycle recovery (case 10)", () => {
  it("10. successful retry after prior failure completes the lifecycle", async () => {
    // Simulate: first attempt fails (LLM error), second attempt succeeds fully.
    mockAnthropicCreate.mockRejectedValueOnce(Object.assign(
      new Error("500 Internal Server Error"), { status: 500, type: "api_error" },
    ));

    const payload = buildIssuePayload();

    // First attempt: LLM fails → abandon lease, throw
    await expect(triageIssue(payload)).rejects.toThrow("500");
    expect(mockAbandonOperation).toHaveBeenCalledWith("triage", expect.any(String), "lease-1");
    expect(mockCompleteOperation).not.toHaveBeenCalled();

    // Reset for retry: lease reacquires, LLM succeeds
    jest.clearAllMocks();
    mockBeginOperation.mockResolvedValue({ acquired: true, alreadyComplete: false, token: "lease-2" });
    mockGetInstallationClient.mockResolvedValue(mockOctokit());
    mockGetConfigForRepo.mockResolvedValue({});
    mockIsWaived.mockResolvedValue(null);
    mockNotifyTriage.mockResolvedValue(null);
    mockSaveTriage.mockResolvedValue({});
    mockDetectDuplicates.mockResolvedValue({ duplicates: [], related: [] });
    mockFindCompletedTriageAction.mockResolvedValue(null);
    mockPostMarkedComment.mockResolvedValue({ action: "created", comment_id: 9999 });
    mockCompleteOperation.mockResolvedValue(true);
    mockPropose.mockResolvedValue({ id: "a1" });
    mockApprove.mockResolvedValue({});
    mockExecute.mockResolvedValue({});
    mockSucceed.mockResolvedValue({});
    mockAnthropicCreate.mockResolvedValue({
      content: [{ text: JSON.stringify({
        type: "bug", priority: "low", labels: ["bug"],
        needs_more_info: false, duplicate_hint: null, triage_summary: "ok",
      }) }],
    });

    await triageIssue(payload);

    // The retry must have acquired a fresh lease and completed successfully
    expect(mockBeginOperation).toHaveBeenCalled();
    expect(mockCompleteOperation).toHaveBeenCalledWith("triage", expect.any(String), "lease-2");
    expect(mockAbandonOperation).not.toHaveBeenCalled();
  });
});
