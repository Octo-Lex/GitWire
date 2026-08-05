// tests/integration/gp05-routes-contract.test.js
// GP-05 HTTP route-contract tests via real Express router.
// Tests exact-key whitelist enforcement: rejects unknown keys, arrays, null,
// strings, NaN, fractions, negatives, infinities, omitted required fields.
// Also verifies permitted expectedBindingRevision: null for forward promotion.

import { jest } from "@jest/globals";

// Mock the service layer (contract-level: verify HTTP → service call boundary)
jest.unstable_mockModule("../../src/services/governedPolicyService.js", () => ({
  promoteChangeRequest: jest.fn(async () => ({ outcome: "succeeded", promotionRecordId: "p1", bindingId: "b1", bindingRevision: "0", failureCode: null })),
  createRollbackRequest: jest.fn(async () => ({ rollbackRecordId: "r1", status: "requested", statusRevision: "0" })),
  approveRollbackRequest: jest.fn(async () => ({ rollbackRecordId: "r1", status: "approved", statusRevision: "1" })),
  rejectRollbackRequest: jest.fn(async () => ({ rollbackRecordId: "r1", status: "rejected", statusRevision: "1" })),
  withdrawRollbackRequest: jest.fn(async () => ({ rollbackRecordId: "r1", status: "withdrawn", statusRevision: "1" })),
  promoteRollbackRequest: jest.fn(async () => ({ outcome: "succeeded", promotionRecordId: "p2", status: "promoted" })),
  getActiveBindings: jest.fn(async () => []),
  getPromotionRecords: jest.fn(async () => []),
  getRollbackRequests: jest.fn(async () => []),
  createChangeRequest: jest.fn(), createVersion: jest.fn(), selectVersion: jest.fn(),
  submitChangeRequest: jest.fn(), getChangeRequest: jest.fn(), listChangeRequests: jest.fn(),
  getVersions: jest.fn(), getTransitionEvents: jest.fn(), createApprovalRule: jest.fn(),
  recordApproval: jest.fn(), revokeApproval: jest.fn(), expireApproval: jest.fn(),
  evaluateApprovals: jest.fn(), approveChangeRequest: jest.fn(), getApprovalRules: jest.fn(),
  getApprovals: jest.fn(), evaluateChangeRequest: jest.fn(), getValidationEvidence: jest.fn(),
  getSimulationEvidence: jest.fn(),
}));

jest.unstable_mockModule("../../src/services/auth/observeAdopt.js", () => ({
  observeAuthorize: jest.fn(async () => ({ allowed: true, code: "allowed" })),
  authoritativePrincipalId: jest.fn(() => "test-principal-id"),
}));

