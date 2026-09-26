// W2-02 canonical promotion service regressions.

import { jest } from "@jest/globals";

const mockQuery = jest.fn();
const mockTxQuery = jest.fn();
const mockTransaction = jest.fn(async (fn) => fn({ query: mockTxQuery }));
const mockAuthorizeControlled = jest.fn();
const mockInvalidateConfigCache = jest.fn();

jest.unstable_mockModule("../../src/lib/db.js", () => ({
  db: { query: mockQuery, transaction: mockTransaction },
}));
jest.unstable_mockModule("../../src/services/auth/authorize.js", () => ({
  authorizeControlled: mockAuthorizeControlled,
}));
jest.unstable_mockModule("../../src/services/configService.js", () => ({
  invalidateConfigCache: mockInvalidateConfigCache,
}));

const {
  promotePolicyRollout,
  PolicyPromotionError,
  POLICY_PROMOTION_PERMISSION,
} = await import("../../src/services/policyPromotionService.js");

const authorId = "11111111-1111-4111-8111-111111111111";
const approverId = "22222222-2222-4222-8222-222222222222";
const promoterId = "33333333-3333-4333-8333-333333333333";
const changeRequestId = "44444444-4444-4444-8444-444444444444";
const versionId = "55555555-5555-4555-8555-555555555555";
const approvalId = "66666666-6666-4666-8666-666666666666";
const evidenceId = "77777777-7777-4777-8777-777777777777";
const promotionId = "88888888-8888-4888-8888-888888888888";
const repoId = "9001";

const promoterPrincipal = Object.freeze({
  principalId: promoterId,
  authenticationMethod: "session",
});

function allowedOutcome() {
  return {
    decision: { allowed: true, code: "allowed" },
    persisted: true,
    mode: "enforced",
    blocked: false,
  };
}

function installHarness({
  basePolicyVersionId = null,
  active = null,
  rolloutStatus = "approved",
  proposedMatches = true,
  authorPrincipalId = authorId,
  approvalDecision = "approved",
  validationValid = true,
} = {}) {
  mockAuthorizeControlled.mockResolvedValue(allowedOutcome());

  mockQuery.mockImplementation(async (sql) => {
    const q = sql.replace(/\s+/g, " ").trim();
    if (q.includes("FROM policy_rollout_plans p") && q.includes("JOIN repositories r")) {
      return {
        rows: [{
          repo_id: repoId,
          repository_id: repoId,
          installation_id: 7,
          full_name: "trusted-owner/trusted-repo",
        }],
      };
    }
    throw new Error(`Unhandled outer SQL: ${q}`);
  });

  mockTxQuery.mockImplementation(async (sql, params = []) => {
    const q = sql.replace(/\s+/g, " ").trim();

    if (q.includes("FROM repositories") && q.includes("FOR UPDATE")) {
      return {
        rows: [{
          repository_id: repoId,
          installation_id: 7,
          full_name: "trusted-owner/trusted-repo",
        }],
      };
    }

    if (q.includes("FROM active_policy_bindings apb")) {
      return { rows: active ? [active] : [] };
    }

    if (q.startsWith("SELECT config FROM repo_config")) {
      return { rows: [{ config: { previous: true } }] };
    }

    if (q.includes("FROM policy_change_requests cr") && q.includes("JOIN policy_versions pv")) {
      return {
        rows: [{
          change_request_id: changeRequestId,
          rollout_plan_id: 42,
          repo_id: repoId,
          policy_version_id: versionId,
          author_principal_id: authorPrincipalId,
          base_policy_version_id: basePolicyVersionId,
          policy_document: { dry_run: true, review: { enabled: true } },
          content_hash: `sha256:${"a".repeat(64)}`,
          rollout_status: rolloutStatus,
          proposed_config: { dry_run: true, review: { enabled: true } },
          proposed_matches_version: proposedMatches,
        }],
      };
    }

    if (q.includes("FROM policy_evidence_records")) {
      return {
        rows: [{
          id: evidenceId,
          change_request_id: changeRequestId,
          policy_version_id: versionId,
          evidence_type: "validation_result",
          evidence_payload: { valid: validationValid },
          evidence_hash: `sha256:${"b".repeat(64)}`,
          recorded_by_principal_id: authorId,
          recorded_at: "2026-09-26T00:00:00Z",
        }],
      };
    }

    if (q.includes("FROM policy_approval_records")) {
      return {
        rows: [{
          id: approvalId,
          change_request_id: changeRequestId,
          policy_version_id: versionId,
          approver_principal_id: approverId,
          decision: approvalDecision,
          reason: "reviewed",
          acknowledged_recommendations: [],
          evidence_manifest: [{
            evidence_type: "validation_result",
            evidence_id: evidenceId,
            evidence_hash: `sha256:${"b".repeat(64)}`,
          }],
          evidence_set_hash: `sha256:${"c".repeat(64)}`,
          expires_at: null,
          created_at: "2026-09-26T00:01:00Z",
        }],
      };
    }

    if (q.startsWith("INSERT INTO policy_promotion_records")) {
      return {
        rows: [{
          id: promotionId,
          repo_id: repoId,
          rollout_plan_id: 42,
          change_request_id: changeRequestId,
          policy_version_id: versionId,
          previous_policy_version_id: active?.policy_version_id ?? null,
          approval_record_id: approvalId,
          author_principal_id: authorPrincipalId,
          approver_principal_id: approverId,
          promoter_principal_id: promoterId,
          evidence_set_hash: `sha256:${"c".repeat(64)}`,
          reason: params[10],
          promoted_at: "2026-09-26T00:02:00Z",
        }],
      };
    }

    if (q.startsWith("INSERT INTO repo_config")) return { rows: [] };
    if (q.startsWith("INSERT INTO config_history")) return { rows: [] };

    if (q.startsWith("INSERT INTO active_policy_bindings")) {
      return {
        rows: [{
          repo_id: repoId,
          policy_version_id: versionId,
          promotion_record_id: promotionId,
          change_request_id: changeRequestId,
          approval_record_id: approvalId,
          author_principal_id: authorPrincipalId,
          approver_principal_id: approverId,
          promoter_principal_id: promoterId,
          evidence_set_hash: `sha256:${"c".repeat(64)}`,
        }],
      };
    }

    if (q.startsWith("UPDATE policy_rollout_plans")) {
      return {
        rows: [{
          id: 42,
          repo_id: repoId,
          status: "promoted",
          promoted_by: promoterId,
          promoted_at: "2026-09-26T00:02:00Z",
          promotion_reason: "ship",
        }],
      };
    }

    throw new Error(`Unhandled tx SQL: ${q}`);
  });
}

