// tests/unit/triage-auto-comment.test.js
// Tests for PF-A1-01: triage auto_comment semantics fix.
//
// The defect: auto_comment:true was documented as "Post triage summary as
// comment" but the code gated the comment behind needs_more_info ||
// duplicate_hint, so normal issues got labels but no visible comment.
//
// The fix: when auto_comment is enabled (the default), every successfully
// triaged issue receives exactly one marker-backed summary comment. The
// comment footer no longer claims labels were applied (truthful for
// auto_label:false repos).

import { jest } from "@jest/globals";

// ── Mock state ──────────────────────────────────────────────────────────────
const mockCheckAndMark = jest.fn().mockResolvedValue(true);
const mockBeginOperation = jest.fn().mockResolvedValue(true);
const mockCompleteOperation = jest.fn().mockResolvedValue(true);
const mockAbandonOperation = jest.fn().mockResolvedValue(undefined);
const mockBuildTriageOperationKey = jest.fn(({ targetType, repoId, targetId, action }) =>
  `repo:${repoId}:${targetType}:${targetId}:${action}`);
const mockGetConfigForRepo = jest.fn();
const mockIsWaived = jest.fn().mockResolvedValue(null);
const mockLogDecision = jest.fn().mockResolvedValue(undefined);
const mockNotifyTriage = jest.fn().mockResolvedValue(undefined);
const mockGetInstallationClient = jest.fn();
const mockAnthropicCreate = jest.fn();
const mockPostMarkedComment = jest.fn().mockResolvedValue({ action: "created", comment_id: 999 });

const mockPropose = jest.fn().mockResolvedValue({ id: 1 });
const mockApprove = jest.fn().mockResolvedValue(undefined);
const mockExecute = jest.fn().mockResolvedValue(undefined);
const mockSucceed = jest.fn().mockResolvedValue(undefined);
const mockFail = jest.fn().mockResolvedValue(undefined);

// ── Mock modules ────────────────────────────────────────────────────────────

await jest.unstable_mockModule("../../config/index.js", () => ({
  config: {
    anthropic: { apiKey: "test-key", baseURL: "http://test" },
    redis: { url: "redis://test" },
    github: { appId: "123", privateKey: "test" },
  },
}));

await jest.unstable_mockModule("../../src/lib/logger.js", () => ({
  logger: {
    info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
    child: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
  },
}));

await jest.unstable_mockModule("../../src/lib/db.js", () => ({
  db: { query: jest.fn(async () => ({ rows: [] })) },
}));

await jest.unstable_mockModule("../../src/services/auth/authorize.js", () => ({
  authorize: jest.fn().mockResolvedValue({
    allowed: true, code: "permission_granted", principalId: "inst-principal-uuid",
    permission: "issue:update", resource: { type: "repository" },
    matchedAssignmentId: null, matchedScopeType: null, policyVersion: "level1",
    authenticationMethod: "webhook_hmac", detail: null,
  }),
}));

await jest.unstable_mockModule("../../src/services/auth/decisionLog.js", () => ({
  logDecision: mockLogDecision,
  countRecentDisagreements: jest.fn().mockResolvedValue(0),
}));

await jest.unstable_mockModule("../../src/services/auth/principalResolver.js", () => ({
  getInstallationPrincipal: jest.fn().mockResolvedValue({
    id: "inst-principal-uuid", principal_type: "installation",
    display_name: "test-inst", status: "active", auth_epoch: 0,
    github_user_id: null, installation_id: 11111,
  }),
  getSystemPrincipal: jest.fn().mockResolvedValue(null),
  getPrincipalById: jest.fn().mockResolvedValue(null),
  principalValidityCode: jest.fn(() => "valid"),
}));

await jest.unstable_mockModule("../../src/lib/queue.js", () => ({
  redis: { setex: jest.fn(), get: jest.fn(), del: jest.fn() },
  createWorker: jest.fn(),
  QUEUES: { TRIAGE: "triage" },
}));

await jest.unstable_mockModule("../../src/lib/github.js", () => ({
  getInstallationClient: mockGetInstallationClient,
}));

await jest.unstable_mockModule("../../src/lib/githubWrapper.js", () => ({
  wrapOctokit: (client) => client,
}));

await jest.unstable_mockModule("../../src/services/idempotencyService.js", () => ({
  checkAndMark: mockCheckAndMark,
  beginOperation: mockBeginOperation,
  completeOperation: mockCompleteOperation,
  abandonOperation: mockAbandonOperation,
  buildTriageOperationKey: mockBuildTriageOperationKey,
}));

await jest.unstable_mockModule("../../src/services/configService.js", () => ({
  getConfigForRepo: mockGetConfigForRepo,
}));

