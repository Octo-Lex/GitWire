import { jest } from "@jest/globals";

const mockQuery = jest.fn();
const mockWarn = jest.fn();

jest.unstable_mockModule("../../src/lib/db.js", () => ({ db: { query: mockQuery } }));
jest.unstable_mockModule("../../src/lib/logger.js", () => ({
  logger: { info: jest.fn(), warn: mockWarn, error: jest.fn(), debug: jest.fn() },
}));

const { logDecision } = await import("../../src/services/auth/decisionLog.js");

const decision = {
  principalId: "p1",
  permission: "policy_rollout_plan:approve",
  resource: { type: "policy_rollout_plan" },
  allowed: false,
  code: "permission_missing",
};

describe("decision log persistence result", () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockWarn.mockReset();
  });

  test("returns true after a successful insert", async () => {
    mockQuery.mockResolvedValue({ rowCount: 1 });
    await expect(logDecision(decision, { principalId: "p1" }, { disagreement: true }))
      .resolves.toBe(true);
    expect(mockWarn).not.toHaveBeenCalled();
  });

  test("returns false without throwing after an insert failure", async () => {
    const err = new Error("write failed");
    mockQuery.mockRejectedValue(err);
    await expect(logDecision(decision, { principalId: "p1" }, { disagreement: true }))
      .resolves.toBe(false);
    expect(mockWarn).toHaveBeenCalledWith(
      { err, code: "permission_missing" },
      "decisionLog: insert failed (non-fatal)",
    );
  });
});
