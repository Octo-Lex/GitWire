// tests/unit/gp05-service-contract.test.js
// GP-05 service-layer contract tests (mocked DB).
// Verifies the service functions call the correct SECURITY DEFINER SQL functions
// with the right parameters. Uses jest.unstable_mockModule for db + logger.

import { jest } from "@jest/globals";

const mockDb = { query: jest.fn() };

jest.unstable_mockModule("../../src/lib/db.js", () => ({ db: mockDb }));
jest.unstable_mockModule("../../src/lib/logger.js", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const {
  promoteChangeRequest,
  createRollbackRequest,
  approveRollbackRequest,
  rejectRollbackRequest,
  withdrawRollbackRequest,
  promoteRollbackRequest,
  getActiveBindings,
  getPromotionRecords,
  getRollbackRequests,
} = await import("../../src/services/governedPolicyService.js");

describe("GP-05 service: forward promotion", () => {
  beforeEach(() => mockDb.query.mockClear());

  it("promoteChangeRequest calls promote_policy_change_request with correct params", async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{
        out_promotion_record_id: "promo-1",
        out_outcome: "succeeded",
        out_failure_code: null,
        out_binding_id: "bind-1",
        out_binding_revision: "0",
        out_change_request_id: "cr-1",
        out_new_state: "promoted",
        out_new_state_revision: "5",
      }],
    });

    const result = await promoteChangeRequest({
      changeRequestId: "cr-1",
      expectedStateRevision: 4,
      expectedBindingRevision: null,
      principalId: "pid-1",
    });

    expect(mockDb.query).toHaveBeenCalledTimes(1);
    expect(mockDb.query).toHaveBeenCalledWith(
      "SELECT * FROM gitwire_policy.promote_policy_change_request($1, $2, $3, $4)",
      ["cr-1", 4, null, "pid-1"]
    );
    expect(result.outcome).toBe("succeeded");
    expect(result.promotionRecordId).toBe("promo-1");
    expect(result.bindingId).toBe("bind-1");
  });

  it("promoteChangeRequest handles failed outcome (domain refusal)", async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{
        out_promotion_record_id: "promo-fail",
        out_outcome: "failed",
        out_failure_code: "stale_binding_revision",
        out_binding_id: null,
        out_binding_revision: null,
        out_change_request_id: "cr-2",
        out_new_state: "approved",
        out_new_state_revision: "4",
      }],
    });

    const result = await promoteChangeRequest({
      changeRequestId: "cr-2",
      expectedStateRevision: 4,
      expectedBindingRevision: 0,
      principalId: "pid-2",
    });

    expect(result.outcome).toBe("failed");
    expect(result.failureCode).toBe("stale_binding_revision");
  });
});

