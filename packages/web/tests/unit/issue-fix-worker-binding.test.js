// D0-02 — worker must re-resolve repository/installation authority at consumption.

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
beforeEach(() => {
  jest.clearAllMocks();
  mockCreateWorker.mockImplementation((_name, fn) => { processor = fn; return { close: jest.fn() }; });
  mockResolveById.mockResolvedValue({
    status: "resolved",
    repository: {
      github_id: "99002",
      installation_id: "222",
      full_name: "octo/repo",
      owner: "octo",
      name: "repo",
      default_branch: "main",
    },
  });
  mockAdoptWorker.mockResolvedValue({ context: { principalId: "system-principal" }, decision: { allowed: true } });
  mockWorkerPrincipalId.mockReturnValue("system-principal");
  mockProcessFixIssue.mockResolvedValue(undefined);
  startIssueFixWorker();
});

function validJob() {
  return {
    name: "fix-issue",
    data: {
      schema_version: 1,
      repository: { github_id: "99002", full_name: "octo/repo" },
      issue_number: 42,
      trigger: { kind: "api", requested_at: new Date(0).toISOString() },
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
});
