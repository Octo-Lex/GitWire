// W2-01 rollout-state gate regression coverage.

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

const {
  appendPolicyEvidenceForRollout,
  recordPolicyApprovalForRollout,
} = await import("../../src/services/policyAuthorityService.js");

const authorPrincipalId = "11111111-1111-4111-8111-111111111111";
const actorPrincipal = Object.freeze({
  principalId: "22222222-2222-4222-8222-222222222222",
  principalType: "user",
  authenticationMethod: "session",
});

function installHarness({ status = "draft", envelopePresent = true } = {}) {
  const proposedConfig = { dry_run: true };

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
      return { rows: [{ id: actorPrincipal.principalId, status: "active" }] };
    }

    if (q.includes("FROM policy_change_requests cr") && q.includes("JOIN policy_versions pv")) {
      if (!envelopePresent) return { rows: [] };
      return {
        rows: [{
          change_request_id: "33333333-3333-4333-8333-333333333333",
          rollout_plan_id: 42,
          repo_id: "9001",
          policy_version_id: "44444444-4444-4444-8444-444444444444",
          author_principal_id: authorPrincipalId,
          change_request_created_at: "2026-09-26T00:00:00Z",
          policy_content_hash: `sha256:${"a".repeat(64)}`,
          base_policy_version_id: null,
          policy_document: proposedConfig,
          rollout_status: status,
          proposed_config: proposedConfig,
          validation_result: { valid: true },
          simulation_summary: { changed: 0 },
          diff_impact_summary: { risk: "low" },
          recommendations_summary: { recommendations: [] },
        }],
      };
    }

    if (q.includes("FROM policy_approval_records") && q.includes("LIMIT 1")) {
      return { rows: [] };
    }

    if (q.startsWith("INSERT INTO policy_evidence_records")) {
      return {
        rows: [{
          id: "55555555-5555-4555-8555-555555555555",
          evidence_type: params[2],
          evidence_hash: `sha256:${"b".repeat(64)}`,
          recorded_at: "2026-09-26T00:01:00Z",
        }],
      };
    }

    throw new Error(`Unhandled SQL in W2-01 state-gate test: ${q}`);
  });
}

describe("W2-01 rollout-state gates", () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockTransaction.mockClear();
    mockAuthorizeControlled.mockReset();
  });

  test("evidence append is allowed for validated rollouts and locks mutable rollout state", async () => {
    installHarness({ status: "validated" });

    await expect(appendPolicyEvidenceForRollout({
      rolloutPlanId: 42,
      principal: actorPrincipal,
      evidenceTypes: ["validation_result"],
    })).resolves.toHaveLength(1);

    const envelopeQuery = mockQuery.mock.calls
      .map(([sql]) => sql.replace(/\s+/g, " ").trim())
      .find((sql) => sql.includes("FROM policy_change_requests cr") && sql.includes("JOIN policy_versions pv"));
    expect(envelopeQuery).toContain("FOR UPDATE OF cr, p");
  });

  test("evidence append fails closed after the rollout leaves draft or validated", async () => {
    installHarness({ status: "review_ready" });

    await expect(appendPolicyEvidenceForRollout({
      rolloutPlanId: 42,
      principal: actorPrincipal,
      evidenceTypes: ["validation_result"],
    })).rejects.toMatchObject({ reason: "rollout_state_disallows_evidence" });
  });

  test("approval decision fails closed unless the rollout is review_ready", async () => {
    installHarness({ status: "draft" });

    await expect(recordPolicyApprovalForRollout({
      rolloutPlanId: 42,
      principal: actorPrincipal,
      decision: "approved",
    })).rejects.toMatchObject({ reason: "rollout_state_disallows_decision" });
  });

  test("evidence and decision paths fail closed when no authority envelope exists", async () => {
    installHarness({ envelopePresent: false });

    await expect(appendPolicyEvidenceForRollout({
      rolloutPlanId: 42,
      principal: actorPrincipal,
      evidenceTypes: ["validation_result"],
    })).rejects.toMatchObject({ reason: "policy_authority_not_found" });

    await expect(recordPolicyApprovalForRollout({
      rolloutPlanId: 42,
      principal: actorPrincipal,
      decision: "approved",
    })).rejects.toMatchObject({ reason: "policy_authority_not_found" });
  });
});