describe("GP-05 service: rollback CRUD", () => {
  beforeEach(() => mockDb.query.mockClear());

  it("createRollbackRequest calls create_policy_rollback_request", async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{
        out_rollback_record_id: "rb-1",
        out_status: "requested",
        out_status_revision: "0",
        out_risk_classification: "standard",
        out_target_promotion_record_id: "tpromo-1",
      }],
    });

    const result = await createRollbackRequest({
      bindingId: "bind-1",
      expectedBindingRevision: 1,
      targetVersionId: "v-1",
      principalId: "pid-1",
    });

    expect(mockDb.query).toHaveBeenCalledWith(
      "SELECT * FROM gitwire_policy.create_policy_rollback_request($1, $2, $3, $4)",
      ["bind-1", 1, "v-1", "pid-1"]
    );
    expect(result.rollbackRecordId).toBe("rb-1");
    expect(result.riskClassification).toBe("standard");
  });

  it("approveRollbackRequest calls approve_policy_rollback_request", async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{ out_rollback_record_id: "rb-1", out_status: "approved", out_status_revision: "1" }],
    });

    const result = await approveRollbackRequest({
      rollbackRequestId: "rb-1",
      expectedStatusRevision: 0,
      principalId: "pid-2",
    });

    expect(mockDb.query).toHaveBeenCalledWith(
      "SELECT * FROM gitwire_policy.approve_policy_rollback_request($1, $2, $3)",
      ["rb-1", 0, "pid-2"]
    );
    expect(result.status).toBe("approved");
  });

  it("rejectRollbackRequest calls reject_policy_rollback_request", async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{ out_rollback_record_id: "rb-1", out_status: "rejected", out_status_revision: "1" }],
    });

    const result = await rejectRollbackRequest({
      rollbackRequestId: "rb-1",
      expectedStatusRevision: 0,
      principalId: "pid-2",
    });

    expect(mockDb.query).toHaveBeenCalledWith(
      "SELECT * FROM gitwire_policy.reject_policy_rollback_request($1, $2, $3)",
      ["rb-1", 0, "pid-2"]
    );
    expect(result.status).toBe("rejected");
  });

  it("withdrawRollbackRequest calls withdraw_policy_rollback_request", async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{ out_rollback_record_id: "rb-1", out_status: "withdrawn", out_status_revision: "1" }],
    });

    const result = await withdrawRollbackRequest({
      rollbackRequestId: "rb-1",
      expectedStatusRevision: 0,
      principalId: "pid-1",
    });

    expect(mockDb.query).toHaveBeenCalledWith(
      "SELECT * FROM gitwire_policy.withdraw_policy_rollback_request($1, $2, $3)",
      ["rb-1", 0, "pid-1"]
    );
    expect(result.status).toBe("withdrawn");
  });

  it("promoteRollbackRequest calls promote_policy_rollback_request", async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{
        out_promotion_record_id: "promo-rb-1",
        out_outcome: "succeeded",
        out_failure_code: null,
        out_rollback_record_id: "rb-1",
        out_status: "promoted",
        out_status_revision: "2",
        out_binding_id: "bind-1",
        out_binding_revision: "2",
      }],
    });

    const result = await promoteRollbackRequest({
      rollbackRequestId: "rb-1",
      expectedStatusRevision: 1,
      expectedBindingRevision: 1,
      principalId: "pid-3",
    });

    expect(mockDb.query).toHaveBeenCalledWith(
      "SELECT * FROM gitwire_policy.promote_policy_rollback_request($1, $2, $3, $4)",
      ["rb-1", 1, 1, "pid-3"]
    );
    expect(result.outcome).toBe("succeeded");
    expect(result.status).toBe("promoted");
  });
});

describe("GP-05 service: read surfaces", () => {
  beforeEach(() => { mockDb.query.mockReset(); mockDb.query.mockResolvedValue({ rows: [] }); });

  it("getActiveBindings queries with filters", async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [{ id: "b1", binding_revision: "0" }] });
    const rows = await getActiveBindings({ resourceType: "fleet", resourceId: "fleet", policyFamily: "tp" });
    const [sql, params] = mockDb.query.mock.calls[0];
    expect(sql).toContain("resource_type = $1");
    expect(sql).toContain("policy_family = $3");
    expect(params).toEqual(["fleet", "fleet", "tp"]);
    expect(rows).toHaveLength(1);
  });

  it("getPromotionRecords queries with filters", async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [{ id: "p1" }] });
    await getPromotionRecords({ changeRequestId: "cr-1" });
    const [sql, params] = mockDb.query.mock.calls[0];
    expect(sql).toContain("change_request_id = $1");
    expect(params).toEqual(["cr-1"]);
  });

  it("getRollbackRequests queries with filters", async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [{ id: "r1" }] });
    await getRollbackRequests({ bindingId: "b1", status: "requested" });
    const [sql, params] = mockDb.query.mock.calls[0];
    expect(sql).toContain("binding_id = $1");
    expect(sql).toContain("status = $2");
    expect(params).toEqual(["b1", "requested"]);
  });
});
