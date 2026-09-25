// W1-02: central authorize() control semantics without route/worker cutover.

import { jest } from "@jest/globals";

const mockQuery = jest.fn();
const mockLogDecision = jest.fn();
const mockGetPrincipalById = jest.fn();
const mockPrincipalValidityCode = jest.fn();

jest.unstable_mockModule("../../src/lib/db.js", () => ({
  db: { query: mockQuery },
}));

jest.unstable_mockModule("../../src/lib/logger.js", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.unstable_mockModule("../../src/services/auth/principalResolver.js", () => ({
  getPrincipalById: mockGetPrincipalById,
  principalValidityCode: mockPrincipalValidityCode,
}));

jest.unstable_mockModule("../../src/services/auth/decisionLog.js", () => ({
  logDecision: mockLogDecision,
}));

const {
  AuthorizationMode,
  authorizeControlled,
} = await import("../../src/services/auth/authorize.js");
const {
  createAuthorizationOutcome,
} = await import("../../src/services/auth/authorizationMode.js");
const {
  RouteAuthorizationMode,
} = await import("../../src/services/auth/routeAuthorizationModes.js");

describe("W1-02 central authorization mode", () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockLogDecision.mockReset();
    mockGetPrincipalById.mockReset();
    mockPrincipalValidityCode.mockReset();
    mockLogDecision.mockResolvedValue(true);
  });

  test("route classification reuses the central mode vocabulary", () => {
    expect(RouteAuthorizationMode).toBe(AuthorizationMode);
    expect(RouteAuthorizationMode.OBSERVE).toBe("observe");
    expect(RouteAuthorizationMode.ENFORCED).toBe("enforced");
  });

  test("denial remains advisory and is logged as observe-mode in observe mode", async () => {
    const result = await authorizeControlled({
      principal: null,
      permission: "repository:update",
      resource: { type: "repository" },
      mode: AuthorizationMode.OBSERVE,
    });

    expect(result.decision.allowed).toBe(false);
    expect(result.mode).toBe("observe");
    expect(result.blocked).toBe(false);
    expect(result.persisted).toBe(true);
    expect(Object.isFrozen(result)).toBe(true);
    expect(mockLogDecision).toHaveBeenCalledWith(
      result.decision,
      null,
      { observeMode: true },
    );
  });

  test("denial becomes blocking and is logged as enforced in enforced mode", async () => {
    const result = await authorizeControlled({
      principal: null,
      permission: "repository:update",
      resource: { type: "repository" },
      mode: AuthorizationMode.ENFORCED,
    });

    expect(result.decision.allowed).toBe(false);
    expect(result.mode).toBe("enforced");
    expect(result.blocked).toBe(true);
    expect(result.persisted).toBe(true);
    expect(mockLogDecision).toHaveBeenCalledWith(
      result.decision,
      null,
      { observeMode: false },
    );
  });

  test("omitted mode preserves legacy observe-only behavior", async () => {
    const result = await authorizeControlled({
      principal: null,
      permission: "repository:update",
      resource: { type: "repository" },
    });

    expect(result.mode).toBe("observe");
    expect(result.blocked).toBe(false);
    expect(mockLogDecision).toHaveBeenCalledWith(
      result.decision,
      null,
      { observeMode: true },
    );
  });

  test("an allowed enforced decision never blocks and is logged as enforced", async () => {
    const principal = Object.freeze({
      principalId: "principal-1",
      authenticationMethod: "api_key",
    });
    mockGetPrincipalById.mockResolvedValue({ id: "principal-1" });
    mockPrincipalValidityCode.mockReturnValue("allowed");
    mockQuery.mockResolvedValue({
      rows: [{ assignment_id: "assignment-1", scope_type: "fleet" }],
    });

    const result = await authorizeControlled({
      principal,
      permission: "fleet:update",
      resource: { type: "fleet" },
      mode: AuthorizationMode.ENFORCED,
    });

    expect(result.decision.allowed).toBe(true);
    expect(result.mode).toBe("enforced");
    expect(result.blocked).toBe(false);
    expect(mockLogDecision).toHaveBeenCalledWith(
      result.decision,
      principal,
      { observeMode: false },
    );
  });

  test("outcome helper keeps allowed decisions non-blocking in enforced mode", () => {
    const decision = Object.freeze({ allowed: true, code: "allowed" });
    const result = createAuthorizationOutcome({
      decision,
      persisted: true,
      mode: AuthorizationMode.ENFORCED,
    });

    expect(result.decision).toBe(decision);
    expect(result.mode).toBe("enforced");
    expect(result.blocked).toBe(false);
  });

  test("unknown mode is rejected before authorization evaluation or logging", async () => {
    await expect(authorizeControlled({
      principal: null,
      permission: "repository:update",
      resource: { type: "repository" },
      mode: "enforce",
    })).rejects.toThrow("Unknown authorization mode: enforce");

    expect(mockLogDecision).not.toHaveBeenCalled();
    expect(mockQuery).not.toHaveBeenCalled();
    expect(mockGetPrincipalById).not.toHaveBeenCalled();
  });
});
