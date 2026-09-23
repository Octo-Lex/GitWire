// D0-01 — canonical stored CI-run identifier resolution.

import { jest } from "@jest/globals";

const mockQuery = jest.fn();
jest.unstable_mockModule("../../src/lib/db.js", () => ({
  db: { query: mockQuery },
}));

const { resolveStoredCIRunIdentifier } = await import("../../src/services/ciRunResolver.js");

beforeEach(() => {
  mockQuery.mockReset();
});

const storedRun = {
  ci_run_id: "42",
  github_run_id: "30123456789",
  repo_github_id: "99002",
  owner: "octo",
  name: "repo",
  full_name: "octo/repo",
  installation_id: "99001",
};

describe("stored CI-run identifier resolver", () => {
  it("rejects non-numeric identifiers without querying trusted state", async () => {
    await expect(resolveStoredCIRunIdentifier("not-a-run")).resolves.toEqual({ status: "invalid" });
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("resolves one stored run using the shared internal-id or GitHub-id query", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [storedRun] });

    const result = await resolveStoredCIRunIdentifier("30123456789");

    expect(result).toEqual({ status: "resolved", run: storedRun });
    expect(mockQuery).toHaveBeenCalledTimes(1);
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toContain("cr.id::text = $1 OR cr.github_run_id::text = $1");
    expect(sql).toContain("ORDER BY CASE WHEN cr.id::text = $1 THEN 0 ELSE 1 END");
    expect(sql).toContain("LIMIT 2");
    expect(params).toEqual(["30123456789"]);
  });

  it("returns not_found when neither identifier namespace matches", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await expect(resolveStoredCIRunIdentifier("99999")).resolves.toEqual({ status: "not_found" });
  });

  it("fails closed when an internal id collides with another row's GitHub run id", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        storedRun,
        { ...storedRun, ci_run_id: "30123456789", github_run_id: "77777" },
      ],
    });

    await expect(resolveStoredCIRunIdentifier("30123456789")).resolves.toEqual({ status: "ambiguous" });
  });

  it("does not expose an arbitrary matching row when lookup is ambiguous", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [storedRun, { ...storedRun, ci_run_id: "43", github_run_id: "42" }],
    });

    const result = await resolveStoredCIRunIdentifier("42");

    expect(result.status).toBe("ambiguous");
    expect(result.run).toBeUndefined();
  });
});