jest.unstable_mockModule("../../src/lib/logger.js", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const { default: express } = await import("express");
const { governedPolicyRouter } = await import("../../src/routes/governedPolicy.js");
const svc = await import("../../src/services/governedPolicyService.js");

async function postJson(path, body) {
  const app = express();
  app.use(express.json());
  app.use("/api/policy", governedPolicyRouter);
  const res = await new Promise((resolve) => {
    const server = app.listen(0, () => {
      const port = server.address().port;
      fetch(`http://127.0.0.1:${port}/api/policy${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }).then(async (r) => {
        const json = await r.json().catch(() => null);
        resolve({ status: r.status, body: json });
        server.close();
      });
    });
  });
  return res;
}

describe("GP-05 route: forward promotion whitelist", () => {
  beforeEach(() => jest.clearAllMocks());

  it("accepts valid body with expectedBindingRevision: null", async () => {
    const res = await postJson("/change-requests/cr-1/promote", { expectedStateRevision: 5, expectedBindingRevision: null });
    expect(res.status).toBe(200);
    expect(svc.promoteChangeRequest).toHaveBeenCalledWith(expect.objectContaining({ expectedBindingRevision: null }));
  });

  it("accepts valid body with numeric bindingRevision", async () => {
    const res = await postJson("/change-requests/cr-1/promote", { expectedStateRevision: 5, expectedBindingRevision: 2 });
    expect(res.status).toBe(200);
    expect(svc.promoteChangeRequest).toHaveBeenCalledWith(expect.objectContaining({ expectedBindingRevision: 2 }));
  });

  it("rejects unknown extra key", async () => {
    const res = await postJson("/change-requests/cr-1/promote", { expectedStateRevision: 5, extra: "bad" });
    expect(res.status).toBe(400);
    expect(svc.promoteChangeRequest).not.toHaveBeenCalled();
  });

  it("rejects omitted required field", async () => {
    const res = await postJson("/change-requests/cr-1/promote", { expectedBindingRevision: 2 });
    expect(res.status).toBe(400);
  });

  it("rejects negative revision", async () => {
    const res = await postJson("/change-requests/cr-1/promote", { expectedStateRevision: -1, expectedBindingRevision: null });
    expect(res.status).toBe(400);
  });

  it("rejects fractional revision", async () => {
    const res = await postJson("/change-requests/cr-1/promote", { expectedStateRevision: 1.5, expectedBindingRevision: null });
    expect(res.status).toBe(400);
  });

  it("rejects NaN-equivalent string", async () => {
    const res = await postJson("/change-requests/cr-1/promote", { expectedStateRevision: "abc", expectedBindingRevision: null });
    expect(res.status).toBe(400);
  });

  it("rejects Infinity", async () => {
    const res = await postJson("/change-requests/cr-1/promote", { expectedStateRevision: Infinity, expectedBindingRevision: null });
    expect(res.status).toBe(400);
  });
});

describe("GP-05 route: rollback create whitelist", () => {
  beforeEach(() => jest.clearAllMocks());

  it("rejects null body", async () => {
    const res = await postJson("/bindings/b1/rollback-requests", null);
    expect(res.status).toBe(400);
  });

  it("rejects array body", async () => {
    const res = await postJson("/bindings/b1/rollback-requests", [1, 2]);
    expect(res.status).toBe(400);
  });

  it("rejects string body", async () => {
    const res = await postJson("/bindings/b1/rollback-requests", "hello");
    expect(res.status).toBe(400);
  });

  it("rejects omitted targetVersionId", async () => {
    const res = await postJson("/bindings/b1/rollback-requests", { expectedBindingRevision: 1 });
    expect(res.status).toBe(400);
  });

  it("rejects empty targetVersionId", async () => {
    const res = await postJson("/bindings/b1/rollback-requests", { expectedBindingRevision: 1, targetVersionId: "" });
    expect(res.status).toBe(400);
  });
});

describe("GP-05 route: rollback transition whitelist (approve/reject/withdraw)", () => {
  beforeEach(() => jest.clearAllMocks());

  it("approve accepts valid body", async () => {
    const res = await postJson("/rollback-requests/r1/approve", { expectedStatusRevision: 0 });
    expect(res.status).toBe(200);
  });

  it("approve rejects extra key", async () => {
    const res = await postJson("/rollback-requests/r1/approve", { expectedStatusRevision: 0, foo: "bar" });
    expect(res.status).toBe(400);
  });

  it("reject rejects negative", async () => {
    const res = await postJson("/rollback-requests/r1/reject", { expectedStatusRevision: -1 });
    expect(res.status).toBe(400);
  });

  it("withdraw accepts valid body", async () => {
    const res = await postJson("/rollback-requests/r1/withdraw", { expectedStatusRevision: 0 });
    expect(res.status).toBe(200);
  });
});

describe("GP-05 route: rollback promotion whitelist", () => {
  beforeEach(() => jest.clearAllMocks());

  it("accepts valid body", async () => {
    const res = await postJson("/rollback-requests/r1/promote", { expectedStatusRevision: 1, expectedBindingRevision: 2 });
    expect(res.status).toBe(200);
  });

  it("rejects omitted expectedBindingRevision", async () => {
    const res = await postJson("/rollback-requests/r1/promote", { expectedStatusRevision: 1 });
    expect(res.status).toBe(400);
  });

  it("rejects null bindingRevision (not permitted for rollback)", async () => {
    const res = await postJson("/rollback-requests/r1/promote", { expectedStatusRevision: 1, expectedBindingRevision: null });
    expect(res.status).toBe(400);
  });
});
