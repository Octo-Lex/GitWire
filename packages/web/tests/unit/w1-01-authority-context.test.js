// W1-01: request authority context carries the server-resolved principal and
// exact resource as one immutable object without changing observe/enforce mode.

import { jest } from "@jest/globals";

const mockAuthorizeWithPersistence = jest.fn();
const mockLogDecision = jest.fn();

jest.unstable_mockModule("../../src/services/auth/authorize.js", () => ({
  authorizeWithPersistence: mockAuthorizeWithPersistence,
}));
jest.unstable_mockModule("../../src/services/auth/decisionLog.js", () => ({
  logDecision: mockLogDecision,
}));
jest.unstable_mockModule("../../src/lib/logger.js", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.unstable_mockModule("../../src/services/routeResourceResolver.js", () => ({
  resolveRouteResource: jest.fn(),
  SUPPORTED_ROUTE_RESOURCE_RESOLVERS: Object.freeze([]),
}));

const { createAuthorityContext } = await import("../../src/services/auth/context.js");
const { observeDeclarationAuthorization } = await import("../../src/middleware/routeAuthObserver.js");

describe("W1-01 authority context schema", () => {
  beforeEach(() => {
    mockAuthorizeWithPersistence.mockReset();
    mockLogDecision.mockReset();
  });

  test("canonicalizes resource fields and strips caller-only metadata", () => {
    const principal = Object.freeze({ principalId: "principal-1" });
    const authority = createAuthorityContext({
      principal,
      resource: {
        type: "repository",
        installationId: 7,
        repositoryId: 11,
        organization: "trusted-owner",
        repository: "trusted-repo",
        callerRepo: "untrusted-owner/untrusted-repo",
      },
      surfaceId: "route:POST:/api/actions/:id/retry",
    });

    expect(authority).toEqual({
      principal,
      resource: {
        type: "repository",
        installationId: 7,
        repositoryId: 11,
        organization: "trusted-owner",
        repository: "trusted-repo",
        resourceId: null,
      },
      surfaceId: "route:POST:/api/actions/:id/retry",
    });
    expect(Object.isFrozen(authority)).toBe(true);
    expect(Object.isFrozen(authority.resource)).toBe(true);
    expect(authority.resource).not.toHaveProperty("callerRepo");
  });

  test("request observation exposes canonical authority even when evidence persistence falls back", async () => {
    const decision = Object.freeze({ allowed: true, code: "allowed" });
    mockAuthorizeWithPersistence.mockResolvedValue({ decision, persisted: false });

    const principal = Object.freeze({
      principalId: "principal-1",
      principalType: "service",
      authenticationMethod: "api_key",
    });
    const req = { auth: principal };
    const resource = {
      type: "repository",
      installationId: 7,
      repositoryId: 11,
      organization: "trusted-owner",
      repository: "trusted-repo",
    };

    await expect(observeDeclarationAuthorization(req, {
      permission: "repository:update",
      resource,
      surfaceId: "route:PATCH:/api/config/:owner/:repo",
    })).resolves.toBe(decision);

    expect(req.authority).toEqual({
      principal,
      resource: {
        type: "repository",
        installationId: 7,
        repositoryId: 11,
        organization: "trusted-owner",
        repository: "trusted-repo",
        resourceId: null,
      },
      surfaceId: "route:PATCH:/api/config/:owner/:repo",
    });
    expect(Object.isFrozen(req.authority)).toBe(true);
    expect(Object.isFrozen(req.authority.resource)).toBe(true);
    expect(req._wave2Observed).toBeUndefined();
    expect(mockAuthorizeWithPersistence).toHaveBeenCalledWith({
      principal,
      permission: "repository:update",
      resource,
    });
  });
});
