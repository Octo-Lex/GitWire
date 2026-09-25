// D0-04: declaration-driven route observation must preserve Wave-2
// evidence before suppressing route-local duplicate observations.

import { jest } from "@jest/globals";

const mockAuthorizeWithPersistence = jest.fn();
const mockLogDecision = jest.fn();
const mockLoggerInfo = jest.fn();
const mockLoggerWarn = jest.fn();

jest.unstable_mockModule("../../src/services/auth/authorize.js", () => ({
  authorizeWithPersistence: mockAuthorizeWithPersistence,
}));
jest.unstable_mockModule("../../src/services/auth/decisionLog.js", () => ({
  logDecision: mockLogDecision,
}));
jest.unstable_mockModule("../../src/lib/logger.js", () => ({
  logger: {
    info: mockLoggerInfo,
    warn: mockLoggerWarn,
    error: jest.fn(),
    debug: jest.fn(),
  },
}));
jest.unstable_mockModule("../../src/services/routeResourceResolver.js", () => ({
  resolveRouteResource: jest.fn(),
  SUPPORTED_ROUTE_RESOURCE_RESOLVERS: Object.freeze([]),
}));

const { observeDeclarationAuthorization } = await import("../../src/middleware/routeAuthObserver.js");

describe("D0-04 declaration-driven evidence", () => {
  beforeEach(() => {
    mockAuthorizeWithPersistence.mockReset();
    mockLogDecision.mockReset();
    mockLoggerInfo.mockReset();
    mockLoggerWarn.mockReset();
  });

  test("records disagreement metadata before marking a denied request observed", async () => {
    const decision = Object.freeze({ allowed: false, code: "scope_mismatch" });
    mockAuthorizeWithPersistence.mockResolvedValue({ decision, persisted: true });
    mockLogDecision.mockResolvedValue(true);
    const req = {
      auth: { principalId: "principal-1", authenticationMethod: "api_key" },
    };
    const resource = {
      type: "policy_rollout_plan",
      resourceId: "42",
      installationId: 7,
      repositoryId: 11,
    };

    await expect(observeDeclarationAuthorization(req, {
      permission: "policy_rollout_plan:approve",
      resource,
      surfaceId: "route:POST:/api/rollouts/:id/approve",
    })).resolves.toBe(decision);

    expect(mockAuthorizeWithPersistence).toHaveBeenCalledWith({
      principal: req.auth,
      permission: "policy_rollout_plan:approve",
      resource,
    });
    expect(mockLogDecision).toHaveBeenCalledWith(
      decision,
      req.auth,
      { legacyExpected: true, disagreement: true },
    );
    expect(req._wave2Observed).toBe(true);
    expect(req._wave2DeclarationObserved).toBe(true);
    expect(req._wave2DeclarationDecision).toBe(decision);
  });

  test("marks an allowed request observed only when its base decision persisted", async () => {
    const decision = Object.freeze({ allowed: true, code: "allowed" });
    mockAuthorizeWithPersistence.mockResolvedValue({ decision, persisted: true });
    const req = { auth: { principalId: "principal-1" } };

    await expect(observeDeclarationAuthorization(req, {
      permission: "repository:update",
      resource: { type: "repository", installationId: 7, repositoryId: 11 },
    })).resolves.toBe(decision);

    expect(mockLogDecision).not.toHaveBeenCalled();
    expect(req._wave2Observed).toBe(true);
    expect(req._wave2DeclarationObserved).toBe(true);
    expect(req._wave2DeclarationDecision).toBe(decision);
  });

  test("preserves route-local fallback when the base decision row was not persisted", async () => {
    const decision = Object.freeze({ allowed: true, code: "allowed" });
    mockAuthorizeWithPersistence.mockResolvedValue({ decision, persisted: false });
    const req = { auth: { principalId: "principal-1" } };

    await expect(observeDeclarationAuthorization(req, {
      permission: "repository:update",
      resource: { type: "repository", installationId: 7, repositoryId: 11 },
      surfaceId: "route:PATCH:/api/config/:owner/:repo",
    })).resolves.toBe(decision);

    expect(req._wave2Observed).toBeUndefined();
    expect(req._wave2DeclarationObserved).toBeUndefined();
    expect(req._wave2DeclarationDecision).toBeUndefined();
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({
        permission: "repository:update",
        code: "allowed",
        surface: "route:PATCH:/api/config/:owner/:repo",
      }),
      "routeAuthObserver: base decision evidence was not persisted; preserving route-local fallback",
    );
  });

  test("preserves route-local fallback when disagreement evidence is not persisted", async () => {
    const decision = Object.freeze({ allowed: false, code: "permission_missing" });
    mockAuthorizeWithPersistence.mockResolvedValue({ decision, persisted: true });
    mockLogDecision.mockResolvedValue(false);
    const req = { auth: { principalId: "principal-1" } };

    await expect(observeDeclarationAuthorization(req, {
      permission: "policy_rollout_plan:approve",
      resource: { type: "policy_rollout_plan", resourceId: "42" },
      surfaceId: "route:POST:/api/rollouts/:id/approve",
    })).resolves.toBe(decision);

    expect(req._wave2Observed).toBeUndefined();
    expect(req._wave2DeclarationObserved).toBeUndefined();
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({
        permission: "policy_rollout_plan:approve",
        code: "permission_missing",
        surface: "route:POST:/api/rollouts/:id/approve",
      }),
      "routeAuthObserver: disagreement evidence was not persisted; preserving route-local fallback",
    );
  });
});
