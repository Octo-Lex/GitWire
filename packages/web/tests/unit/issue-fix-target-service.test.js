// D0-02 — trusted repository/installation resolution and issue-target snapshots.

import { beforeEach, describe, expect, it, jest } from "@jest/globals";

const mockQuery = jest.fn();
jest.unstable_mockModule("../../src/lib/db.js", () => ({ db: { query: mockQuery } }));

const {
  resolveIssueFixRepositoryByFullName,
  resolveIssueFixRepositoryById,
  sameIssueFixRepositoryBinding,
  buildIssueFixIssueSnapshot,
  sameIssueFixIssueSnapshot,
} = await import("../../src/services/issueFixTargetService.js");

beforeEach(() => mockQuery.mockReset());

const row = {
  github_id: "99002",
  installation_id: "99001",
  full_name: "octo/repo",
  owner: "octo",
  name: "repo",
  default_branch: "main",
};

const issue = {
  id: 123456,
  number: 42,
  state: "open",
  title: "Bug",
  body: "Broken behavior",
  labels: [{ name: "Bug" }, { name: "help wanted" }],
  updated_at: "2026-09-23T20:00:00Z",
};

describe("issue-fix trusted target resolver", () => {
  it("resolves owner/repo only from active repository + active installation state", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [row] });
    await expect(resolveIssueFixRepositoryByFullName("octo/repo")).resolves.toEqual({
      status: "resolved",
      repository: row,
    });
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toContain("i.deleted_at IS NULL");
    expect(sql).toContain("r.deleted_at IS NULL");
    expect(params).toEqual(["octo/repo"]);
  });

  it("fails closed when active full_name mapping is ambiguous", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [row, { ...row, github_id: "99003" }] });
    await expect(resolveIssueFixRepositoryByFullName("octo/repo")).resolves.toEqual({ status: "ambiguous" });
  });

  it("fails closed when DB ids cannot survive current Number-based auth infrastructure", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ ...row, github_id: "9007199254740992" }] });
    await expect(resolveIssueFixRepositoryByFullName("octo/repo")).resolves.toEqual({ status: "unsupported_identifier" });

    mockQuery.mockResolvedValueOnce({ rows: [{ ...row, installation_id: "9007199254740992" }] });
    await expect(resolveIssueFixRepositoryByFullName("octo/repo")).resolves.toEqual({ status: "unsupported_identifier" });
  });

  it("re-resolves current installation by stable GitHub repository id", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ ...row, installation_id: "123456" }] });
    const resolved = await resolveIssueFixRepositoryById("99002");
    expect(resolved.repository.installation_id).toBe("123456");
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toContain("r.github_id = $1::bigint");
    expect(params).toEqual(["99002"]);
  });

  it("rejects invalid or unsafe ids without querying", async () => {
    for (const [id, status] of [
      ["0", "invalid"],
      ["-1", "invalid"],
      ["abc", "invalid"],
      ["9223372036854775808", "invalid"],
      ["9007199254740992", "unsupported_identifier"],
    ]) {
      await expect(resolveIssueFixRepositoryById(id)).resolves.toEqual({ status });
    }
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("detects authority drift across installation or repository name", () => {
    expect(sameIssueFixRepositoryBinding(row, { ...row })).toBe(true);
    expect(sameIssueFixRepositoryBinding(row, { ...row, installation_id: "2" })).toBe(false);
    expect(sameIssueFixRepositoryBinding(row, { ...row, full_name: "new/repo" })).toBe(false);
  });
});

describe("issue-fix issue intent snapshot", () => {
  it("canonicalizes labels and retains updated_at as evidence", () => {
    expect(buildIssueFixIssueSnapshot(issue)).toEqual({
      github_id: "123456",
      number: 42,
      state: "open",
      title: "Bug",
      body: "Broken behavior",
      labels: ["bug", "help wanted"],
      is_pull_request: false,
      updated_at: "2026-09-23T20:00:00Z",
    });
  });

  it("ignores comment-only updated_at movement and label ordering/case", () => {
    const expected = buildIssueFixIssueSnapshot(issue);
    const current = buildIssueFixIssueSnapshot({
      ...issue,
      labels: [{ name: "HELP WANTED" }, { name: "bug" }],
      updated_at: "2026-09-23T20:05:00Z",
    });
    expect(sameIssueFixIssueSnapshot(expected, current)).toBe(true);
  });

  it.each([
    [{ title: "Different" }, "title"],
    [{ body: "Changed requirements" }, "body"],
    [{ state: "closed" }, "state"],
    [{ labels: [{ name: "documentation" }] }, "labels"],
    [{ pull_request: { url: "https://api.github.test/pr/42" } }, "pull request target"],
    [{ id: 999999 }, "identity"],
    [{ number: 43 }, "number"],
  ])("detects %s drift", (overrides) => {
    const expected = buildIssueFixIssueSnapshot(issue);
    const current = buildIssueFixIssueSnapshot({ ...issue, ...overrides });
    expect(sameIssueFixIssueSnapshot(expected, current)).toBe(false);
  });

  it("fails closed when the issue snapshot is structurally incomplete", () => {
    expect(buildIssueFixIssueSnapshot({ number: 42, state: "open" })).toBeNull();
    expect(sameIssueFixIssueSnapshot(buildIssueFixIssueSnapshot(issue), null)).toBe(false);
  });
});
