import { jest } from "@jest/globals";

const mockAuthorize = jest.fn();
const mockLogDecision = jest.fn();

jest.unstable_mockModule("../../src/services/auth/authorize.js", () => ({ authorize: mockAuthorize }));
jest.unstable_mockModule("../../src/services/auth/decisionLog.js", () => ({ logDecision: mockLogDecision }));
jest.unstable_mockModule("../../src/lib/logger.js", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const { observeAuthorize } = await import("../../src/services/auth/observeAdopt.js");

const resource = {
  type: "repository",
  installationId: 7,
  repositoryId: 11,
  organization: "octo",
  repository: "wire",
};

describe("D0-04 route-local observation de-duplication", () => {
  beforeEach(() => {
    mockAuthorize.mockReset();
    mockLogDecision.mockReset();
  });

  test("reuses a matching persisted declaration decision without writing again", async () => {
    const declarationDecision = Object.freeze({
      allowed: false,
      code: "permission_missing",
      permission: "repository:update",
      resource: Object.freeze({ ...resource, resourceId: null }),
    });
    const req = {
      _wave2Observed: true,
      _wave2DeclarationObserved: true,
      _wave2DeclarationDecision: declarationDecision,
      auth: { principalId: "p1" },
    };

    await expect(observeAuthorize(req, {
      permission: "repository:update",
      resource,
      legacyActor: "dashboard",
    })).resolves.toEqual({ allowed: false, code: "permission_missing" });

    expect(mockAuthorize).not.toHaveBeenCalled();
    expect(mockLogDecision).not.toHaveBeenCalled();
  });

  test("runs the local observer when the declaration permission differs", async () => {
    const declarationDecision = Object.freeze({
      allowed: true,
      code: "allowed",
      permission: "repository:read",
      resource: Object.freeze({ ...resource, resourceId: null }),
    });
    mockAuthorize.mockResolvedValue(Object.freeze({ allowed: true, code: "allowed" }));
    const req = {
      _wave2Observed: true,
      _wave2DeclarationObserved: true,
      _wave2DeclarationDecision: declarationDecision,
      auth: { principalId: "p1" },
    };

    await expect(observeAuthorize(req, {
      permission: "repository:update",
      resource,
      legacyActor: "dashboard",
    })).resolves.toEqual({ allowed: true, code: "allowed" });

    expect(mockAuthorize).toHaveBeenCalledWith({
      principal: req.auth,
      permission: "repository:update",
      resource,
    });
  });

  test("runs the route-local observer when no declaration decision was persisted", async () => {
    const decision = Object.freeze({ allowed: true, code: "allowed" });
    mockAuthorize.mockResolvedValue(decision);
    const req = { auth: { principalId: "p1" } };

    await expect(observeAuthorize(req, {
      permission: "repository:update",
      resource,
      legacyActor: "dashboard",
    })).resolves.toEqual({ allowed: true, code: "allowed" });

    expect(mockAuthorize).toHaveBeenCalledWith({
      principal: req.auth,
      permission: "repository:update",
      resource,
    });
    expect(req._wave2Observed).toBe(true);
  });
});
