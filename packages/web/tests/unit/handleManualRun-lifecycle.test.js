// tests/unit/handleManualRun-lifecycle.test.js
// Focused tests for the /gitwire run manual-run lifecycle fix.
//
// Proves:
//   - Issue triage: normalized payload (action=manual-run), matching lifecycle key,
//     triage-issue enqueue, repeated invocation clears and reacquires.
//   - PR triage: real PR fetched, triage-pr queued (not triage-issue),
//     worker-native pull_request payload, matching manual-run lifecycle key.
//   - PR review: real PR fetched, exact pr-N-head.sha key cleared,
//     ai-review receives complete PR with head.sha.
//   - Acknowledgment: one GitHub comment posted after dispatch;
//     heal receives truthful unsupported feedback.
//   - Issue fix path unchanged.

import { jest } from "@jest/globals";

// ── Mocks ────────────────────────────────────────────────────────────────────
const mockClearTriageOperation = jest.fn().mockResolvedValue(undefined);
const mockClearIdempotencyKey = jest.fn().mockResolvedValue(undefined);
const mockTriageQueueAdd = jest.fn().mockResolvedValue({ id: "t1" });
const mockPhase4QueueAdd = jest.fn().mockResolvedValue({ id: "r1" });
const mockIssueFixQueueAdd = jest.fn().mockResolvedValue({ id: "f1" });
const mockOctokitRequest = jest.fn();
const mockWrapOctokit = jest.fn((client) => client);
const mockGetInstallationClient = jest.fn();

jest.unstable_mockModule("../../src/services/idempotencyService.js", () => ({
  buildTriageOperationKey: jest.fn(({ targetType, repoId, targetId, action }) =>
    `repo:${repoId}:${targetType}:${targetId}:${action}`),
  clearTriageOperation: mockClearTriageOperation,
  clearIdempotencyKey: mockClearIdempotencyKey,
}));

jest.unstable_mockModule("../../src/lib/commentRouter.js", () => ({
  buildCommandResponse: jest.fn(() => "▶️ **GitWire:** Re-evaluation triggered."),
  parseGitwireCommand: jest.fn(),
  resolveCommandAction: jest.fn(),
}));

// Import after mocks
const { handleManualRun } = await import("../../src/lib/webhookHandlers/commentCommands/handleManualRun.js");

// ── Fixtures ─────────────────────────────────────────────────────────────────

function makeIssuePayload(overrides = {}) {
  return {
    action: "created",
    installation: { id: 11111 },
    repository: { id: 999, full_name: "org/repo", name: "repo", owner: { login: "org" } },
    issue: { id: 555, number: 42, user: { login: "maintainer" } },
    comment: { id: 1, body: "/gitwire run triage", user: { login: "maintainer" }, author_association: "MEMBER" },
    ...overrides,
  };
}

function makePRPayload(overrides = {}) {
  return {
    action: "created",
    installation: { id: 11111 },
    repository: { id: 999, full_name: "org/repo", name: "repo", owner: { login: "org" } },
    issue: {
      number: 16,
      pull_request: { url: "https://api.github.com/repos/org/repo/pulls/16" },
      user: { login: "contributor" },
    },
    comment: { id: 2, body: "/gitwire run review", user: { login: "maintainer" }, author_association: "MEMBER" },
    ...overrides,
  };
}

function makeFullPR(overrides = {}) {
  return {
    number: 16,
    id: 7777,
    head: { sha: "abc123def456", ref: "feature-branch" },
    base: { ref: "main" },
    user: { login: "contributor" },
    title: "feat: new feature",
    body: "description",
    changed_files: 3,
    additions: 50,
    deletions: 10,
    ...overrides,
  };
}

function makeCtx() {
  return {
    triageQueue: { add: mockTriageQueueAdd },
    phase4Queue: { add: mockPhase4QueueAdd },
    issueFixQueue: { add: mockIssueFixQueueAdd },
    getInstallationClient: mockGetInstallationClient,
    wrapOctokit: mockWrapOctokit,
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetInstallationClient.mockResolvedValue({ request: mockOctokitRequest });
  mockOctokitRequest.mockResolvedValue({ data: makeFullPR() });
});

