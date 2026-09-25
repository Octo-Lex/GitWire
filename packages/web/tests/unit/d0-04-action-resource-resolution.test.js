// D0-04: action lifecycle routes are repository-scoped. The route observer
// must resolve the trusted repository from managed_actions before authorize().

import { jest } from "@jest/globals";

const mockQuery = jest.fn();
const mockAuthorize = jest.fn(async () => ({ allowed: true }));
const mockResolveStoredCIRunIdentifier = jest.fn();

jest.unstable_mockModule("../../src/lib/db.js", () => ({
  db: { query: mockQuery },
}));
jest.unstable_mockModule("../../src/lib/logger.js", () => ({
  logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.unstable_mockModule("../../src/services/auth/authorize.js", () => ({
  authorize: mockAuthorize,
}));
jest.unstable_mockModule("../../src/services/ciRunResolver.js", () => ({
  resolveStoredCIRunIdentifier: mockResolveStoredCIRunIdentifier,
}));

const { resolveResource, routeAuthObserver } =
  await import("../../src/middleware/routeAuthObserver.js");

const ACTION_RESOLVER = "action id -> managed_actions -> repository";
const REPOSITORY_ROW = {
  github_id: 9001,
  installation_id: 7001,
  owner: "octo",
  name: "wire",
};

describe("D0-04 action route resource resolution", () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockAuthorize.mockClear();
    mockResolveStoredCIRunIdentifier.mockReset();
  });

  test("resolves action id through managed_actions to authoritative repository ids", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [REPOSITORY_ROW] });

    await expect(
      resolveResource("repository", { id: "42" }, ACTION_RESOLVER),
    ).resolves.toEqual({
      type: "repository",
      installationId: 7001,
      repositoryId: 9001,
      organization: "octo",
      repository: "wire",
    });

    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining("FROM managed_actions a"),
      [42],
    );
  });

  test("unknown action does not manufacture repository authority", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await expect(
      resolveResource("repository", { id: "404" }, ACTION_RESOLVER),
    ).resolves.toEqual({
      type: "repository",
      organization: null,
      repository: null,
    });
  });

  test("action retry observer authorizes against the resolved repository", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [REPOSITORY_ROW] });
    const req = {
      path: "/api/actions/42/retry",
      method: "POST",
      auth: { principalId: "principal-1", authenticationMethod: "api_key" },
      _wave2Observed: false,
    };
    const next = jest.fn();

    await routeAuthObserver(req, {}, next);

    expect(mockAuthorize).toHaveBeenCalledWith({
      principal: req.auth,
      permission: "repository:update",
      resource: {
        type: "repository",
        installationId: 7001,
        repositoryId: 9001,
        organization: "octo",
        repository: "wire",
      },
    });
    expect(req._wave2Observed).toBe(true);
    expect(next).toHaveBeenCalledTimes(1);
  });
});
