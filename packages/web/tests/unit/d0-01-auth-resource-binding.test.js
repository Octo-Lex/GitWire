// D0-01 — authorization resource binding must share CI-run identifier semantics.

import { describe, it, expect, beforeEach, jest } from "@jest/globals";

const mockQuery = jest.fn();
const mockDb = { query: mockQuery, transaction: jest.fn(async (fn) => fn({ query: mockQuery })) };
const mockRedis = { get: jest.fn(), setex: jest.fn(), del: jest.fn(), expire: jest.fn() };

jest.unstable_mockModule("../../src/lib/db.js", () => ({ db: mockDb }));
jest.unstable_mockModule("../../src/lib/queue.js", () => ({
  redis: mockRedis,
  webhookEventsQueue: { add: jest.fn() },
  triageQueue: { add: jest.fn() },
}));
jest.unstable_mockModule("../../src/lib/logger.js", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const { resolveResource } = await import("../../src/middleware/routeAuthObserver.js");

beforeEach(() => {
  mockQuery.mockReset();
});

describe("CI-heal authorization resource binding", () => {
  it("resolves a GitHub workflow-run id to the same trusted repository binding as the route", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{
        ci_run_id: "42",
        github_run_id: "30123456789",
        repo_github_id: "99002",
        installation_id: "99001",
        owner: "octo",
        name: "repo",
        full_name: "octo/repo",
      }],
    });

    const resource = await resolveResource("repository", { runId: "30123456789" });

    expect(resource).toEqual({
      type: "repository",
      installationId: "99001",
      repositoryId: "99002",
      organization: "octo",
      repository: "repo",
    });
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toContain("cr.id = $1::bigint OR cr.github_run_id = $1::bigint");
    expect(params).toEqual(["30123456789"]);
  });

  it("does not select a repository when the identifier is ambiguous", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          ci_run_id: "42",
          github_run_id: "30123456789",
          repo_github_id: "99002",
          installation_id: "99001",
          owner: "octo",
          name: "repo",
          full_name: "octo/repo",
        },
        {
          ci_run_id: "30123456789",
          github_run_id: "77777",
          repo_github_id: "88002",
          installation_id: "88001",
          owner: "other",
          name: "repo",
          full_name: "other/repo",
        },
      ],
    });

    await expect(resolveResource("repository", { runId: "30123456789" })).resolves.toEqual({
      type: "repository",
      organization: null,
      repository: null,
    });
  });

  it("does not query or invent authority for an invalid run id", async () => {
    for (const runId of ["not-a-run", "0", "9223372036854775808"]) {
      await expect(resolveResource("repository", { runId })).resolves.toEqual({
        type: "repository",
        organization: null,
        repository: null,
      });
    }
    expect(mockQuery).not.toHaveBeenCalled();
  });
});
