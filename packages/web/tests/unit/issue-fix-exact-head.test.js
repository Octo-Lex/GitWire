// D0-02 maintainer finding — Autonomous Contributor must be exact-head safe.

import { beforeEach, describe, expect, it, jest } from "@jest/globals";

const mockSucceed = jest.fn();
const mockFail = jest.fn();
const mockCancel = jest.fn();
const mockNotify = jest.fn(() => Promise.resolve());
const mockResolve = jest.fn();
const mockSameBinding = jest.fn();
const mockUpsert = jest.fn();
const mockComment = jest.fn();

jest.unstable_mockModule("../../src/services/actionStateMachine.js", () => ({
  succeed: mockSucceed,
  fail: mockFail,
  cancel: mockCancel,
}));
jest.unstable_mockModule("../../src/services/telegramNotifyService.js", () => ({ notifyIssueFix: mockNotify }));
jest.unstable_mockModule("../../src/services/conventionDetector.js", () => ({
  detectConvention: jest.fn().mockResolvedValue(null),
  formatPRTitle: jest.fn().mockReturnValue("fix: generated"),
  extractScope: jest.fn().mockReturnValue("core"),
}));
jest.unstable_mockModule("../../src/services/issueFixTargetService.js", () => ({
  resolveIssueFixRepositoryById: mockResolve,
  sameIssueFixRepositoryBinding: mockSameBinding,
}));
jest.unstable_mockModule("../../src/workers/issueFix/helpers.js", () => ({
  upsertFixAttempt: mockUpsert,
  postIssueComment: mockComment,
  truncate: (s) => s,
}));
jest.unstable_mockModule("../../src/lib/logger.js", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const { submitFix } = await import("../../src/workers/issueFix/submit.js");

const repository = {
  github_id: "99",
  installation_id: "77",
  full_name: "octo/repo",
  owner: "octo",
  name: "repo",
  default_branch: "main",
};

function makeCtx(octokit) {
  return {
    octokit,
    owner: "octo",
    repoName: "repo",
    repoId: "99",
    issueNumber: 42,
    branchName: "gitwire/fix-42",
    repo: "octo/repo",
    repository,
    _scope: {
      baseSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      defaultBranch: "main",
      issue: { title: "Bug" },
    },
  };
}

const analysis = { complexity: "simple", explanation: "fix it", relevant_files: ["src/a.js"] };
const validated = {
  fixes: [{ path: "src/a.js", fixed_content: "new", explanation: "change" }],
  fileContents: [{ path: "src/a.js", content: "old", sha: "blobsha" }],
  fixAction: { id: "action-1" },
};

beforeEach(() => {
  jest.clearAllMocks();
  mockResolve.mockResolvedValue({ status: "resolved", repository });
  mockSameBinding.mockReturnValue(true);
  mockSucceed.mockResolvedValue({});
  mockFail.mockResolvedValue({});
  mockCancel.mockResolvedValue({});
  mockUpsert.mockResolvedValue({});
  mockComment.mockResolvedValue({});
});

describe("issue-fix pre-effect fences", () => {
  it("supersedes without mutation when repository authority changed", async () => {
    mockSameBinding.mockReturnValue(false);
    const request = jest.fn();
    await submitFix(makeCtx({ request }), analysis, validated);

    expect(mockCancel).toHaveBeenCalledWith("action-1", expect.stringContaining("Repository binding changed"));
    expect(mockUpsert).toHaveBeenCalledWith("99", 42, "gitwire/fix-42", "superseded", expect.anything(), expect.anything(), expect.anything());
    expect(request).not.toHaveBeenCalled();
  });

  it("supersedes before mutation when default branch advanced", async () => {
    const request = jest.fn().mockResolvedValueOnce({ data: { object: { sha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" } } });
    await submitFix(makeCtx({ request }), analysis, validated);

    expect(request).toHaveBeenCalledTimes(1);
    expect(mockCancel).toHaveBeenCalledWith("action-1", expect.stringContaining("Default branch advanced"));
    expect(mockSucceed).not.toHaveBeenCalled();
  });

  it("creates the fix branch from exactly the reviewed head", async () => {
    const request = jest.fn(async (route) => {
      if (route.startsWith("GET /repos/{owner}/{repo}/git/ref")) {
        return { data: { object: { sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" } } };
      }
      if (route.startsWith("POST /repos/{owner}/{repo}/git/refs")) return { data: {} };
      if (route.startsWith("PUT /repos/{owner}/{repo}/contents")) return { data: {} };
      if (route.startsWith("POST /repos/{owner}/{repo}/pulls")) return { data: { number: 8, html_url: "https://example.test/pr/8" } };
      if (route.startsWith("POST /repos/{owner}/{repo}/issues/{issue_number}/labels")) return { data: {} };
      throw new Error("unexpected route " + route);
    });

    await submitFix(makeCtx({ request }), analysis, validated);

    const createRefCall = request.mock.calls.find(([route]) => route === "POST /repos/{owner}/{repo}/git/refs");
    expect(createRefCall[1]).toEqual(expect.objectContaining({
      ref: "refs/heads/gitwire/fix-42",
      sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    }));
    expect(mockSucceed).toHaveBeenCalledWith("action-1", expect.objectContaining({
      pr_number: 8,
      base_sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    }));
  });
});
