// W2-02 denial-evidence transaction boundary regressions.
// Expected persisted authorization denials must commit their decision evidence
// before the service raises the API-facing error, with zero promotion effects.

import { jest } from "@jest/globals";

const mockOuterQuery = jest.fn();
const mockTxQuery = jest.fn();
const mockTransaction = jest.fn();
const mockAuthorizeControlled = jest.fn();
const mockInvalidateConfigCache = jest.fn();

jest.unstable_mockModule("../../src/lib/db.js", () => ({
  db: { query: mockOuterQuery, transaction: mockTransaction },
}));

jest.unstable_mockModule("../../src/lib/logger.js", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.unstable_mockModule("../../src/services/auth/authorize.js", () => ({
  authorizeControlled: mockAuthorizeControlled,
}));

jest.unstable_mockModule("../../src/services/configService.js", () => ({
  invalidateConfigCache: mockInvalidateConfigCache,
}));

const { promotePolicyRollout } = await import("../../src/services/policyPromotionService.js");

const repoId = "9001";
const rolloutId = 42;
const authorId = "11111111-1111-4111-8111-111111111111";
const approverId = "22222222-2222-4222-8222-222222222222";
const promoterId = "33333333-3333-4333-8333-333333333333";
const changeRequestId = "44444444-4444-4444-8444-444444444444";
const versionId = "55555555-5555-4555-8555-555555555555";
const approvalId = "66666666-6666-4666-8666-666666666666";
const evidenceId = "77777777-7777-4777-8777-777777777777";

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

function deniedOutcome(code = "permission_missing") {
  return {
    decision: { allowed: false, code },
    persisted: true,
    mode: "enforced",
    blocked: true,
  };
}

function installDeniedHarness() {
  mockOuterQuery.mockImplementation(async (sql) => {
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

  mockTxQuery.mockImplementation(async (sql) => {
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
    if (q.includes("FROM active_policy_bindings apb")) return { rows: [] };
    if (q.startsWith("SELECT config FROM repo_config")) return { rows: [] };
    if (q.includes("FROM policy_change_requests cr") && q.includes("JOIN policy_versions pv")) {
      return {
        rows: [{
          change_request_id: changeRequestId,
          rollout_plan_id: rolloutId,
          repo_id: repoId,
          policy_version_id: versionId,
          author_principal_id: authorId,
          base_policy_version_id: null,
          policy_document: { dry_run: true },
          content_hash: `sha256:${"a".repeat(64)}`,
          rollout_status: "approved",
          proposed_config: { dry_run: true },
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
          evidence_payload: { valid: true },
          evidence_hash: `sha256:${"b".repeat(64)}`,
          recorded_by_principal_id: authorId,
          recorded_at: "2026-09-27T00:00:00Z",
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
          decision: "approved",
          reason: "reviewed",
          acknowledged_recommendations: [],
          evidence_manifest: [{
            evidence_type: "validation_result",
            evidence_id: evidenceId,
            evidence_hash: `sha256:${"b".repeat(64)}`,
          }],
          evidence_set_hash: `sha256:${"c".repeat(64)}`,
          expires_at: null,
          temporally_valid: true,
          created_at: "2026-09-27T00:01:00Z",
        }],
      };
    }

    throw new Error(`Unexpected promotion-effect SQL after denied authorization: ${q}`);
  });
}

function assertNoEffectWrites() {
  const statements = mockTxQuery.mock.calls.map(([sql]) => sql.replace(/\s+/g, " ").trim());
  expect(statements.some((q) => q.startsWith("INSERT INTO policy_promotion_records"))).toBe(false);
  expect(statements.some((q) => q.startsWith("INSERT INTO repo_config"))).toBe(false);
  expect(statements.some((q) => q.startsWith("INSERT INTO config_history"))).toBe(false);
  expect(statements.some((q) => q.startsWith("INSERT INTO active_policy_bindings"))).toBe(false);
  expect(statements.some((q) => q.startsWith("UPDATE policy_rollout_plans"))).toBe(false);
  expect(mockInvalidateConfigCache).not.toHaveBeenCalled();
}

describe("W2-02 denial evidence commits before rejection", () => {
  let transactionResult;

  beforeEach(() => {
    transactionResult = null;
    mockOuterQuery.mockReset();
    mockTxQuery.mockReset();
    mockTransaction.mockReset();
    mockAuthorizeControlled.mockReset();
    mockInvalidateConfigCache.mockReset();
    mockInvalidateConfigCache.mockResolvedValue(undefined);
    installDeniedHarness();
    mockTransaction.mockImplementation(async (fn) => {
      transactionResult = await fn({ query: mockTxQuery });
      return transactionResult;
    });
  });

  test("promoter denial returns a commit sentinel, then raises the same error outside the transaction", async () => {
    mockAuthorizeControlled.mockResolvedValueOnce(deniedOutcome());

    await expect(promotePolicyRollout({
      rolloutPlanId: rolloutId,
      principal: promoterPrincipal,
    })).rejects.toMatchObject({
      reason: "promoter_authorization_denied",
      detail: { code: "permission_missing" },
    });

    expect(transactionResult).toMatchObject({
      authorizationError: {
        reason: "promoter_authorization_denied",
        detail: { code: "permission_missing" },
      },
    });
    expect(mockAuthorizeControlled).toHaveBeenCalledTimes(1);
    assertNoEffectWrites();
  });

  test("approver denial commits the denial-only transaction before no-current-approval rejection", async () => {
    mockAuthorizeControlled
      .mockResolvedValueOnce(allowedOutcome())
      .mockResolvedValueOnce(deniedOutcome("scope_mismatch"));

    await expect(promotePolicyRollout({
      rolloutPlanId: rolloutId,
      principal: promoterPrincipal,
    })).rejects.toMatchObject({
      reason: "no_currently_authorized_separated_approval",
      detail: { code: "scope_mismatch" },
    });

    expect(transactionResult).toMatchObject({
      authorizationError: {
        reason: "no_currently_authorized_separated_approval",
        detail: { code: "scope_mismatch" },
      },
    });
    expect(mockAuthorizeControlled).toHaveBeenCalledTimes(2);
    assertNoEffectWrites();
  });

  test("authorization evidence persistence failure still aborts instead of returning a commit sentinel", async () => {
    mockAuthorizeControlled
      .mockResolvedValueOnce(allowedOutcome())
      .mockResolvedValueOnce({
        decision: { allowed: false, code: "permission_missing" },
        persisted: false,
        mode: "enforced",
        blocked: true,
      });

    await expect(promotePolicyRollout({
      rolloutPlanId: rolloutId,
      principal: promoterPrincipal,
    })).rejects.toMatchObject({ reason: "approver_authorization_not_persisted" });

    expect(transactionResult).toBeNull();
    assertNoEffectWrites();
  });
});
