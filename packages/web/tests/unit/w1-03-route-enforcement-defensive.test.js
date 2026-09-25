// W1-03: defensive fail-closed behavior when central classification and
// declaration/control plumbing disagree.

import { jest } from "@jest/globals";

const mockAuthorizeControlled = jest.fn();
const mockResolveRouteResource = jest.fn();
const mockLoggerError = jest.fn();

jest.unstable_mockModule("../../src/services/auth/authorize.js", () => ({
  authorizeControlled: mockAuthorizeControlled,
}));
jest.unstable_mockModule("../../src/services/auth/decisionLog.js", () => ({
  logDecision: jest.fn(),
}));
jest.unstable_mockModule("../../src/lib/logger.js", () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: mockLoggerError,
    debug: jest.fn(),
  },
}));
jest.unstable_mockModule("../../src/services/routeResourceResolver.js", () => ({
  resolveRouteResource: mockResolveRouteResource,
  SUPPORTED_ROUTE_RESOURCE_RESOLVERS: Object.freeze([]),
}));
jest.unstable_mockModule("../../src/services/auth/declarations.js", () => ({
  registerAllProtectedSurfaces: jest.fn(),
}));
jest.unstable_mockModule("../../src/services/auth/protectedSurfaces.js", () => ({
  listProtectedSurfaces: () => [{
    id: "route:POST:/api/gates/:owner/:repo/evaluate",
    kind: "route",
    permission: "quality_gate:evaluate",
    resourceType: "repository",
    resourceResolver: "owner/repo -> repositories",
    authorizationMode: "enforced",
  }],
}));

const { routeAuthObserver } = await import("../../src/middleware/routeAuthObserver.js");

function makeResponse() {
  const json = jest.fn();
  const status = jest.fn(() => ({ json }));
  return { status, json };
}

const principal = Object.freeze({
  principalId: "principal-1",
  authenticationMethod: "api_key",
});
const resource = Object.freeze({
  type: "repository",
  installationId: 7,
  repositoryId: 11,
});

describe("W1-03 central enforcement defensive consistency", () => {
  beforeEach(() => {
    mockAuthorizeControlled.mockReset();
    mockResolveRouteResource.mockReset();
    mockLoggerError.mockReset();
    mockResolveRouteResource.mockResolvedValue(resource);
  });

  test("a centrally classified request with no protected declaration fails closed", async () => {
    const req = {
      path: "/api/waivers",
      method: "POST",
      auth: principal,
      body: { repo: "octo/wire" },
    };
    const res = makeResponse();
    const next = jest.fn();

    await routeAuthObserver(req, res, next);

    expect(mockResolveRouteResource).not.toHaveBeenCalled();
    expect(mockAuthorizeControlled).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith({ error: "Authorization unavailable" });
    expect(next).not.toHaveBeenCalled();
  });

  test("an internally inconsistent enforced outcome fails closed instead of reaching the handler", async () => {
    mockAuthorizeControlled.mockResolvedValue(Object.freeze({
      decision: Object.freeze({
        allowed: true,
        code: "allowed",
        permission: "quality_gate:evaluate",
        resource,
      }),
      persisted: true,
      mode: "enforced",
      blocked: true,
    }));
    const req = {
      path: "/api/gates/octo/wire/evaluate",
      method: "POST",
      auth: principal,
      body: {},
    };
    const res = makeResponse();
    const next = jest.fn();

    await routeAuthObserver(req, res, next);

    expect(mockAuthorizeControlled).toHaveBeenCalledTimes(1);
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith({ error: "Authorization unavailable" });
    expect(next).not.toHaveBeenCalled();
  });
});
