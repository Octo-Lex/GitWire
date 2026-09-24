// D0-02 — recovery semantics after the issue-fix submission marker is consumed.

import { beforeEach, describe, expect, it, jest } from "@jest/globals";

const mockSucceed = jest.fn();
const mockFail = jest.fn();
const mockCancel = jest.fn();
const mockCheckAndMark = jest.fn();
const mockClearIdempotencyKey = jest.fn();
const mockNotify = jest.fn(() => Promise.resolve());
const mockResolve = jest.fn();
const mockSameBinding = jest.fn();
const mockBuildIssueSnapshot = jest.fn();
const mockSameIssueSnapshot = jest.fn();
const mockUpsert = jest.fn();
const mockComment = jest.fn();

jest.unstable_mockModule("../../src/services/actionStateMachine.js", () => ({
  succeed: mockSucceed,
  fail: mockFail,
  cancel: mockCancel,
}));
jest.unstable_mockModule("../../src/services/idempotencyService.js", () => ({
  checkAndMark: mockCheckAndMark,
  clearIdempotencyKey: mockClearIdempotencyKey,
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
  github_id: "99",
  installation_id: "77",
  full_name: "octo/repo",
  owner: "octo",
  name: "repo",
  default_branch: "main",
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
const analysis = {
  complexity: "simple",
  explanation: "fix it",
  relevant_files: ["src/a.js"],
  fix_strategy: "change a",
};
const validated = {
  fixes: [{ path: "src/a.js", fixed_content: "new", explanation: "change" }],
  fileContents: [{ path: "src/a.js", content: "old", sha: "blobsha" }],
  fixAction: { id: "action-1" },
};

function makeCtx(request) {
  return {
    octokit: { request },
    owner: "octo",
    repoName: "repo",
    repoId: "99",
    issueNumber: 42,
    branchName: "gitwire/fix-42",
    repo: "octo/repo",
    repository,
    triggeredBy: "api",
    _scope: {
      baseSha,
      defaultBranch: "main",
      issue: { id: 123456, number: 42, state: "open", title: "Bug", body: "Broken", labels: [{ name: "bug" }] },
      issueSnapshot,
    },
  };
}

function liveRepo() {
  return { id: 99, full_name: "octo/repo", default_branch: "main" };
}

function liveIssue() {
  return {
    id: 123456,
    number: 42,
    state: "open",
    title: "Bug",
    body: "Broken",
    labels: [{ name: "bug" }],
    updated_at: "2026-09-23T20:01:00Z",
  };
}

function httpError(status, message) {
  const err = new Error(message || String(status));
  err.status = status;
  return err;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockResolve.mockResolvedValue({ status: "resolved", repository });
  mockSameBinding.mockReturnValue(true);
  mockBuildIssueSnapshot.mockReturnValue({ ...issueSnapshot, updated_at: "2026-09-23T20:01:00Z" });
  mockSameIssueSnapshot.mockReturnValue(true);
  mockCheckAndMark.mockResolvedValue(true);
  mockClearIdempotencyKey.mockResolvedValue(undefined);
  mockSucceed.mockResolvedValue({});
  mockFail.mockResolvedValue({});
  mockCancel.mockResolvedValue({});
  mockUpsert.mockResolvedValue({});
  mockComment.mockResolvedValue({});
});

describe("issue-fix submission recovery", () => {
  it("classifies a check/create race as a no-effect supersession and requests marker release", async () => {
    let targetRefReads = 0;
    const request = jest.fn(async (route, params) => {
      if (route === "GET /repos/{owner}/{repo}") return { data: liveRepo() };
      if (route === "GET /repos/{owner}/{repo}/issues/{issue_number}") return { data: liveIssue() };
      if (route === "GET /repos/{owner}/{repo}/git/ref/heads/{branch}" && params.branch === "main") {
        return { data: { object: { sha: baseSha } } };
      }
      if (route === "GET /repos/{owner}/{repo}/git/ref/heads/{branch}" && params.branch === "gitwire/fix-42") {
        targetRefReads++;
        if (targetRefReads === 1) throw httpError(404, "not found");
        return { data: { object: { sha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" } } };
      }
      if (route === "POST /repos/{owner}/{repo}/git/refs") throw httpError(422, "reference already exists");
      throw new Error("unexpected route " + route);
    });

    await submitFix(makeCtx(request), analysis, validated);

    expect(mockCheckAndMark).toHaveBeenCalledWith("issue_fix", "repo-99:issue-42");
    expect(mockClearIdempotencyKey).toHaveBeenCalledWith("issue_fix", "repo-99:issue-42");
    expect(mockCancel).toHaveBeenCalledWith("action-1", expect.stringContaining("branch appeared"));
    expect(mockFail).not.toHaveBeenCalled();
    expect(request.mock.calls.some(([route]) => route === "PUT /repos/{owner}/{repo}/contents/{path}")).toBe(false);
    expect(request.mock.calls.some(([route]) => route.startsWith("PATCH "))).toBe(false);
    expect(request.mock.calls.some(([route]) => route === "DELETE /repos/{owner}/{repo}/git/refs/{ref}")).toBe(false);
  });

  it("posts visible no-effect feedback when a legacy submission marker deduplicates a retry", async () => {
    mockCheckAndMark.mockResolvedValue(false);
    const request = jest.fn(async (route, params) => {
      if (route === "GET /repos/{owner}/{repo}") return { data: liveRepo() };
      if (route === "GET /repos/{owner}/{repo}/issues/{issue_number}") return { data: liveIssue() };
      if (route === "GET /repos/{owner}/{repo}/git/ref/heads/{branch}" && params.branch === "main") {
        return { data: { object: { sha: baseSha } } };
      }
      if (route === "GET /repos/{owner}/{repo}/git/ref/heads/{branch}" && params.branch === "gitwire/fix-42") {
        throw httpError(404, "not found");
      }
      throw new Error("unexpected route " + route);
    });

    await submitFix(makeCtx(request), analysis, validated);

    expect(mockCancel).toHaveBeenCalledWith("action-1", "Duplicate issue-fix submission");
    expect(mockComment).toHaveBeenCalledWith(
      expect.anything(), "octo", "repo", 42,
      expect.stringContaining("retry deferred"),
    );
    expect(mockComment).toHaveBeenCalledWith(
      expect.anything(), "octo", "repo", 42,
      expect.stringContaining("did not mutate GitHub"),
    );
    expect(request.mock.calls.some(([route]) => !route.startsWith("GET "))).toBe(false);
  });

  it("preserves a partial branch after a write failure and keeps the legacy marker", async () => {
    const request = jest.fn(async (route, params) => {
      if (route === "GET /repos/{owner}/{repo}") return { data: liveRepo() };
      if (route === "GET /repos/{owner}/{repo}/issues/{issue_number}") return { data: liveIssue() };
      if (route === "GET /repos/{owner}/{repo}/git/ref/heads/{branch}" && params.branch === "main") {
        return { data: { object: { sha: baseSha } } };
      }
      if (route === "GET /repos/{owner}/{repo}/git/ref/heads/{branch}" && params.branch === "gitwire/fix-42") {
        throw httpError(404, "not found");
      }
      if (route === "POST /repos/{owner}/{repo}/git/refs") return { data: {} };
      if (route === "PUT /repos/{owner}/{repo}/contents/{path}") throw new Error("transient write failure");
      throw new Error("unexpected route " + route);
    });

    await submitFix(makeCtx(request), analysis, validated);

    expect(request.mock.calls.some(([route]) => route === "DELETE /repos/{owner}/{repo}/git/refs/{ref}")).toBe(false);
    expect(mockClearIdempotencyKey).not.toHaveBeenCalled();
    expect(mockFail).toHaveBeenCalledWith("action-1", "transient write failure");
    expect(mockComment).toHaveBeenCalledWith(
      expect.anything(), "octo", "repo", 42,
      expect.stringContaining("preserved any issue-fix branch created during this attempt"),
    );
    expect(mockComment).toHaveBeenCalledWith(
      expect.anything(), "octo", "repo", 42,
      expect.stringContaining("did not automatically clear the legacy submission marker"),
    );
  });

  it("never deletes the branch when PR creation may have succeeded but its response is lost", async () => {
    const request = jest.fn(async (route, params) => {
      if (route === "GET /repos/{owner}/{repo}") return { data: liveRepo() };
      if (route === "GET /repos/{owner}/{repo}/issues/{issue_number}") return { data: liveIssue() };
      if (route === "GET /repos/{owner}/{repo}/git/ref/heads/{branch}" && params.branch === "main") {
        return { data: { object: { sha: baseSha } } };
      }
      if (route === "GET /repos/{owner}/{repo}/git/ref/heads/{branch}" && params.branch === "gitwire/fix-42") {
        throw httpError(404, "not found");
      }
      if (route === "POST /repos/{owner}/{repo}/git/refs") return { data: {} };
      if (route === "PUT /repos/{owner}/{repo}/contents/{path}") {
        return { data: { commit: { sha: "dddddddddddddddddddddddddddddddddddddddd" } } };
      }
      if (route === "POST /repos/{owner}/{repo}/pulls") {
        throw new Error("socket reset after GitHub may have created the PR");
      }
      throw new Error("unexpected route " + route);
    });

    await submitFix(makeCtx(request), analysis, validated);

    expect(request).toHaveBeenCalledWith(
      "POST /repos/{owner}/{repo}/pulls",
      expect.objectContaining({ head: "gitwire/fix-42", base: "main" }),
    );
    expect(request.mock.calls.some(([route]) => route === "DELETE /repos/{owner}/{repo}/git/refs/{ref}")).toBe(false);
    expect(mockClearIdempotencyKey).not.toHaveBeenCalled();
    expect(mockFail).toHaveBeenCalledWith("action-1", "socket reset after GitHub may have created the PR");
    expect(mockComment).toHaveBeenCalledWith(
      expect.anything(), "octo", "repo", 42,
      expect.stringContaining("a PR or concurrent actor may already depend on the branch"),
    );
    expect(mockComment).toHaveBeenCalledWith(
      expect.anything(), "octo", "repo", 42,
      expect.stringContaining("any matching PR before manual cleanup or retry"),
    );
  });
});