await jest.unstable_mockModule("../../src/services/waiverService.js", () => ({
  isWaived: mockIsWaived,
}));

await jest.unstable_mockModule("../../src/services/decisionLogService.js", () => ({
  logDecision: mockLogDecision,
}));

await jest.unstable_mockModule("../../src/services/actionStateMachine.js", () => ({
  propose: mockPropose,
  approve: mockApprove,
  execute: mockExecute,
  succeed: mockSucceed,
  fail: mockFail,
  cancel: jest.fn(),
  findCompletedTriageAction: jest.fn().mockResolvedValue(null),
}));

await jest.unstable_mockModule("../../src/services/triageFailureService.js", () => ({
  classifyTriageFailure: jest.fn((e) => ({ failureClass: "unknown", retryable: true, statusCode: null, safeMessage: "test", failedAt: "2026-01-01T00:00:00Z" })),
  isPermanentFailure: jest.fn(() => false),
  sanitizeForRetention: jest.fn((c) => ({ ...c, attempts: 1, firstFailedAt: c.failedAt, latestFailedAt: c.failedAt })),
}));

await jest.unstable_mockModule("../../src/lib/commentMarkers.js", () => ({
  postMarkedComment: mockPostMarkedComment,
  buildMarker: jest.fn((t, id) => `<!-- gitwire:${t}:${id} -->`),
  buildMarkedComment: jest.fn((t, id, b) => `<!-- gitwire:${t}:${id} -->\n${b}`),
  findCommentByMarker: jest.fn(),
}));

await jest.unstable_mockModule("../../src/services/telegramNotifyService.js", () => ({
  notifyTriage: mockNotifyTriage,
}));

await jest.unstable_mockModule("@anthropic-ai/sdk", () => ({
  default: class {
    messages = { create: mockAnthropicCreate };
  },
}));

// ── Import after mocks ──────────────────────────────────────────────────────
const { triageIssue } = await import("../../src/workers/triageWorker.js");

// ── Fixtures ────────────────────────────────────────────────────────────────

function makeIssuePayload(overrides = {}) {
  return {
    payload: {
      action: "opened",
      issue: {
        id: 555, number: 42, title: "Bug in calculator",
        body: "The subtract function returns wrong results.",
        user: { login: "contributor" },
        labels: [],
        state: "open",
      },
      repository: {
        id: 999, full_name: "org/repo", name: "repo",
        owner: { login: "org" },
      },
      installation: { id: 11111 },
      ...overrides,
    },
  };
}

// Claude returns a normal triage classification (no needs_more_info, no duplicate)
function mockClaudeNormal() {
  mockAnthropicCreate.mockResolvedValue({
    content: [{
      text: JSON.stringify({
        type: "bug",
        priority: "high",
        triage_summary: "The subtract function incorrectly uses + instead of -.",
        labels: ["bug"],
        needs_more_info: false,
        duplicate_hint: null,
      }),
    }],
    usage: { input_tokens: 100, output_tokens: 50 },
  });
}

// Claude returns a needs_more_info classification
function mockClaudeNeedsMoreInfo() {
  mockAnthropicCreate.mockResolvedValue({
    content: [{
      text: JSON.stringify({
        type: "question",
        priority: "medium",
        triage_summary: "Issue lacks reproduction steps.",
        labels: ["needs-info"],
        needs_more_info: true,
        duplicate_hint: null,
      }),
    }],
    usage: { input_tokens: 100, output_tokens: 50 },
  });
}

function makeOctokit() {
  return {
    request: jest.fn().mockImplementation((method, params) => {
      // Return appropriate responses based on the API method
      if (method.includes("GET") && method.includes("/issues/")) {
        return Promise.resolve({ data: { number: 42, title: "Bug", body: "text", labels: [], state: "open", user: { login: "contributor" } } });
      }
      if (method.includes("GET") && method.includes("/git/trees")) {
        return Promise.resolve({ data: { tree: [] } });
      }
      if (method.includes("GET") && method.includes("/labels")) {
        return Promise.resolve({ data: [{ name: "bug" }, { name: "needs-info" }] });
      }
      // POST labels, POST comments, etc.
      return Promise.resolve({ data: {} });
    }),
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockCheckAndMark.mockResolvedValue(true);
  mockBeginOperation.mockResolvedValue({ acquired: true, alreadyComplete: false, token: "lease-token" });
  mockCompleteOperation.mockResolvedValue(true);
  mockPostMarkedComment.mockResolvedValue({ action: "created", comment_id: 999 });
  mockGetInstallationClient.mockResolvedValue(makeOctokit());
  mockGetConfigForRepo.mockResolvedValue({
    pillars: {
      triage: { enabled: true, auto_label: true, auto_comment: true, duplicate_detection: false },
    },
  });
  mockPropose.mockResolvedValue({ id: "action-1" });
  mockApprove.mockResolvedValue({});
  mockExecute.mockResolvedValue({});
  mockSucceed.mockResolvedValue({});
  mockFail.mockResolvedValue({});
  mockNotifyTriage.mockResolvedValue(null);
});

