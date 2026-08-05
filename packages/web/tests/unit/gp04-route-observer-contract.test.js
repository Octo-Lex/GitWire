// tests/unit/gp04-route-observer-contract.test.js
// GP-04 observer contract: prove the exact { permission, resource } arguments
// the three GP-04 routes pass to observeAuthorize. ESM module mocks are
// established before the router's first import (the router is then cached),
// so this is a separate file from the real-observer route e2e test.
//
// observeAdopt is mocked to a recording stub that captures the exact input and
// returns an allowed decision. This test is purely about the router→observer
// call contract; the real observer's behavior is exercised end-to-end in
// gp04-routes-e2e.test.js. The service is also stubbed because DB outcomes are
// irrelevant to this contract.

import { jest } from "@jest/globals";

// ── Recording stub for observeAdopt ───────────────────────────────────────
// Records every { permission, resource } the router passes.
const observeCalls = [];
jest.unstable_mockModule("../../src/services/auth/observeAdopt.js", () => ({
  observeAuthorize: jest.fn(async (_req, input) => {
    observeCalls.push(input);
    return { allowed: true, code: "allowed" };
  }),
  authoritativePrincipalId: jest.fn(() => "contract-principal"),
}));

// Stub the service so no DB path is exercised; this test is contract-only.
// All 19 named exports the route imports must be present to satisfy ESM linking.
const noop = jest.fn(async () => ({}));
jest.unstable_mockModule("../../src/services/governedPolicyService.js", () => ({
  createChangeRequest: noop,
  createVersion: noop,
  selectVersion: noop,
  submitChangeRequest: noop,
  getChangeRequest: noop,
  listChangeRequests: noop,
  getVersions: noop,
  getTransitionEvents: noop,
  createApprovalRule: noop,
  recordApproval: noop,
  revokeApproval: noop,
  expireApproval: noop,
  evaluateApprovals: noop,
  approveChangeRequest: noop,
  getApprovalRules: noop,
  getApprovals: noop,
  evaluateChangeRequest: jest.fn(async () => ({ state: "awaiting_approval", stateRevision: 1, validationEvidenceHash: "sha256:" + "0".repeat(64), simulationEvidenceHash: "sha256:" + "0".repeat(64) })),
  getValidationEvidence: jest.fn(async () => []),
  getSimulationEvidence: jest.fn(async () => []),
  // GP-05 exports imported by the route module under the cumulative graph.
  promoteChangeRequest: noop,
  createRollbackRequest: noop,
  approveRollbackRequest: noop,
  rejectRollbackRequest: noop,
  withdrawRollbackRequest: noop,
  promoteRollbackRequest: noop,
  getActiveBindings: noop,
  getPromotionRecords: noop,
  getRollbackRequests: noop,
}));
jest.unstable_mockModule("../../src/lib/logger.js", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const { default: express } = await import("express");
const http = await import("node:http");
const { governedPolicyRouter } = await import("../../src/routes/governedPolicy.js");

async function withServer(fn) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.auth = { principalId: "contract-principal", authenticationMethod: "api_key" }; next(); });
  app.use("/api/policy", governedPolicyRouter);
  const server = http.createServer(app);
  await new Promise(r => server.listen(0, r));
  const port = server.address().port;
  try { return await fn("http://127.0.0.1:" + port); }
  finally { await new Promise(r => server.close(r)); }
}

describe("GP-04 observer contract — exact observeAuthorize arguments", () => {
  beforeEach(() => { observeCalls.length = 0; });

  it("POST /change-requests/:id/evaluate calls observeAuthorize once with exact args", async () => {
    await withServer(async (base) => {
      const res = await fetch(base + "/api/policy/change-requests/abc-123/evaluate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expectedStateRevision: 0 }),
      });
      expect(res.status).toBe(200);
    });
    // Exactly one invocation from the evaluate route
    const evalCalls = observeCalls.filter(c => c.permission === "policy_change_request:evaluate");
    expect(evalCalls).toHaveLength(1);
    expect(evalCalls[0]).toEqual({
      permission: "policy_change_request:evaluate",
      resource: { type: "policy_definition", resourceId: "abc-123" },
    });
  });

  it("GET /change-requests/:id/validation-evidence calls observeAuthorize once with exact args", async () => {
    await withServer(async (base) => {
      const res = await fetch(base + "/api/policy/change-requests/abc-456/validation-evidence");
      expect(res.status).toBe(200);
    });
    const calls = observeCalls.filter(c => c.permission === "policy_validation_evidence:read");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      permission: "policy_validation_evidence:read",
      resource: { type: "policy_definition", resourceId: "abc-456" },
    });
  });

  it("GET /change-requests/:id/simulation-evidence calls observeAuthorize once with exact args", async () => {
    await withServer(async (base) => {
      const res = await fetch(base + "/api/policy/change-requests/abc-789/simulation-evidence");
      expect(res.status).toBe(200);
    });
    const calls = observeCalls.filter(c => c.permission === "policy_simulation_evidence:read");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      permission: "policy_simulation_evidence:read",
      resource: { type: "policy_definition", resourceId: "abc-789" },
    });
  });
});
