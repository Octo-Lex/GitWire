// tests/unit/handlePullRequest-spam-gate.test.js
// Handler-level regression: spam-gate blocked PR must enqueue Phase 4
// terminalization (not triage) with the exact checkRunId and skipReason.

import { jest } from "@jest/globals";

const mockCheckSpamGate = jest.fn();
const mockTriageQueueAdd = jest.fn().mockResolvedValue({});
const mockPhase4QueueAdd = jest.fn().mockResolvedValue({});
const mockCiHealQueueAdd = jest.fn().mockResolvedValue({});
const mockPhase2QueueAdd = jest.fn().mockResolvedValue({});
const mockMaintainerQueueAdd = jest.fn().mockResolvedValue({});
const mockIssueFixQueueAdd = jest.fn().mockResolvedValue({});
const mockWebhookQueueAdd = jest.fn().mockResolvedValue({});
const mockRedis = { setex: jest.fn(), get: jest.fn(), del: jest.fn(), eval: jest.fn() };
const mockDb = { query: jest.fn() };

jest.unstable_mockModule("../../src/lib/webhookHandlers/handleSpamGate.js", () => ({
  checkSpamGate: mockCheckSpamGate,
}));

jest.unstable_mockModule("../../src/lib/queue.js", () => ({
  redis: mockRedis,
  triageQueue: { add: mockTriageQueueAdd },
  ciHealQueue: { add: mockCiHealQueueAdd },
  phase4Queue: { add: mockPhase4QueueAdd },
  phase2Queue: { add: mockPhase2QueueAdd },
  maintainerQueue: { add: mockMaintainerQueueAdd },
  issueFixQueue: { add: mockIssueFixQueueAdd },
  webhookQueue: { add: mockWebhookQueueAdd },
}));

jest.unstable_mockModule("../../src/lib/db.js", () => ({ db: mockDb }));
jest.unstable_mockModule("../../src/lib/logger.js", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.unstable_mockModule("../../src/lib/commentRouter.js", () => ({
  parseGitwireCommand: jest.fn(),
  resolveCommandAction: jest.fn(),
  buildCommandResponse: jest.fn(),
}));
jest.unstable_mockModule("../../src/services/configService.js", () => ({
  invalidateConfigCache: jest.fn(),
}));
jest.unstable_mockModule("../../src/lib/githubWrapper.js", () => ({ wrapOctokit: (c) => c }));
jest.unstable_mockModule("../../src/lib/github.js", () => ({ getInstallationClient: jest.fn() }));

// Import after mocks
const { handlePullRequest } = await import("../../src/lib/webhookHandlers/handlePullRequest.js");

function makeCtx() {
  return {
    triageQueue: { add: mockTriageQueueAdd },
    phase4Queue: { add: mockPhase4QueueAdd },
    ciHealQueue: { add: mockCiHealQueueAdd },
    phase2Queue: { add: mockPhase2QueueAdd },
    maintainerQueue: { add: mockMaintainerQueueAdd },
    issueFixQueue: { add: mockIssueFixQueueAdd },
    webhookQueue: { add: mockWebhookQueueAdd },
    redis: mockRedis,
    db: mockDb,
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
    getInstallationClient: jest.fn(),
    wrapOctokit: (c) => c,
  };
}

function makeOpenedPRPayload() {
  return {
    action: "opened",
    pull_request: {
      number: 16,
      head: { sha: "abc123", ref: "feature" },
      base: { ref: "main" },
      user: { login: "spammer" },
      id: 7777,
    },
    repository: {
      id: 999,
      full_name: "org/repo",
      name: "repo",
      owner: { login: "org" },
    },
    installation: { id: 11111 },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockCheckSpamGate.mockResolvedValue({ blocked: false });
});

describe("Spam-gate blocked PR → check terminalization", () => {
  it("enqueues Phase 4 terminalization with checkRunId + skipReason, NOT triage", async () => {
    mockCheckSpamGate.mockResolvedValue({ blocked: true, reason: "duplicate spam" });

    const payload = makeOpenedPRPayload();
    const ctx = makeCtx();
    const meta = { checkRunId: 5000 };

    await handlePullRequest(payload, "del-123", ctx, meta);

    // Triage must NOT be enqueued
    expect(mockTriageQueueAdd).not.toHaveBeenCalled();

    // Phase 4 must be enqueued exactly once with the terminalization payload
    expect(mockPhase4QueueAdd).toHaveBeenCalledTimes(1);
    expect(mockPhase4QueueAdd).toHaveBeenCalledWith(
      "ai-review",
      {
        pr: payload.pull_request,
        repository: payload.repository,
        installation: payload.installation,
        checkRunId: 5000,
        skipReason: "spam_gate",
      },
      { priority: 1 },
    );
  });

  it("does NOT enqueue terminalization when spam gate passes", async () => {
    mockCheckSpamGate.mockResolvedValue({ blocked: false });

    const payload = makeOpenedPRPayload();
    const ctx = makeCtx();
    const meta = { checkRunId: 5000 };

    await handlePullRequest(payload, "del-123", ctx, meta);

    // Normal path: triage IS enqueued
    expect(mockTriageQueueAdd).toHaveBeenCalled();
    // Phase 4 review IS enqueued (not terminalization — no skipReason)
    expect(mockPhase4QueueAdd).toHaveBeenCalledTimes(1);
    const phase4Call = mockPhase4QueueAdd.mock.calls[0];
    expect(phase4Call[1].skipReason).toBeUndefined();
  });
});
