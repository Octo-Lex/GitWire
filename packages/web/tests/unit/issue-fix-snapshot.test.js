// D0-02 — repository analysis must be anchored to one exact commit/tree.

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

beforeEach(() => {
  jest.clearAllMocks();
  mockGetSettings.mockResolvedValue({});
  mockDbQuery
    .mockResolvedValueOnce({ rows: [] })
    .mockResolvedValueOnce({ rows: [{ cnt: 0 }] });
  mockUpsert.mockResolvedValue({});
  mockComment.mockResolvedValue({});
});

describe("issue-fix exact repository snapshot", () => {
  it("resolves branch head commit to an immutable tree before analysis", async () => {
    const request = jest.fn(async (route) => {
      if (route === "GET /repos/{owner}/{repo}/issues/{issue_number}") {
        return { data: { number: 42, title: "Bug", body: "Broken", labels: [{ name: "bug" }] } };
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

    const scope = await validateScope({
      octokit: { request },
      owner: "octo",
      repoName: "repo",
      repoId: "99",
      issueNumber: 42,
      branchName: "gitwire/fix-42",
      repoConfig: { pillars: { issue_fix: {} } },
      repo: "octo/repo",
    });

    expect(scope).toEqual(expect.objectContaining({
      baseSha: "commit-sha",
      defaultBranch: "main",
      tree: ["src/a.js"],
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
});
