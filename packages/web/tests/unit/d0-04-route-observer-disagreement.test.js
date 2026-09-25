// D0-04: declaration-driven route observation must preserve Wave-2
// disagreement evidence before suppressing route-local duplicate observations.

import { jest } from "@jest/globals";

const mockAuthorize = jest.fn();
const mockLogDecision = jest.fn();
const mockLoggerInfo = jest.fn();
const mockLoggerWarn = jest.fn();

jest.unstable_mockModule("../../src/services/auth/authorize.js", () => ({
  authorize: mockAuthorize,
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

describe("D0-04 declaration-driven disagreement evidence", () => {
  beforeEach(() => {
    mockAuthorize.mockReset();
    mockLogDecision.mockReset();
    mockLoggerInfo.mockReset();
    mockLoggerWarn.mockReset();
  });

  test("records disagreement metadata before marking a denied request observed", async () => {
    const decision = Object.freeze({ allowed: false, code: "scope_mismatch" });
    mockAuthorize.mockResolvedValue(decision);
    mockLogDecision.mockResolvedValue(undefined);
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

    expect(mockAuthorize).toHaveBeenCalledWith({
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
  });

  test("does not add disagreement evidence for an allowed decision", async () => {
    const decision = Object.freeze({ allowed: true, code: "allowed" });
    mockAuthorize.mockResolvedValue(decision);
    const req = { auth: { principalId: "principal-1" } };

    await expect(observeDeclarationAuthorization(req, {
      permission: "policy_rollout_plan:update",
      resource: { type: "policy_rollout_plan", resourceId: "42" },
    })).resolves.toBe(decision);

    expect(mockLogDecision).not.toHaveBeenCalled();
    expect(req._wave2Observed).toBe(true);
  });

  test("leaves the request unmarked when disagreement evidence cannot be persisted", async () => {
    const decision = Object.freeze({ allowed: false, code: "permission_missing" });
    mockAuthorize.mockResolvedValue(decision);
    mockLogDecision.mockRejectedValue(new Error("decision log unavailable"));
    const req = { auth: { principalId: "principal-1" } };

    await expect(observeDeclarationAuthorization(req, {
      permission: "policy_rollout_plan:approve",
      resource: { type: "policy_rollout_plan", resourceId: "42" },
    })).rejects.toThrow("decision log unavailable");

    expect(req._wave2Observed).toBeUndefined();
  });
});
