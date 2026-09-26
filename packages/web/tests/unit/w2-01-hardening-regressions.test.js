// W2-01 closure hardening regressions.

import { jest } from "@jest/globals";

const mockQuery = jest.fn();
const mockTransaction = jest.fn(async (fn) => fn({ query: mockQuery }));
const mockAuthorizeControlled = jest.fn();

jest.unstable_mockModule("../../src/lib/db.js", () => ({
  db: { query: mockQuery, transaction: mockTransaction },
}));

jest.unstable_mockModule("../../src/services/auth/authorize.js", () => ({
  authorizeControlled: mockAuthorizeControlled,
}));

const policyAuthority = await import("../../src/services/policyAuthorityService.js");
const { recordPolicyApprovalForRollout } = policyAuthority;

const approverPrincipal = Object.freeze({
  principalId: "22222222-2222-4222-8222-222222222222",
  principalType: "user",
  authenticationMethod: "session",
});

const authorPrincipalId = "11111111-1111-4111-8111-111111111111";
const changeRequestId = "33333333-3333-4333-8333-333333333333";
const policyVersionId = "44444444-4444-4444-8444-444444444444";

const evidenceTypes = [
  "validation_result",
  "simulation_summary",
  "diff_impact_summary",
  "recommendations_summary",
];

function installApprovalHarness(validationResult) {
  const proposedConfig = { dry_run: true };
  const evidencePayloads = {
    validation_result: validationResult,
    simulation_summary: { changed: 0 },
    diff_impact_summary: { risk: "low" },
    recommendations_summary: { recommendations: [] },
  };
  const evidenceRows = evidenceTypes.map((type, index) => ({
    id: `00000000-0000-4000-8000-00000000000${index + 1}`,
    evidence_type: type,
    evidence_payload: evidencePayloads[type],
    evidence_hash: `sha256:${String(index + 1).repeat(64)}`,
    recorded_at: `2026-09-26T00:0${index}:00Z`,
  }));

  mockAuthorizeControlled.mockResolvedValue({
    decision: { allowed: true, code: "allowed" },
    persisted: true,
    mode: "enforced",
    blocked: false,
  });

  mockQuery.mockImplementation(async (sql, params = []) => {
    const q = sql.replace(/\s+/g, " ").trim();

    if (q.includes("FROM policy_rollout_plans p") && q.includes("JOIN repositories r")) {
      return {
        rows: [{
          repo_id: "9001",
          github_id: "9001",
          installation_id: 7,
          full_name: "trusted-owner/trusted-repo",
        }],
      };
    }

    if (q.includes("FROM gitwire_auth.auth_principals")) {
      return { rows: [{ id: approverPrincipal.principalId, status: "active" }] };
    }

    if (q.includes("FROM policy_change_requests cr") && q.includes("JOIN policy_versions pv")) {
      return {
        rows: [{
          change_request_id: changeRequestId,
          rollout_plan_id: 42,
          repo_id: "9001",
          policy_version_id: policyVersionId,
          author_principal_id: authorPrincipalId,
          change_request_created_at: "2026-09-26T00:00:00Z",
          policy_content_hash: `sha256:${"a".repeat(64)}`,
          base_policy_version_id: null,
          policy_document: proposedConfig,
          rollout_status: "review_ready",
          proposed_config: proposedConfig,
          validation_result: validationResult,
          simulation_summary: evidencePayloads.simulation_summary,
          diff_impact_summary: evidencePayloads.diff_impact_summary,
          recommendations_summary: evidencePayloads.recommendations_summary,
        }],
      };
    }

    if (q.includes("FROM policy_approval_records") && q.includes("approver_principal_id = $2")) {
      return { rows: [] };
    }

    if (q.includes("FROM policy_evidence_records") && q.includes("evidence_payload, evidence_hash")) {
      return { rows: evidenceRows };
    }

    if (q.startsWith("INSERT INTO policy_approval_records")) {
      return {
        rows: [{
          id: "55555555-5555-4555-8555-555555555555",
          change_request_id: params[0],
          policy_version_id: params[1],
          approver_principal_id: params[2],
          decision: params[3],
          evidence_manifest: params[6],
        }],
      };
    }

    throw new Error(`Unhandled SQL in W2-01 hardening test: ${q}`);
  });
}

async function approve() {
  return recordPolicyApprovalForRollout({
    rolloutPlanId: 42,
    principal: approverPrincipal,
    decision: "approved",
  });
}

describe("W2-01 closure hardening", () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockTransaction.mockClear();
    mockAuthorizeControlled.mockReset();
  });

  test.each([
    ["missing valid field", {}],
    ["status-only failure", { status: "failed" }],
    ["errors-only failure", { errors: ["invalid"] }],
    ["explicit false", { valid: false }],
  ])("approval fails closed for validation evidence: %s", async (_label, validationResult) => {
    installApprovalHarness(validationResult);

    await expect(approve()).rejects.toMatchObject({
      reason: "approval_validation_failed_or_missing",
    });

    expect(mockQuery.mock.calls.some(([sql]) =>
      sql.replace(/\s+/g, " ").trim().startsWith("INSERT INTO policy_approval_records"),
    )).toBe(false);
  });

  test("approval accepts only an explicit valid=true result", async () => {
    installApprovalHarness({ valid: true });

    await expect(approve()).resolves.toMatchObject({ decision: "approved" });
  });

  test("W2-01 does not expose an unauthenticated policy-authority read API", () => {
    expect(policyAuthority.getPolicyAuthorityForRollout).toBeUndefined();
  });
});
