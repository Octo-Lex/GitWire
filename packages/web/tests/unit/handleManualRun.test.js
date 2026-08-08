// tests/unit/handleManualRun.test.js
// Regression test for the P1 crash: /gitwire run triage on an issue threw
// ReferenceError: buildTriageOperationKey is not defined because the builder
// was destructured inside handleManualRun() but referenced at module scope
// by manualTriageOperationKey().
//
// This test exercises the issue /gitwire run triage path and proves:
//   - no ReferenceError
//   - the scoped triage operation is cleared
//   - the legacy key is cleared
//   - exactly one triage job is enqueued

import { jest } from "@jest/globals";

// ── Mock idempotencyService so we can observe calls without Redis ────────────
const mockClearTriageOperation = jest.fn().mockResolvedValue(undefined);
const mockClearIdempotencyKey = jest.fn().mockResolvedValue(undefined);

jest.unstable_mockModule("../../src/services/idempotencyService.js", () => ({
  buildTriageOperationKey: jest.fn(({ targetType, repoId, targetId, action }) =>
    `repo:${repoId}:${targetType}:${targetId}:${action}`),
  clearTriageOperation: mockClearTriageOperation,
  clearIdempotencyKey: mockClearIdempotencyKey,
}));

// ── Import after mock is set up ──────────────────────────────────────────────
const { handleManualRun } = await import("../../src/lib/webhookHandlers/commentCommands/handleManualRun.js");

// ── Test fixture ─────────────────────────────────────────────────────────────
function makeIssuePayload(overrides = {}) {
  return {
    action: "created",
    installation: { id: 11111 },
    repository: { id: 999, full_name: "org/repo", name: "repo", owner: { login: "org" } },
    issue: { id: 555, number: 42, user: { login: "maintainer" } },
    comment: { id: 1, body: "/gitwire run triage", user: { login: "maintainer" } },
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

beforeEach(() => {
  jest.clearAllMocks();
});

describe("/gitwire run triage — issue path (P1 regression)", () => {
  it("does not throw ReferenceError (the P1 crash)", async () => {
    const payload = makeIssuePayload();
    const parsed = { issueNumber: 42, authorLogin: "maintainer" };
    const action = { pillar: "triage" };
    const ctx = makeCtx();

    // This call previously threw ReferenceError: buildTriageOperationKey is not defined
    await expect(
      handleManualRun(payload, parsed, action, ctx),
    ).resolves.not.toThrow();
  });

  it("clears the scoped triage operation key", async () => {
    const payload = makeIssuePayload();
    const parsed = { issueNumber: 42, authorLogin: "maintainer" };
    const action = { pillar: "triage" };
    const ctx = makeCtx();

    await handleManualRun(payload, parsed, action, ctx);

    // clearTriageOperation should have been called with the scoped key
    expect(mockClearTriageOperation).toHaveBeenCalledTimes(1);
    const [source, opKey] = mockClearTriageOperation.mock.calls[0];
    expect(source).toBe("triage");
    expect(opKey).toContain("repo:999:issue:555:manual-run");
  });

  it("clears the legacy idempotency key", async () => {
    const payload = makeIssuePayload();
    const parsed = { issueNumber: 42, authorLogin: "maintainer" };
    const action = { pillar: "triage" };
    const ctx = makeCtx();

    await handleManualRun(payload, parsed, action, ctx);

    // The legacy key "issue-42-reopened" should also be cleared for backward compat
    const legacyCall = mockClearIdempotencyKey.mock.calls.find(
      ([source, key]) => source === "triage" && key === "issue-42-reopened",
    );
    expect(legacyCall).toBeTruthy();
  });

  it("enqueues exactly one triage job", async () => {
    const payload = makeIssuePayload();
    const parsed = { issueNumber: 42, authorLogin: "maintainer" };
    const action = { pillar: "triage" };
    const ctx = makeCtx();

    await handleManualRun(payload, parsed, action, ctx);

    expect(ctx.triageQueue.add).toHaveBeenCalledTimes(1);
    expect(ctx.triageQueue.add).toHaveBeenCalledWith(
      "triage-issue",
      { payload: expect.objectContaining({ action: "manual-run" }) },
      { priority: 1 },
    );
  });

  it("does not enqueue fix or review jobs for triage-only run", async () => {
    const payload = makeIssuePayload();
    const parsed = { issueNumber: 42, authorLogin: "maintainer" };
    const action = { pillar: "triage" };
    const ctx = makeCtx();

    await handleManualRun(payload, parsed, action, ctx);

    expect(ctx.issueFixQueue.add).not.toHaveBeenCalled();
    expect(ctx.phase4Queue.add).not.toHaveBeenCalled();
  });
});
