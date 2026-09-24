// D0-02 — worker must re-resolve repository/installation authority at consumption
// and reject any enqueue→execution binding drift.

import { beforeEach, describe, expect, it, jest } from "@jest/globals";

const mockCreateWorker = jest.fn();
const mockProcessFixIssue = jest.fn();
const mockAdoptWorker = jest.fn();
const mockWorkerPrincipalId = jest.fn();
const mockResolveById = jest.fn();

jest.unstable_mockModule("../../src/lib/queue.js", () => ({
  createWorker: mockCreateWorker,
  QUEUES: { ISSUE_FIX: "issue-fix" },
}));
jest.unstable_mockModule("../../src/lib/logger.js", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.unstable_mockModule("../../src/workers/issueFix/pipeline.js", () => ({
  processFixIssue: mockProcessFixIssue,
}));
jest.unstable_mockModule("../../src/services/auth/workerAdoption.js", () => ({
  adoptWorker: mockAdoptWorker,
  workerPrincipalId: mockWorkerPrincipalId,
}));
jest.unstable_mockModule("../../src/services/issueFixTargetService.js", () => ({
  resolveIssueFixRepositoryById: mockResolveById,
}));

const { startIssueFixWorker } = await import("../../src/workers/issueFixWorker.js");

let processor;
const currentRepository = {
  github_id: "99002",
  installation_id: "222",
  full_name: "octo/repo",
  owner: "octo",
  name: "repo",
  default_branch: "main",
};

beforeEach(() => {
  jest.clearAllMocks();
  mockCreateWorker.mockImplementation((_name, fn) => { processor = fn; return { close: jest.fn() }; });
  mockResolveById.mockResolvedValue({ status: "resolved", repository: currentRepository });
  mockAdoptWorker.mockResolvedValue({ context: { principalId: "system-principal" }, decision: { allowed: true } });
  mockWorkerPrincipalId.mockReturnValue("system-principal");
  mockProcessFixIssue.mockResolvedValue(undefined);
  startIssueFixWorker();
});

function validJob(overrides = {}) {
  return {
    name: "fix-issue",
    data: {
      schema_version: 1,
      repository: {
        github_id: "99002",
        full_name: "octo/repo",
        expected_installation_id: "222",
        ...(overrides.repository || {}),
      },
      issue_number: 42,
      trigger: { kind: "api", requested_at: new Date(0).toISOString() },
      ...Object.fromEntries(Object.entries(overrides).filter(([key]) => key !== "repository")),
    },
  };
}

describe("issue-fix worker authority binding", () => {
  it("uses the current server-resolved installation and exact repository resource", async () => {
    await processor(validJob());

    expect(mockResolveById).toHaveBeenCalledWith("99002");
    expect(mockAdoptWorker).toHaveBeenCalledWith(expect.objectContaining({
      installationId: "222",
      jobData: { repositoryId: "99002" },
    }));
    expect(mockProcessFixIssue).toHaveBeenCalledWith(expect.objectContaining({
      repository: expect.objectContaining({ installation_id: "222", github_id: "99002" }),
      issueNumber: 42,
      principalId: "system-principal",
    }));
  });

  it("does not consume legacy jobs carrying caller-selected installationId", async () => {
    await expect(processor({
      name: "fix-issue",
      data: { repo: "octo/repo", issueNumber: 42, installationId: 999 },
    })).rejects.toMatchObject({ code: "INVALID_ISSUE_FIX_JOB" });
    expect(mockResolveById).not.toHaveBeenCalled();
    expect(mockProcessFixIssue).not.toHaveBeenCalled();
  });

  it("fails visibly when the repository is no longer active", async () => {
    mockResolveById.mockResolvedValueOnce({ status: "not_found" });
    await expect(processor(validJob())).rejects.toThrow("repository unavailable at execution");
    expect(mockAdoptWorker).not.toHaveBeenCalled();
    expect(mockProcessFixIssue).not.toHaveBeenCalled();
  });

  it("refuses to follow a repository rename/transfer after enqueue", async () => {
    mockResolveById.mockResolvedValueOnce({
      status: "resolved",
      repository: { ...currentRepository, full_name: "new-owner/repo", owner: "new-owner" },
    });
    await expect(processor(validJob())).rejects.toThrow("repository binding changed after enqueue");
    expect(mockAdoptWorker).not.toHaveBeenCalled();
  });

  it("refuses to inherit a new installation after enqueue", async () => {
    mockResolveById.mockResolvedValueOnce({
      status: "resolved",
      repository: { ...currentRepository, installation_id: "333" },
    });
    await expect(processor(validJob())).rejects.toThrow("repository binding changed after enqueue");
    expect(mockAdoptWorker).not.toHaveBeenCalled();
  });
});