describe("W2-02 governed promotion", () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockTxQuery.mockReset();
    mockTransaction.mockClear();
    mockAuthorizeControlled.mockReset();
    mockInvalidateConfigCache.mockReset();
    mockInvalidateConfigCache.mockResolvedValue(undefined);
  });

  test("uses persisted enforced repository authorization for promoter and approver", async () => {
    installHarness();

    await expect(promotePolicyRollout({
      rolloutPlanId: 42,
      principal: promoterPrincipal,
      reason: "ship",
    })).resolves.toMatchObject({
      promotion: { id: promotionId, policy_version_id: versionId },
      activePolicy: { policy_version_id: versionId },
      rollout: { status: "promoted" },
    });

    expect(mockAuthorizeControlled).toHaveBeenCalledTimes(2);
    expect(mockAuthorizeControlled).toHaveBeenNthCalledWith(1, expect.objectContaining({
      principal: promoterPrincipal,
      permission: POLICY_PROMOTION_PERMISSION,
      mode: "enforced",
      resource: expect.objectContaining({
        type: "repository",
        installationId: 7,
        repositoryId: 9001,
      }),
    }));
    expect(mockAuthorizeControlled).toHaveBeenNthCalledWith(2, expect.objectContaining({
      principal: expect.objectContaining({ principalId: approverId }),
      mode: "enforced",
    }));
    expect(mockInvalidateConfigCache).toHaveBeenCalledWith("trusted-owner/trusted-repo");
  });

  test("fails closed when promoter authorization is denied", async () => {
    installHarness();
    mockAuthorizeControlled.mockResolvedValueOnce({
      decision: { allowed: false, code: "permission_missing" },
      persisted: true,
      mode: "enforced",
      blocked: true,
    });

    await expect(promotePolicyRollout({
      rolloutPlanId: 42,
      principal: promoterPrincipal,
    })).rejects.toMatchObject({ reason: "promoter_authorization_denied" });
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  test("requires an immutable W2-01 authority envelope", async () => {
    installHarness();
    mockTxQuery.mockImplementation(async (sql) => {
      const q = sql.replace(/\s+/g, " ").trim();
      if (q.includes("FROM repositories") && q.includes("FOR UPDATE")) {
        return { rows: [{ repository_id: repoId, installation_id: 7, full_name: "trusted-owner/trusted-repo" }] };
      }
      if (q.includes("FROM active_policy_bindings apb")) return { rows: [] };
      if (q.startsWith("SELECT config FROM repo_config")) return { rows: [] };
      if (q.includes("FROM policy_change_requests cr")) return { rows: [] };
      throw new Error(`Unhandled tx SQL: ${q}`);
    });

    await expect(promotePolicyRollout({
      rolloutPlanId: 42,
      principal: promoterPrincipal,
    })).rejects.toMatchObject({ reason: "policy_authority_not_found" });
  });

  test("rejects legacy/mismatched rollout policy drift", async () => {
    installHarness({ proposedMatches: false });

    await expect(promotePolicyRollout({
      rolloutPlanId: 42,
      principal: promoterPrincipal,
    })).rejects.toMatchObject({ reason: "rollout_policy_version_drift" });
  });

  test("requires approved rollout state", async () => {
    installHarness({ rolloutStatus: "review_ready" });

    await expect(promotePolicyRollout({
      rolloutPlanId: 42,
      principal: promoterPrincipal,
    })).rejects.toMatchObject({ reason: "rollout_state_disallows_promotion" });
  });

  test("first governed promotion requires null base", async () => {
    installHarness({ basePolicyVersionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" });

    await expect(promotePolicyRollout({
      rolloutPlanId: 42,
      principal: promoterPrincipal,
    })).rejects.toMatchObject({ reason: "first_governed_promotion_requires_null_base" });
  });

  test("stale base and materialization drift fail closed", async () => {
    const active = {
      policy_version_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      materialization_matches: true,
    };
    installHarness({
      basePolicyVersionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      active,
    });

    await expect(promotePolicyRollout({
      rolloutPlanId: 42,
      principal: promoterPrincipal,
    })).rejects.toMatchObject({ reason: "stale_policy_base" });

    installHarness({
      basePolicyVersionId: active.policy_version_id,
      active: { ...active, materialization_matches: false },
    });
    await expect(promotePolicyRollout({
      rolloutPlanId: 42,
      principal: promoterPrincipal,
    })).rejects.toMatchObject({ reason: "active_policy_materialization_drift" });
  });

  test("promoter must differ from author and selected approver", async () => {
    installHarness({ authorPrincipalId: promoterId });
    await expect(promotePolicyRollout({
      rolloutPlanId: 42,
      principal: promoterPrincipal,
    })).rejects.toMatchObject({ reason: "promoter_must_differ_from_author" });

    installHarness();
    await expect(promotePolicyRollout({
      rolloutPlanId: 42,
      principal: { principalId: approverId, authenticationMethod: "session" },
    })).rejects.toMatchObject({ reason: "no_currently_authorized_separated_approval" });
  });

  test("validation evidence must explicitly say valid=true", async () => {
    installHarness({ validationValid: false });

    await expect(promotePolicyRollout({
      rolloutPlanId: 42,
      principal: promoterPrincipal,
    })).rejects.toMatchObject({ reason: "no_currently_authorized_separated_approval" });
  });

  test("live materialization, promotion record, binding, rollout state and history share one transaction", async () => {
    installHarness();

    await promotePolicyRollout({
      rolloutPlanId: 42,
      principal: promoterPrincipal,
      reason: "ship",
    });

    const statements = mockTxQuery.mock.calls.map(([sql]) => sql.replace(/\s+/g, " ").trim());
    expect(statements.some((q) => q.startsWith("INSERT INTO policy_promotion_records"))).toBe(true);
    expect(statements.some((q) => q.startsWith("INSERT INTO repo_config"))).toBe(true);
    expect(statements.some((q) => q.startsWith("INSERT INTO config_history"))).toBe(true);
    expect(statements.some((q) => q.startsWith("INSERT INTO active_policy_bindings"))).toBe(true);
    expect(statements.some((q) => q.startsWith("UPDATE policy_rollout_plans"))).toBe(true);
    expect(mockTransaction).toHaveBeenCalledTimes(1);
  });
});

test("PolicyPromotionError preserves stable reason codes", () => {
  const err = new PolicyPromotionError("stable_reason", { x: 1 });
  expect(err).toBeInstanceOf(Error);
  expect(err.reason).toBe("stable_reason");
  expect(err.detail).toEqual({ x: 1 });
});
