// D0-02 — repository analysis must be anchored to one exact commit/tree and one eligible issue target.

import { beforeEach, describe, expect, it, jest } from "@jest/globals";

const mockDbQuery = jest.fn();
const mockGetSettings = jest.fn();
const mockUpsert = jest.fn();
const mockComment = jest.fn();

jest.unstable_mockModule("../../src/lib/db.js", () => ({ db: { query: mockDbQuery } }));
jest.unstable_mockModule("../../src/services/maintainerService.js", () => ({
  maintainerService: { getSettings: mockGetSettings },
}));
jest.unstable_mockModule("@gitwire/rules", () => ({ isFixLabelAllowed: jest.fn(() => true) }));
jest.unstable_mockModule("../../src/workers/issueFix/helpers.js", () => ({
  upsertFixAttempt: mockUpsert,
  postIssueComment: mockComment,
}));
jest.unstable_mockModule("../../src/lib/logger.js", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const { validateScope } = await import("../../src/workers/issueFix/scopeGuard.js");

const openIssue = {
  id: 123456,
  number: 42,
  state: "open",
  title: "Bug",
  body: "Broken",
  labels: [{ name: "bug" }],
  updated_at: "2026-09-23T20:00:00Z",
};

function makeCtx(request) {
  return {
    octokit: { request },
    owner: "octo",
    repoName: "repo",
    repoId: "99",
    issueNumber: 42,
    branchName: "gitwire/fix-42",
    repoConfig: { pillars: { issue_fix: { allowed_labels: ["bug"] } } },
    repo: "octo/repo",
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetSettings.mockResolvedValue({});
  mockDbQuery
    .mockResolvedValueOnce({ rows: [] })
    .mockResolvedValueOnce({ rows: [{ cnt: 0 }] });
  mockUpsert.mockResolvedValue({});
  mockComment.mockResolvedValue({});
});

describe("issue-fix exact repository + issue snapshot", () => {
  it("resolves branch head commit to an immutable tree before analysis", async () => {
    const request = jest.fn(async (route) => {
      if (route === "GET /repos/{owner}/{repo}/issues/{issue_number}") {
        return { data: openIssue };
      }
      if (route === "GET /repos/{owner}/{repo}") return { data: { default_branch: "main" } };
      if (route === "GET /repos/{owner}/{repo}/git/ref/heads/{branch}") {
        return { data: { object: { sha: "commit-sha" } } };
      }
      if (route === "GET /repos/{owner}/{repo}/git/commits/{commit_sha}") {
        return { data: { tree: { sha: "tree-sha" } } };
      }
      if (route === "GET /repos/{owner}/{repo}/git/trees/{tree_sha}") {
        return { data: { tree: [{ type: "blob", path: "src/a.js" }] } };
      }
      throw new Error("unexpected route " + route);
    });

    const scope = await validateScope(makeCtx(request));

    expect(scope).toEqual(expect.objectContaining({
      baseSha: "commit-sha",
      defaultBranch: "main",
      tree: ["src/a.js"],
      issueSnapshot: expect.objectContaining({
        github_id: "123456",
        number: 42,
        state: "open",
        is_pull_request: false,
      }),
    }));
    expect(request).toHaveBeenCalledWith(
      "GET /repos/{owner}/{repo}/git/commits/{commit_sha}",
      { owner: "octo", repo: "repo", commit_sha: "commit-sha" },
    );
    expect(request).toHaveBeenCalledWith(
      "GET /repos/{owner}/{repo}/git/trees/{tree_sha}",
      { owner: "octo", repo: "repo", tree_sha: "tree-sha", recursive: 1 },
    );
  });

  it("rejects a pull request returned by GitHub's Issues API", async () => {
    const request = jest.fn(async (route) => {
      if (route === "GET /repos/{owner}/{repo}/issues/{issue_number}") {
        return { data: { ...openIssue, pull_request: { url: "https://api.github.test/pr/42" } } };
      }
      throw new Error("repository snapshot must not be fetched for PR target");
    });

    await expect(validateScope(makeCtx(request))).resolves.toBeNull();
    expect(mockUpsert).toHaveBeenCalledWith(
      "99", 42, "gitwire/fix-42", "rejected", null, null,
      "Target is a pull request, not an issue",
    );
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("rejects a closed issue before repository analysis", async () => {
    const request = jest.fn(async (route) => {
      if (route === "GET /repos/{owner}/{repo}/issues/{issue_number}") {
        return { data: { ...openIssue, state: "closed" } };
      }
      throw new Error("repository snapshot must not be fetched for closed issue");
    });

    await expect(validateScope(makeCtx(request))).resolves.toBeNull();
    expect(mockUpsert).toHaveBeenCalledWith(
      "99", 42, "gitwire/fix-42", "rejected", null, null,
      "Issue is not open",
    );
    expect(request).toHaveBeenCalledTimes(1);
  });
});
