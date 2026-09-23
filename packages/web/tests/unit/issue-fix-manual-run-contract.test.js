// D0-02 — /gitwire run fix must use the same trusted IssueFixJobV1 contract as /gitwire fix.

import { beforeEach, describe, expect, it, jest } from "@jest/globals";

const mockBuildTriageOperationKey = jest.fn();
const mockClearIdempotencyKey = jest.fn();
const mockClearTriageOperation = jest.fn();
const mockBuildCommandResponse = jest.fn();
const mockBuildIssueFixJob = jest.fn();
const mockEnqueueIssueFixJob = jest.fn();
const mockResolveIssueFixRepositoryByFullName = jest.fn();

jest.unstable_mockModule("../../src/services/idempotencyService.js", () => ({
  buildTriageOperationKey: mockBuildTriageOperationKey,
  clearIdempotencyKey: mockClearIdempotencyKey,
  clearTriageOperation: mockClearTriageOperation,
}));
jest.unstable_mockModule("../../src/lib/commentRouter.js", () => ({
  buildCommandResponse: mockBuildCommandResponse,
}));
jest.unstable_mockModule("../../src/services/issueFixJobService.js", () => ({
  buildIssueFixJob: mockBuildIssueFixJob,
  enqueueIssueFixJob: mockEnqueueIssueFixJob,
}));
jest.unstable_mockModule("../../src/services/issueFixTargetService.js", () => ({
  resolveIssueFixRepositoryByFullName: mockResolveIssueFixRepositoryByFullName,
}));

const { handleManualRun } = await import("../../src/lib/webhookHandlers/commentCommands/handleManualRun.js");

const repository = {
  github_id: "99",
  installation_id: "77",
  full_name: "octo/repo",
  owner: "octo",
  name: "repo",
  default_branch: "main",
};
const canonicalJob = {
  schema_version: 1,
  repository: {
    github_id: "99",
    full_name: "octo/repo",
    expected_installation_id: "77",
  },
  issue_number: 42,
  trigger: { kind: "comment_command", requested_at: "2026-09-23T00:00:00.000Z", requested_by_login: "maintainer" },
};

function payload() {
  return {
    repository: { id: 99, full_name: "octo/repo" },
    issue: { id: 4200, number: 42 },
    installation: { id: 77 },
  };
}

function makeCtx(request) {
  return {
    issueFixQueue: { name: "issue-fix" },
    triageQueue: { add: jest.fn() },
    phase4Queue: { add: jest.fn() },
    getInstallationClient: jest.fn().mockResolvedValue({ request }),
    wrapOctokit: jest.fn().mockImplementation((client) => client),
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockBuildCommandResponse.mockReturnValue("ack");
  mockResolveIssueFixRepositoryByFullName.mockResolvedValue({ status: "resolved", repository });
  mockBuildIssueFixJob.mockReturnValue(canonicalJob);
  mockEnqueueIssueFixJob.mockResolvedValue({ id: "job-1" });
  mockClearIdempotencyKey.mockResolvedValue(undefined);
  mockClearTriageOperation.mockResolvedValue(undefined);
});

describe("manual-run issue-fix contract", () => {
  it("resolves trusted repository state, clears the scoped marker, and enqueues IssueFixJobV1", async () => {
    const request = jest.fn().mockResolvedValue({ data: {} });
    const ctx = makeCtx(request);

    await handleManualRun(
      payload(),
      { issueNumber: 42, authorLogin: "maintainer" },
      { action: "manual_run", pillar: "fix" },
      ctx,
    );

    expect(mockResolveIssueFixRepositoryByFullName).toHaveBeenCalledWith("octo/repo");
    expect(mockClearIdempotencyKey).toHaveBeenCalledWith("issue_fix", "repo-99:issue-42");
    expect(mockBuildIssueFixJob).toHaveBeenCalledWith({
      repository,
      issueNumber: 42,
      triggerKind: "comment_command",
      requestedByLogin: "maintainer",
    });
    expect(mockEnqueueIssueFixJob).toHaveBeenCalledWith(ctx.issueFixQueue, canonicalJob, { priority: 1 });
    expect(request).toHaveBeenCalledWith(
      "POST /repos/{owner}/{repo}/issues/{issue_number}/comments",
      expect.objectContaining({ owner: "octo", repo: "repo", issue_number: 42, body: "ack" }),
    );
  });

  it("fails closed without acknowledging a dispatch when trusted repository binding is ambiguous", async () => {
    mockResolveIssueFixRepositoryByFullName.mockResolvedValue({ status: "ambiguous" });
    const request = jest.fn().mockResolvedValue({ data: {} });
    const ctx = makeCtx(request);

    await handleManualRun(
      payload(),
      { issueNumber: 42, authorLogin: "maintainer" },
      { action: "manual_run", pillar: "fix" },
      ctx,
    );

    expect(mockBuildIssueFixJob).not.toHaveBeenCalled();
    expect(mockEnqueueIssueFixJob).not.toHaveBeenCalled();
    expect(mockClearIdempotencyKey).not.toHaveBeenCalledWith("issue_fix", expect.any(String));
    expect(request).toHaveBeenCalledWith(
      "POST /repos/{owner}/{repo}/issues/{issue_number}/comments",
      expect.objectContaining({
        body: expect.stringContaining("repository binding could not be resolved safely"),
      }),
    );
  });
});
