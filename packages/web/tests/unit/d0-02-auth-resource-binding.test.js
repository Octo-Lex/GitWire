// D0-02 — route authorization must resolve the same active repository binding
// as Autonomous Contributor admission and fail closed on ambiguity.

import { beforeEach, describe, expect, it, jest } from "@jest/globals";

const mockQuery = jest.fn();
const mockDb = { query: mockQuery, transaction: jest.fn(async (fn) => fn({ query: mockQuery })) };
const mockRedis = { get: jest.fn(), setex: jest.fn(), del: jest.fn(), expire: jest.fn() };

jest.unstable_mockModule("../../src/lib/db.js", () => ({ db: mockDb }));
jest.unstable_mockModule("../../src/lib/queue.js", () => ({
  redis: mockRedis, webhookEventsQueue: { add: jest.fn() }, triageQueue: { add: jest.fn() },
}));
jest.unstable_mockModule("../../src/lib/logger.js", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const { resolveResource } = await import("../../src/middleware/routeAuthObserver.js");

beforeEach(() => mockQuery.mockReset());

describe("owner/repo authorization resource binding", () => {
  it("uses exactly one active repository + active installation row", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{
      github_id: "99002", installation_id: "99001", owner: "octo", name: "repo",
    }] });

    await expect(resolveResource("repository", { owner: "octo", repo: "repo" })).resolves.toEqual({
      type: "repository",
      installationId: "99001",
      repositoryId: "99002",
      organization: "octo",
      repository: "repo",
    });
    const [sql] = mockQuery.mock.calls[0];
    expect(sql).toContain("r.deleted_at IS NULL");
    expect(sql).toContain("i.deleted_at IS NULL");
    expect(sql).toContain("LIMIT 2");
  });

  it("does not select authority by row order when full_name is ambiguous", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [
      { github_id: "1", installation_id: "11", owner: "octo", name: "repo" },
      { github_id: "2", installation_id: "22", owner: "octo", name: "repo" },
    ] });

    await expect(resolveResource("repository", { owner: "octo", repo: "repo" })).resolves.toEqual({
      type: "repository",
      organization: "octo",
      repository: "repo",
    });
  });
});