// ── Issue /gitwire run triage ────────────────────────────────────────────────

describe("Issue /gitwire run triage", () => {
  it("normalizes payload action to manual-run so the lifecycle key matches", async () => {
    const payload = makeIssuePayload();
    const parsed = { issueNumber: 42, authorLogin: "maintainer" };
    const action = { action: "manual_run", pillar: "triage" };

    await handleManualRun(payload, parsed, action, makeCtx());

    // The queued payload must have action: "manual-run"
    expect(mockTriageQueueAdd).toHaveBeenCalledWith(
      "triage-issue",
      { payload: expect.objectContaining({ action: "manual-run" }) },
      { priority: 1 },
    );
  });

  it("clears the exact repo:...:issue:...:manual-run lifecycle key", async () => {
    const payload = makeIssuePayload();
    const parsed = { issueNumber: 42, authorLogin: "maintainer" };
    const action = { action: "manual_run", pillar: "triage" };

    await handleManualRun(payload, parsed, action, makeCtx());

    expect(mockClearTriageOperation).toHaveBeenCalledWith("triage", "repo:999:issue:555:manual-run");
  });

  it("enqueues exactly one triage-issue job", async () => {
    const payload = makeIssuePayload();
    const parsed = { issueNumber: 42, authorLogin: "maintainer" };
    const action = { action: "manual_run", pillar: "triage" };

    await handleManualRun(payload, parsed, action, makeCtx());

    expect(mockTriageQueueAdd).toHaveBeenCalledTimes(1);
    expect(mockPhase4QueueAdd).not.toHaveBeenCalled();
    expect(mockIssueFixQueueAdd).not.toHaveBeenCalled();
  });

  it("repeated invocation clears and reacquires the same lifecycle namespace", async () => {
    const payload = makeIssuePayload();
    const parsed = { issueNumber: 42, authorLogin: "maintainer" };
    const action = { action: "manual_run", pillar: "triage" };
    const ctx = makeCtx();

    // First run
    await handleManualRun(payload, parsed, action, ctx);
    expect(mockClearTriageOperation).toHaveBeenCalledWith("triage", "repo:999:issue:555:manual-run");

    jest.clearAllMocks();

    // Second run — same key cleared again
    await handleManualRun(payload, parsed, action, ctx);
    expect(mockClearTriageOperation).toHaveBeenCalledWith("triage", "repo:999:issue:555:manual-run");
    expect(mockTriageQueueAdd).toHaveBeenCalledTimes(1);
  });
});

// ── PR /gitwire run triage ───────────────────────────────────────────────────

describe("PR /gitwire run triage", () => {
  it("fetches the real PR object from GitHub", async () => {
    const payload = makePRPayload();
    const parsed = { issueNumber: 16, authorLogin: "maintainer" };
    const action = { action: "manual_run", pillar: "triage" };

    await handleManualRun(payload, parsed, action, makeCtx());

    expect(mockOctokitRequest).toHaveBeenCalledWith(
      "GET /repos/{owner}/{repo}/pulls/{pull_number}",
      expect.objectContaining({ owner: "org", repo: "repo", pull_number: 16 }),
    );
  });

  it("queues triage-pr (not triage-issue) with the full PR in pull_request field", async () => {
    const payload = makePRPayload();
    const parsed = { issueNumber: 16, authorLogin: "maintainer" };
    const action = { action: "manual_run", pillar: "triage" };

    await handleManualRun(payload, parsed, action, makeCtx());

    expect(mockTriageQueueAdd).toHaveBeenCalledWith(
      "triage-pr",
      { payload: expect.objectContaining({
        action: "manual-run",
        pull_request: expect.objectContaining({ number: 16, head: expect.objectContaining({ sha: "abc123def456" }) }),
      })},
      { priority: 1 },
    );
  });

  it("clears the matching PR manual-run lifecycle key using the real PR ID", async () => {
    const payload = makePRPayload();
    const parsed = { issueNumber: 16, authorLogin: "maintainer" };
    const action = { action: "manual_run", pillar: "triage" };

    await handleManualRun(payload, parsed, action, makeCtx());

    // fullPR.id is 7777
    expect(mockClearTriageOperation).toHaveBeenCalledWith("triage", "repo:999:pr:7777:manual-run");
  });
});

