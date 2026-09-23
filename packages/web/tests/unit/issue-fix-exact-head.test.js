// D0-02 maintainer findings — Autonomous Contributor authority/head/issue/idempotency fences.

import { beforeEach, describe, expect, it, jest } from "@jest/globals";

const mockSucceed = jest.fn();
const mockFail = jest.fn();
const mockCancel = jest.fn();
const mockCheckAndMark = jest.fn();
const mockNotify = jest.fn(() => Promise.resolve());
const mockResolve = jest.fn();
const mockSameBinding = jest.fn();
const mockBuildIssueSnapshot = jest.fn();
const mockSameIssueSnapshot = jest.fn();
const mockUpsert = jest.fn();
const mockComment = jest.fn();

jest.unstable_mockModule("../../src/services/actionStateMachine.js", () => ({
  succeed: mockSucceed, fail: mockFail, cancel: mockCancel,
}));
jest.unstable_mockModule("../../src/services/idempotencyService.js", () => ({ checkAndMark: mockCheckAndMark }));
jest.unstable_mockModule("../../src/services/telegramNotifyService.js", () => ({ notifyIssueFix: mockNotify }));
jest.unstable_mockModule("../../src/services/conventionDetector.js", () => ({
  detectConvention: jest.fn().mockResolvedValue(null),
  formatPRTitle: jest.fn().mockReturnValue("fix: generated"),
  extractScope: jest.fn().mockReturnValue("core"),
}));
jest.unstable_mockModule("../../src/services/issueFixTargetService.js", () => ({
  resolveIssueFixRepositoryById: mockResolve,
  sameIssueFixRepositoryBinding: mockSameBinding,
  buildIssueFixIssueSnapshot: mockBuildIssueSnapshot,
  sameIssueFixIssueSnapshot: mockSameIssueSnapshot,
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
  github_id: "99", installation_id: "77", full_name: "octo/repo",
  owner: "octo", name: "repo", default_branch: "main",
};
const baseSha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const issueSnapshot = {
  github_id: "123456",
  number: 42,
  state: "open",
  title: "Bug",
  body: "Broken",
  labels: ["bug"],
  is_pull_request: false,
  updated_at: "2026-09-23T20:00:00Z",
};

function makeCtx(octokit) {
  return {
    octokit, owner: "octo", repoName: "repo", repoId: "99", issueNumber: 42,
    branchName: "gitwire/fix-42", repo: "octo/repo", repository, triggeredBy: "api",
    _scope: {
      baseSha,
      defaultBranch: "main",
      issue: { id: 123456, number: 42, state: "open", title: "Bug", body: "Broken", labels: [{ name: "bug" }] },
      issueSnapshot,
    },
  };
}

const analysis = { complexity: "simple", explanation: "fix it", relevant_files: ["src/a.js"] };
const validated = {
  fixes: [{ path: "src/a.js", fixed_content: "new", explanation: "change" }],
  fileContents: [{ path: "src/a.js", content: "old", sha: "blobsha" }],
  fixAction: { id: "action-1" },
};

function liveRepo(overrides = {}) {
  return { id: 99, full_name: "octo/repo", default_branch: "main", ...overrides };
}

function liveIssue(overrides = {}) {
  return {
    id: 123456,
    number: 42,
    state: "open",
    title: "Bug",
    body: "Broken",
    labels: [{ name: "bug" }],
    updated_at: "2026-09-23T20:01:00Z",
    ...overrides,
  };
}

function notFoundError() {
  const err = new Error("Not Found");
  err.status = 404;
  return err;
}

function successfulSubmissionRequest() {
  return jest.fn(async (route, params) => {
    if (route === "GET /repos/{owner}/{repo}") return { data: liveRepo() };
    if (route === "GET /repos/{owner}/{repo}/issues/{issue_number}") return { data: liveIssue() };
    if (route === "GET /repos/{owner}/{repo}/git/ref/heads/{branch}") {
      if (params.branch === "main") return { data: { object: { sha: baseSha } } };
      if (params.branch === "gitwire/fix-42") throw notFoundError();
    }
    if (route === "POST /repos/{owner}/{repo}/git/refs") return { data: {} };
    if (route === "PUT /repos/{owner}/{repo}/contents/{path}") return { data: {} };
    if (route === "POST /repos/{owner}/{repo}/pulls") {
      return { data: { number: 8, html_url: "https://example.test/pr/8" } };
    }
    if (route === "POST /repos/{owner}/{repo}/issues/{issue_number}/labels") return { data: {} };
    throw new Error("unexpected route " + route);
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockResolve.mockResolvedValue({ status: "resolved", repository });
  mockSameBinding.mockReturnValue(true);
  mockBuildIssueSnapshot.mockReturnValue({ ...issueSnapshot, updated_at: "2026-09-23T20:01:00Z" });
  mockSameIssueSnapshot.mockReturnValue(true);
  mockCheckAndMark.mockResolvedValue(true);
  mockSucceed.mockResolvedValue({});
  mockFail.mockResolvedValue({});
  mockCancel.mockResolvedValue({});
  mockUpsert.mockResolvedValue({});
  mockComment.mockResolvedValue({});
});

describe("issue-fix pre-effect fences", () => {
  it("supersedes authority drift before idempotency or GitHub mutation", async () => {
    mockSameBinding.mockReturnValue(false);
    const request = jest.fn();
    await submitFix(makeCtx({ request }), analysis, validated);
    expect(mockCancel).toHaveBeenCalledWith("action-1", expect.stringContaining("Repository binding changed"));
    expect(mockCheckAndMark).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  it("uses live GitHub default-branch identity instead of synchronized DB metadata", async () => {
    mockResolve.mockResolvedValueOnce({ status: "resolved", repository: { ...repository, default_branch: "stale-db-value" } });
    mockSameBinding.mockReturnValue(true);
    const request = successfulSubmissionRequest();

    await submitFix(makeCtx({ request }), analysis, validated);
    expect(mockSucceed).toHaveBeenCalled();
  });

  it("supersedes when live GitHub repository identity/default branch changed", async () => {
    const request = jest.fn().mockResolvedValueOnce({ data: liveRepo({ default_branch: "trunk" }) });
    await submitFix(makeCtx({ request }), analysis, validated);
    expect(request).toHaveBeenCalledTimes(1);
    expect(mockCancel).toHaveBeenCalledWith("action-1", expect.stringContaining("Repository identity or default branch changed"));
    expect(mockCheckAndMark).not.toHaveBeenCalled();
  });

  it("supersedes a moved head without poisoning the submission marker", async () => {
    const request = jest.fn()
      .mockResolvedValueOnce({ data: liveRepo() })
      .mockResolvedValueOnce({ data: { object: { sha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" } } });
    await submitFix(makeCtx({ request }), analysis, validated);
    expect(request).toHaveBeenCalledTimes(2);
    expect(mockCancel).toHaveBeenCalledWith("action-1", expect.stringContaining("Default branch advanced"));
    expect(mockCheckAndMark).not.toHaveBeenCalled();
    expect(mockSucceed).not.toHaveBeenCalled();
  });

  it("supersedes a changed issue target before branch/idempotency/mutation", async () => {
    mockSameIssueSnapshot.mockReturnValue(false);
    const request = jest.fn(async (route, params) => {
      if (route === "GET /repos/{owner}/{repo}") return { data: liveRepo() };
      if (route === "GET /repos/{owner}/{repo}/git/ref/heads/{branch}" && params.branch === "main") {
        return { data: { object: { sha: baseSha } } };
      }
      if (route === "GET /repos/{owner}/{repo}/issues/{issue_number}") {
        return { data: liveIssue({ state: "closed" }) };
      }
      throw new Error("unexpected route " + route);
    });

    await submitFix(makeCtx({ request }), analysis, validated);

    expect(mockBuildIssueSnapshot).toHaveBeenCalledWith(expect.objectContaining({ state: "closed" }));
    expect(mockCancel).toHaveBeenCalledWith("action-1", expect.stringContaining("Issue target changed"));
    expect(mockCheckAndMark).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledTimes(3);
  });

  it("refuses to overwrite a pre-existing issue-fix branch before idempotency", async () => {
    const request = jest.fn(async (route, params) => {
      if (route === "GET /repos/{owner}/{repo}") return { data: liveRepo() };
      if (route === "GET /repos/{owner}/{repo}/issues/{issue_number}") return { data: liveIssue() };
      if (route === "GET /repos/{owner}/{repo}/git/ref/heads/{branch}" && params.branch === "main") {
        return { data: { object: { sha: baseSha } } };
      }
      if (route === "GET /repos/{owner}/{repo}/git/ref/heads/{branch}" && params.branch === "gitwire/fix-42") {
        return { data: { object: { sha: "cccccccccccccccccccccccccccccccccccccccc" } } };
      }
      throw new Error("unexpected route " + route);
    });

    await submitFix(makeCtx({ request }), analysis, validated);

    expect(mockCancel).toHaveBeenCalledWith("action-1", expect.stringContaining("branch already exists"));
    expect(mockCheckAndMark).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledTimes(4);
    expect(request.mock.calls.some(([route]) => route.startsWith("PATCH "))).toBe(false);
    expect(request.mock.calls.some(([route]) => route === "POST /repos/{owner}/{repo}/git/refs")).toBe(false);
  });

  it("uses a repository-scoped marker only after live repo/head/issue/branch-collision fences", async () => {
    const request = successfulSubmissionRequest();

    await submitFix(makeCtx({ request }), analysis, validated);

    expect(mockCheckAndMark).toHaveBeenCalledWith("issue_fix", "repo-99:issue-42");
    const createRefCall = request.mock.calls.find(([route]) => route === "POST /repos/{owner}/{repo}/git/refs");
    expect(createRefCall[1]).toEqual(expect.objectContaining({ ref: "refs/heads/gitwire/fix-42", sha: baseSha }));
    const createPrCall = request.mock.calls.find(([route]) => route === "POST /repos/{owner}/{repo}/pulls");
    expect(createPrCall[1].body).toContain("Triggered by API request");
    expect(mockSucceed).toHaveBeenCalledWith("action-1", expect.objectContaining({ pr_number: 8, base_sha: baseSha }));
  });

  it("cancels the already-executing action when a duplicate marker exists", async () => {
    mockCheckAndMark.mockResolvedValue(false);
    const request = jest.fn(async (route, params) => {
      if (route === "GET /repos/{owner}/{repo}") return { data: liveRepo() };
      if (route === "GET /repos/{owner}/{repo}/issues/{issue_number}") return { data: liveIssue() };
      if (route === "GET /repos/{owner}/{repo}/git/ref/heads/{branch}" && params.branch === "main") {
        return { data: { object: { sha: baseSha } } };
      }
      if (route === "GET /repos/{owner}/{repo}/git/ref/heads/{branch}" && params.branch === "gitwire/fix-42") {
        throw notFoundError();
      }
      throw new Error("unexpected route " + route);
    });

    await submitFix(makeCtx({ request }), analysis, validated);
    expect(mockCancel).toHaveBeenCalledWith("action-1", "Duplicate issue-fix submission");
    expect(request).toHaveBeenCalledTimes(4); // live repository + default head + live issue + target branch absence
  });
});
