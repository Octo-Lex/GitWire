// D0-04: declaration observation must follow Express path semantics without
// letting malformed path encoding escape the observe-only non-fatal boundary.

import { jest } from "@jest/globals";

const mockAuthorizeWithPersistence = jest.fn();
const mockResolveRouteResource = jest.fn();
const mockLogDecision = jest.fn();
const mockLoggerWarn = jest.fn();

jest.unstable_mockModule("../../src/services/auth/authorize.js", () => ({
  authorizeWithPersistence: mockAuthorizeWithPersistence,
}));
jest.unstable_mockModule("../../src/services/auth/decisionLog.js", () => ({
  logDecision: mockLogDecision,
}));
jest.unstable_mockModule("../../src/lib/logger.js", () => ({
  logger: {
    info: jest.fn(),
    warn: mockLoggerWarn,
    error: jest.fn(),
    debug: jest.fn(),
  },
}));
jest.unstable_mockModule("../../src/services/routeResourceResolver.js", () => ({
  resolveRouteResource: mockResolveRouteResource,
  SUPPORTED_ROUTE_RESOURCE_RESOLVERS: Object.freeze([
    "action id -> managed action -> repository",
  ]),
}));
jest.unstable_mockModule("../../src/services/auth/declarations.js", () => ({
  registerAllProtectedSurfaces: jest.fn(),
}));
jest.unstable_mockModule("../../src/services/auth/protectedSurfaces.js", () => ({
  listProtectedSurfaces: () => [{
    id: "route:POST:/api/actions/:id/retry",
    kind: "route",
    permission: "repository:github:act",
    resourceType: "repository",
    resourceResolver: "action id -> managed action -> repository",
    authorizationMode: "observe",
  }],
}));

const { routeAuthObserver } = await import("../../src/middleware/routeAuthObserver.js");

describe("D0-04 route observer path semantics", () => {
  beforeEach(() => {
    mockAuthorizeWithPersistence.mockReset();
    mockResolveRouteResource.mockReset();
    mockLogDecision.mockReset();
    mockLoggerWarn.mockReset();

    mockResolveRouteResource.mockResolvedValue({
      type: "repository",
      installationId: 7,
      repositoryId: 11,
    });
    mockAuthorizeWithPersistence.mockResolvedValue({
      decision: Object.freeze({ allowed: true, code: "allowed" }),
      persisted: true,
    });
  });

  test("observes the optional trailing-slash form accepted by Express non-strict routing", async () => {
    const req = {
      path: "/api/actions/42/retry/",
      method: "POST",
      auth: { principalId: "principal-1" },
      body: {},
    };
    const next = jest.fn();

    await expect(routeAuthObserver(req, {}, next)).resolves.toBeUndefined();

    expect(mockResolveRouteResource).toHaveBeenCalledWith(
      "repository",
      { id: "42" },
      "action id -> managed action -> repository",
      {},
    );
    expect(mockAuthorizeWithPersistence).toHaveBeenCalledTimes(1);
    expect(req._wave2Observed).toBe(true);
    expect(next).toHaveBeenCalledTimes(1);
  });

  test("observes case variants accepted by Express case-insensitive routing", async () => {
    const req = {
      path: "/API/ACTIONS/42/RETRY",
      method: "POST",
      auth: { principalId: "principal-1" },
      body: {},
    };
    const next = jest.fn();

    await expect(routeAuthObserver(req, {}, next)).resolves.toBeUndefined();

    expect(mockResolveRouteResource).toHaveBeenCalledWith(
      "repository",
      { id: "42" },
      "action id -> managed action -> repository",
      {},
    );
    expect(mockAuthorizeWithPersistence).toHaveBeenCalledTimes(1);
    expect(req._wave2Observed).toBe(true);
    expect(next).toHaveBeenCalledTimes(1);
  });

  test("decodes a valid encoded parameter exactly once before trusted resolution", async () => {
    const req = {
      path: "/api/actions/a%252Fb/retry",
      method: "POST",
      auth: { principalId: "principal-1" },
      body: {},
    };
    const next = jest.fn();

    await routeAuthObserver(req, {}, next);

    expect(mockResolveRouteResource).toHaveBeenCalledWith(
      "repository",
      { id: "a%2Fb" },
      "action id -> managed action -> repository",
      {},
    );
    expect(next).toHaveBeenCalledTimes(1);
  });

  test("malformed percent-encoding stays non-fatal and does not use a raw identity fallback", async () => {
    const req = {
      path: "/api/actions/%zz/retry",
      method: "POST",
      auth: { principalId: "principal-1" },
      body: {},
    };
    const next = jest.fn();

    await expect(routeAuthObserver(req, {}, next)).resolves.toBeUndefined();

    expect(mockResolveRouteResource).not.toHaveBeenCalled();
    expect(mockAuthorizeWithPersistence).not.toHaveBeenCalled();
    expect(req._wave2Observed).toBeUndefined();
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({
        err: expect.any(URIError),
        path: "/api/actions/%zz/retry",
        surface: "route:POST:/api/actions/:id/retry",
      }),
      "routeAuthObserver: authorize failed (non-fatal)",
    );
    expect(next).toHaveBeenCalledTimes(1);
  });
});
