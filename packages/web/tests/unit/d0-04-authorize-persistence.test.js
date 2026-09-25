import { jest } from "@jest/globals";

const mockQuery = jest.fn();
const mockLogDecision = jest.fn();
const mockGetPrincipalById = jest.fn();
const mockPrincipalValidityCode = jest.fn();

jest.unstable_mockModule("../../src/lib/db.js", () => ({ db: { query: mockQuery } }));
jest.unstable_mockModule("../../src/lib/logger.js", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.unstable_mockModule("../../src/services/auth/decisionLog.js", () => ({ logDecision: mockLogDecision }));
jest.unstable_mockModule("../../src/services/auth/principalResolver.js", () => ({
  getPrincipalById: mockGetPrincipalById,
  principalValidityCode: mockPrincipalValidityCode,
}));

const { authorize, authorizeWithPersistence } = await import("../../src/services/auth/authorize.js");

const opts = {
  principal: { principalId: "p1", authenticationMethod: "api_key" },
  permission: "repository:update",
  resource: {
    type: "repository",
    installationId: 7,
    repositoryId: 11,
    organization: "octo",
    repository: "wire",
  },
};

describe("D0-04 authorization persistence reporting", () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockLogDecision.mockReset();
    mockGetPrincipalById.mockReset();
    mockPrincipalValidityCode.mockReset();
    mockGetPrincipalById.mockResolvedValue({ id: "p1" });
    mockPrincipalValidityCode.mockReturnValue("allowed");
    mockQuery.mockResolvedValue({
      rows: [{ assignment_id: "a1", scope_type: "repository", permission: "repository:update" }],
    });
  });

  test("persistence-aware API exposes a swallowed base-log failure", async () => {
    mockLogDecision.mockResolvedValue(false);

    const result = await authorizeWithPersistence(opts);

    expect(result.persisted).toBe(false);
    expect(result.decision).toEqual(expect.objectContaining({
      allowed: true,
      code: "allowed",
      permission: "repository:update",
    }));
  });

  test("legacy authorize API remains decision-only and backward compatible", async () => {
    mockLogDecision.mockResolvedValue(true);

    const decision = await authorize(opts);

    expect(decision).toEqual(expect.objectContaining({
      allowed: true,
      code: "allowed",
      permission: "repository:update",
    }));
    expect(decision.persisted).toBeUndefined();
  });
});