// ── PR /gitwire run review ───────────────────────────────────────────────────

describe("PR /gitwire run review", () => {
  it("fetches the real PR and clears the exact pr-N-head.sha key", async () => {
    const payload = makePRPayload();
    const parsed = { issueNumber: 16, authorLogin: "maintainer" };
    const action = { action: "manual_run", pillar: "review" };

    await handleManualRun(payload, parsed, action, makeCtx());

    // The key must be pr-16-abc123def456 (not pr-16-unknown)
    expect(mockClearIdempotencyKey).toHaveBeenCalledWith("ai_review", "pr-16-abc123def456");
  });

  it("queues ai-review with the complete PR object including head.sha", async () => {
    const payload = makePRPayload();
    const parsed = { issueNumber: 16, authorLogin: "maintainer" };
    const action = { action: "manual_run", pillar: "review" };

    await handleManualRun(payload, parsed, action, makeCtx());

    expect(mockPhase4QueueAdd).toHaveBeenCalledWith(
      "ai-review",
      expect.objectContaining({
        pr: expect.objectContaining({
          number: 16,
          head: expect.objectContaining({ sha: "abc123def456" }),
        }),
      }),
      { priority: 1 },
    );
  });

  it("does not enqueue review if PR fetch failed", async () => {
    mockOctokitRequest.mockRejectedValue(new Error("Not Found"));
    const payload = makePRPayload();
    const parsed = { issueNumber: 16, authorLogin: "maintainer" };
    const action = { action: "manual_run", pillar: "review" };

    await handleManualRun(payload, parsed, action, makeCtx());

    expect(mockPhase4QueueAdd).not.toHaveBeenCalled();
  });
});

// ── Acknowledgment ───────────────────────────────────────────────────────────

describe("Acknowledgment", () => {
  it("posts exactly one GitHub comment after successful dispatch", async () => {
    const payload = makeIssuePayload();
    const parsed = { issueNumber: 42, authorLogin: "maintainer" };
    const action = { action: "manual_run", pillar: "triage" };

    await handleManualRun(payload, parsed, action, makeCtx());

    // Find the comment POST
    const commentCalls = mockOctokitRequest.mock.calls.filter(
      ([method]) => method === "POST /repos/{owner}/{repo}/issues/{issue_number}/comments",
    );
    expect(commentCalls).toHaveLength(1);
    expect(commentCalls[0][1]).toEqual(expect.objectContaining({
      owner: "org", repo: "repo", issue_number: 42,
    }));
  });

  it("posts truthful unsupported message for /gitwire run heal", async () => {
    const payload = makePRPayload();
    const parsed = { issueNumber: 16, authorLogin: "maintainer" };
    const action = { action: "manual_run", pillar: "heal" };

    await handleManualRun(payload, parsed, action, makeCtx());

    // Find the acknowledgment comment
    const commentCalls = mockOctokitRequest.mock.calls.filter(
      ([method]) => method === "POST /repos/{owner}/{repo}/issues/{issue_number}/comments",
    );
    expect(commentCalls).toHaveLength(1);
    expect(commentCalls[0][1].body).toContain("CI healing requires");
    expect(commentCalls[0][1].body).not.toContain("Re-evaluation triggered");
  });
});

// ── Issue fix path unchanged ─────────────────────────────────────────────────

describe("Issue fix path (unchanged)", () => {
  it("still enqueues fix-issue with correct payload shape", async () => {
    const payload = makeIssuePayload();
    const parsed = { issueNumber: 42, authorLogin: "maintainer" };
    const action = { action: "manual_run", pillar: "fix" };

    await handleManualRun(payload, parsed, action, makeCtx());

    expect(mockIssueFixQueueAdd).toHaveBeenCalledWith("fix-issue", {
      repo: "org/repo",
      issueNumber: 42,
      installationId: 11111,
      triggeredBy: "maintainer",
    }, { priority: 1 });
  });
});
