// D0-02 — trusted repository/installation resolution for issue-fix work.

import { beforeEach, describe, expect, it, jest } from "@jest/globals";

const mockQuery = jest.fn();
jest.unstable_mockModule("../../src/lib/db.js", () => ({ db: { query: mockQuery } }));

const {
  resolveIssueFixRepositoryByFullName,
  resolveIssueFixRepositoryById,
  sameIssueFixRepositoryBinding,
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

  it("re-resolves current installation by stable GitHub repository id", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ ...row, installation_id: "123456" }] });
    const resolved = await resolveIssueFixRepositoryById("99002");
    expect(resolved.repository.installation_id).toBe("123456");
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toContain("r.github_id = $1::bigint");
    expect(params).toEqual(["99002"]);
  });

  it("rejects invalid ids without querying", async () => {
    for (const id of ["0", "-1", "abc", "9223372036854775808"]) {
      await expect(resolveIssueFixRepositoryById(id)).resolves.toEqual({ status: "invalid" });
    }
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("detects authority drift across installation or repository name", () => {
    expect(sameIssueFixRepositoryBinding(row, { ...row })).toBe(true);
    expect(sameIssueFixRepositoryBinding(row, { ...row, installation_id: "2" })).toBe(false);
    expect(sameIssueFixRepositoryBinding(row, { ...row, full_name: "new/repo" })).toBe(false);
  });
});
