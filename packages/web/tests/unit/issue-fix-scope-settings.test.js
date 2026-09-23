// D0-02 — maintainer issue-fix label settings remain part of effective eligibility.

import { beforeEach, describe, expect, it, jest } from "@jest/globals";

const mockDbQuery = jest.fn();
const mockGetSettings = jest.fn();
const mockUpsert = jest.fn();
const mockComment = jest.fn();
const mockBuildIssueSnapshot = jest.fn();
const mockIsFixLabelAllowed = jest.fn((label, config) => {
  const allowed = config?.pillars?.issue_fix?.allowed_labels || [];
  return allowed.map((value) => value.toLowerCase()).includes(label.toLowerCase());
});

jest.unstable_mockModule("../../src/lib/db.js", () => ({ db: { query: mockDbQuery } }));
jest.unstable_mockModule("../../src/services/maintainerService.js", () => ({
  maintainerService: { getSettings: mockGetSettings },
}));
jest.unstable_mockModule("@gitwire/rules", () => ({ isFixLabelAllowed: mockIsFixLabelAllowed }));
jest.unstable_mockModule("../../src/services/issueFixTargetService.js", () => ({
  buildIssueFixIssueSnapshot: mockBuildIssueSnapshot,
}));
jest.unstable_mockModule("../../src/workers/issueFix/helpers.js", () => ({
  upsertFixAttempt: mockUpsert,
  postIssueComment: mockComment,
}));
jest.unstable_mockModule("../../src/lib/logger.js", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const { validateScope } = await import("../../src/workers/issueFix/scopeGuard.js");

function requestForSnapshot() {
  return jest.fn(async (route) => {
    if (route === "GET /repos/{owner}/{repo}/issues/{issue_number}") {
      return { data: { id: 4200, number: 42, state: "open", title: "Task", body: "Do it", labels: [{ name: "maintenance" }] } };
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
}

beforeEach(() => {
  jest.clearAllMocks();
  mockDbQuery
    .mockResolvedValueOnce({ rows: [] })
    .mockResolvedValueOnce({ rows: [{ cnt: 0 }] });
  mockGetSettings.mockResolvedValue({ fix_allowed_labels: ["maintenance"] });
  mockBuildIssueSnapshot.mockReturnValue({
    github_id: "4200",
    number: 42,
    state: "open",
    title: "Task",
    body: "Do it",
    labels: ["maintenance"],
    is_pull_request: false,
    updated_at: null,
  });
  mockUpsert.mockResolvedValue({});
  mockComment.mockResolvedValue({});
});

describe("issue-fix maintainer label override", () => {
  it("uses maintainer fix_allowed_labels for the actual eligibility decision", async () => {
    const request = requestForSnapshot();
    const scope = await validateScope({
      octokit: { request },
      owner: "octo",
      repoName: "repo",
      repoId: "99",
      issueNumber: 42,
      branchName: "gitwire/fix-42",
      repoConfig: { pillars: { issue_fix: { allowed_labels: ["bug"] } } },
    });

    expect(scope).toEqual(expect.objectContaining({
      baseSha: "commit-sha",
      defaultBranch: "main",
      tree: ["src/a.js"],
      settings: { fix_allowed_labels: ["maintenance"] },
    }));
    expect(mockIsFixLabelAllowed).toHaveBeenCalledWith(
      "maintenance",
      expect.objectContaining({
        pillars: expect.objectContaining({
          issue_fix: expect.objectContaining({ allowed_labels: ["maintenance"] }),
        }),
      }),
    );
    expect(mockComment).not.toHaveBeenCalledWith(
      expect.anything(), expect.anything(), expect.anything(), expect.anything(),
      expect.stringContaining("not eligible"),
    );
  });

  it("keeps a prior live PR in rate-limit accounting after a dry-run status overwrite", async () => {
    mockDbQuery.mockReset();
    mockGetSettings.mockResolvedValue({
      fix_allowed_labels: ["maintenance"],
      fix_per_issue_limit: 1,
      fix_daily_limit: 3,
    });
    mockDbQuery.mockImplementation(async (sql) => {
      if (sql.includes("issue_number = $2")) {
        return sql.includes("pr_number IS NOT NULL")
          ? { rows: [{ status: "dry_run", pr_number: 88 }] }
          : { rows: [] };
      }
      if (sql.includes("COUNT(*)")) return { rows: [{ cnt: 0 }] };
      throw new Error("unexpected SQL " + sql);
    });
    const request = jest.fn();

    const scope = await validateScope({
      octokit: { request },
      owner: "octo",
      repoName: "repo",
      repoId: "99",
      issueNumber: 42,
      branchName: "gitwire/fix-42",
      repoConfig: { pillars: { issue_fix: { allowed_labels: ["maintenance"] } } },
    });

    expect(scope).toBeNull();
    expect(request).not.toHaveBeenCalled();
    expect(mockDbQuery.mock.calls[0][0]).toContain("pr_number IS NOT NULL");
    expect(mockComment).toHaveBeenCalledWith(
      expect.anything(), "octo", "repo", 42,
      expect.stringContaining("rate limited"),
    );
  });
});
