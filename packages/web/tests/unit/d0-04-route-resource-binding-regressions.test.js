// D0-04: observe-only route authorization must bind the same repository
// resource the action/waiver handler will mutate.

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
const WAIVER_GRANT_RESOLVER = "body.repo -> repositories";
const WAIVER_REVOKE_RESOLVER = "waiver id -> waivers.repo_id -> repositories";
const REPOSITORY_ROW = {
  github_id: 9001,
  installation_id: 7001,
  owner: "octo",
  name: "wire",
};

function expectedResource() {
  return {
    type: "repository",
    installationId: 7001,
    repositoryId: 9001,
    organization: "octo",
    repository: "wire",
  };
}

describe("D0-04 route resource binding regressions", () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockAuthorize.mockClear();
    mockResolveStoredCIRunIdentifier.mockReset();
  });

  test("action IDs use the same parseInt semantics as the action handlers", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [REPOSITORY_ROW] });

    await expect(
      resolveResource("repository", { id: "1e3" }, ACTION_RESOLVER),
    ).resolves.toEqual(expectedResource());

    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining("FROM managed_actions a"),
      [1],
    );
  });

  test("waiver grant resolves req.body.repo to authoritative repository ids", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [REPOSITORY_ROW] });

    await expect(
      resolveResource(
        "repository",
        {},
        WAIVER_GRANT_RESOLVER,
        { repo: "octo/wire" },
      ),
    ).resolves.toEqual(expectedResource());

    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining("WHERE r.full_name = $1"),
      ["octo/wire"],
    );
  });

  test("waiver grant observer passes the request body into resource resolution", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [REPOSITORY_ROW] });
    const req = {
      path: "/api/waivers",
      method: "POST",
      body: { repo: "octo/wire", pillar: "ci_healing", reason: "test", grantedBy: "operator" },
      auth: { principalId: "principal-1", authenticationMethod: "api_key" },
      _wave2Observed: false,
    };
    const next = jest.fn();

    await routeAuthObserver(req, {}, next);

    expect(mockAuthorize).toHaveBeenCalledWith({
      principal: req.auth,
      permission: "repository:update",
      resource: expectedResource(),
    });
    expect(next).toHaveBeenCalledTimes(1);
  });

  test("waiver revoke uses the handler's radix-10 parseInt semantics and waiver repo binding", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [REPOSITORY_ROW] });

    await expect(
      resolveResource("repository", { id: "42tail" }, WAIVER_REVOKE_RESOLVER),
    ).resolves.toEqual(expectedResource());

    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining("FROM policy_waivers w"),
      [42],
    );
  });

  test("unknown waiver repository does not manufacture authoritative ids", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await expect(
      resolveResource("repository", { id: "404" }, WAIVER_REVOKE_RESOLVER),
    ).resolves.toEqual({
      type: "repository",
      organization: null,
      repository: null,
    });
  });
});
