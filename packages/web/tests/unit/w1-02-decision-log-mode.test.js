// W1-02: persisted decision evidence must distinguish observe from enforced mode.

import { jest } from "@jest/globals";

const mockQuery = jest.fn();
const mockLoggerWarn = jest.fn();

jest.unstable_mockModule("../../src/lib/db.js", () => ({
  db: { query: mockQuery },
}));

jest.unstable_mockModule("../../src/lib/logger.js", () => ({
  logger: { info: jest.fn(), warn: mockLoggerWarn, error: jest.fn(), debug: jest.fn() },
}));

const { logDecision } = await import("../../src/services/auth/decisionLog.js");

const decision = Object.freeze({
  principalId: "principal-1",
  permission: "repository:update",
  resource: Object.freeze({
    type: "repository",
    installationId: 7,
    repositoryId: 11,
    organization: "trusted-owner",
    repository: "trusted-repo",
  }),
  allowed: false,
  code: "permission_missing",
  matchedAssignmentId: null,
  matchedScopeType: null,
  policyVersion: "level1",
  authenticationMethod: "api_key",
  detail: null,
});

describe("W1-02 decision-log mode truth", () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockLoggerWarn.mockReset();
    mockQuery.mockResolvedValue({ rows: [] });
  });

  test("explicit enforced evidence persists observe_mode=false", async () => {
    await expect(logDecision(decision, null, { observeMode: false })).resolves.toBe(true);

    expect(mockQuery).toHaveBeenCalledTimes(1);
    const [, values] = mockQuery.mock.calls[0];
    expect(values[13]).toBe(false);
  });

  test("legacy/default evidence remains observe_mode=true", async () => {
    await expect(logDecision(decision, null)).resolves.toBe(true);

    expect(mockQuery).toHaveBeenCalledTimes(1);
    const [, values] = mockQuery.mock.calls[0];
    expect(values[13]).toBe(true);
  });

  test("only explicit false can mark evidence enforced", async () => {
    await expect(logDecision(decision, null, { observeMode: "false" })).resolves.toBe(true);

    const [, values] = mockQuery.mock.calls[0];
    expect(values[13]).toBe(true);
  });
});
