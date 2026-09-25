// D0-04: declaration-driven rollout authorization must not emit a second,
// less-specific route-local decision after the app observer succeeds.

import { jest } from "@jest/globals";

const mockObserveAuthorize = jest.fn(async () => ({ allowed: true, code: "allowed" }));

jest.unstable_mockModule("../../src/services/auth/observeAdopt.js", () => ({
  observeAuthorize: mockObserveAuthorize,
  authoritativePrincipalId: jest.fn(() => "principal-1"),
}));
jest.unstable_mockModule("../../src/lib/logger.js", () => ({
  logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.unstable_mockModule("../../src/services/policyRolloutService.js", () => ({
  createRolloutPlan: jest.fn(),
  getRolloutPlan: jest.fn(),
  listRolloutPlans: jest.fn(),
  attachEvidence: jest.fn(),
  transitionRolloutPlan: jest.fn(),
  approveRolloutPlan: jest.fn(),
  rejectRolloutPlan: jest.fn(),
  promoteRolloutPlan: jest.fn(),
  rollbackRolloutPlan: jest.fn(),
}));

const { observeRolloutAuthorize } = await import("../../src/routes/rollouts.js");

describe("D0-04 rollout authorization observation", () => {
  beforeEach(() => {
    mockObserveAuthorize.mockClear();
  });

  test("skips the route-local observation after routeAuthObserver already recorded the request", async () => {
    const req = { _wave2Observed: true };
    const options = {
      permission: "policy_rollout_plan:approve",
      resource: { type: "policy_rollout_plan", resourceId: "42" },
      legacyActor: "operator",
    };

    await expect(observeRolloutAuthorize(req, options)).resolves.toBe(false);
    expect(mockObserveAuthorize).not.toHaveBeenCalled();
  });

  test("retains the route-local observe-only fallback when the app observer did not record", async () => {
    const req = { _wave2Observed: false };
    const options = {
      permission: "policy_rollout_plan:approve",
      resource: { type: "policy_rollout_plan", resourceId: "42" },
      legacyActor: "operator",
    };

    await expect(observeRolloutAuthorize(req, options)).resolves.toBe(true);
    expect(mockObserveAuthorize).toHaveBeenCalledTimes(1);
    expect(mockObserveAuthorize).toHaveBeenCalledWith(req, options);
  });
});