// ── Tests ───────────────────────────────────────────────────────────────────

describe("PF-A1-01: triage auto_comment semantics", () => {

  // 1. Normal issue + auto_comment:true → one summary comment
  it("posts a triage summary comment for a normal issue when auto_comment is enabled", async () => {
    mockClaudeNormal();

    await triageIssue(makeIssuePayload());

    expect(mockPostMarkedComment).toHaveBeenCalledTimes(1);
    const callArgs = mockPostMarkedComment.mock.calls[0];
    // The 7th argument (index 6) is the comment body
    const commentBody = callArgs[6];
    expect(commentBody).toContain("Automated triage");
    expect(commentBody).toContain("subtract function incorrectly uses");
    // Must NOT contain the old false footer
    expect(commentBody).not.toContain("Labels applied automatically");
    // Must contain the neutral footer
    expect(commentBody).toContain("A maintainer will review shortly");
  });

  // 2. auto_comment:false → zero comments
  it("posts no triage comment when auto_comment is disabled", async () => {
    mockClaudeNormal();
    mockGetConfigForRepo.mockResolvedValue({
      pillars: {
        triage: { enabled: true, auto_label: true, auto_comment: false, duplicate_detection: false },
      },
    });

    await triageIssue(makeIssuePayload());

    expect(mockPostMarkedComment).not.toHaveBeenCalled();
  });

  // 3. needs_more_info case → comment includes the extra section
  it("includes needs_more_info section in the comment when applicable", async () => {
    mockClaudeNeedsMoreInfo();

    await triageIssue(makeIssuePayload());

    expect(mockPostMarkedComment).toHaveBeenCalledTimes(1);
    const commentBody = mockPostMarkedComment.mock.calls[0][6];
    expect(commentBody).toContain("may need more information");
  });

  // 4. Dry-run → no GitHub comment
  it("posts no triage comment in dry-run mode", async () => {
    mockClaudeNormal();
    mockGetConfigForRepo.mockResolvedValue({
      settings: { dry_run: true },
      pillars: {
        triage: { enabled: true, auto_label: true, auto_comment: true, duplicate_detection: false },
      },
    });

    await triageIssue(makeIssuePayload());

    expect(mockPostMarkedComment).not.toHaveBeenCalled();
  });

  // 5. Retry/reprocessing → marker-backed comment (no duplicate)
  it("uses marker-backed comment so retry updates rather than duplicates", async () => {
    mockClaudeNormal();
    // Simulate a retry: postMarkedComment returns action "updated" (existing comment found)
    mockPostMarkedComment.mockResolvedValue({ action: "updated", comment_id: 999 });

    await triageIssue(makeIssuePayload());

    // Still exactly one call to postMarkedComment (not a raw POST)
    expect(mockPostMarkedComment).toHaveBeenCalledTimes(1);
    // The marker ID is repo:issue scoped
    const markerId = mockPostMarkedComment.mock.calls[0][5];
    expect(markerId).toBe("999:42");
  });

  // 6. auto_label:false + auto_comment:true → comment footer is truthful
  it("does not claim labels were applied when auto_label is false", async () => {
    mockClaudeNormal();
    mockGetConfigForRepo.mockResolvedValue({
      pillars: {
        triage: { enabled: true, auto_label: false, auto_comment: true, duplicate_detection: false },
      },
    });

    await triageIssue(makeIssuePayload());

    expect(mockPostMarkedComment).toHaveBeenCalledTimes(1);
    const commentBody = mockPostMarkedComment.mock.calls[0][6];
    expect(commentBody).not.toContain("Labels applied");
  });

  // 7. duplicate_hint case → comment includes the duplicate section
  it("includes duplicate_hint section in the comment when applicable", async () => {
    mockAnthropicCreate.mockResolvedValue({
      content: [{
        text: JSON.stringify({
          type: "bug",
          priority: "medium",
          triage_summary: "This looks similar to an existing issue.",
          labels: ["bug"],
          needs_more_info: false,
          duplicate_hint: "#5 — similar crash on startup",
        }),
      }],
      usage: { input_tokens: 100, output_tokens: 50 },
    });

    await triageIssue(makeIssuePayload());

    expect(mockPostMarkedComment).toHaveBeenCalledTimes(1);
    const commentBody = mockPostMarkedComment.mock.calls[0][6];
    expect(commentBody).toContain("Possible duplicate");
    expect(commentBody).toContain("#5");
  });
});
