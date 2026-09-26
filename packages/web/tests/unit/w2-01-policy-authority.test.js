// W2-01 — immutable policy authority model.

import { jest } from "@jest/globals";
import { fileURLToPath } from "url";
import fs from "fs";
import path from "path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
function readSource(relPath) {
  return fs.readFileSync(path.resolve(ROOT, relPath), "utf-8");
}

const mockQuery = jest.fn();
const mockTransaction = jest.fn(async (fn) => fn({ query: mockQuery }));

jest.unstable_mockModule("../../src/lib/db.js", () => ({
  db: {
    query: mockQuery,
    transaction: mockTransaction,
  },
}));

const {
  POLICY_EVIDENCE_TYPES,
  canonicalPolicyJson,
  hashPolicyJson,
  createPolicyChangeRequestForRollout,
  isApprovalRecordUsable,
  assertApprovalRecordUsable,
} = await import("../../src/services/policyAuthorityService.js");

describe("W2-01 migration contract", () => {
  const migration = readSource("packages/web/db/migrations/045_w2_policy_authority.sql");

  test("creates the four bounded policy authority records", () => {
    expect(migration).toMatch(/CREATE TABLE policy_versions/);
    expect(migration).toMatch(/CREATE TABLE policy_change_requests/);
    expect(migration).toMatch(/CREATE TABLE policy_evidence_records/);
    expect(migration).toMatch(/CREATE TABLE policy_approval_records/);
  });

  test("binds policy authority to authoritative principals", () => {
    expect(migration).toMatch(/author_principal_id[\s\S]*REFERENCES gitwire_auth\.auth_principals/);
    expect(migration).toMatch(/recorded_by_principal_id[\s\S]*REFERENCES gitwire_auth\.auth_principals/);
    expect(migration).toMatch(/approver_principal_id[\s\S]*REFERENCES gitwire_auth\.auth_principals/);
  });

  test("change requests are anchored to the existing rollout workflow", () => {
    expect(migration).toMatch(/rollout_plan_id[\s\S]*UNIQUE[\s\S]*REFERENCES policy_rollout_plans/);
  });

  test("versions and evidence are content-addressed with sha256", () => {
    expect(migration).toMatch(/content_hash/);
    expect(migration).toMatch(/evidence_hash/);
    expect(migration).toMatch(/sha256/);
  });

  test("approval records bind the reviewed evidence set", () => {
    expect(migration).toMatch(/evidence_manifest/);
    expect(migration).toMatch(/evidence_set_hash/);
    expect(migration).toMatch(/expires_at/);
  });

  test("all four authority tables reject update and delete", () => {
    for (const table of [
      "policy_versions",
      "policy_change_requests",
      "policy_evidence_records",
      "policy_approval_records",
    ]) {
      expect(migration).toMatch(new RegExp(`BEFORE UPDATE ON ${table}`));
      expect(migration).toMatch(new RegExp(`BEFORE DELETE ON ${table}`));
    }
    expect(migration).toMatch(/append-only/);
  });

  test("does not introduce active-policy bindings or a live-policy writer in W2-01", () => {
    expect(migration).not.toMatch(/CREATE TABLE active_policy/);
    expect(migration).not.toMatch(/repo_config.*UPDATE/i);
  });
});

describe("W2-01 policy authority service", () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockTransaction.mockClear();
  });

  test("freezes the exact evidence vocabulary used by the existing rollout", () => {
    expect(POLICY_EVIDENCE_TYPES).toEqual([
      "validation_result",
      "simulation_summary",
      "diff_impact_summary",
      "recommendations_summary",
    ]);
  });

  test("canonical JSON and hashes are independent of object key ordering", () => {
    const left = { b: 2, a: { z: 3, y: [2, 1] } };
    const right = { a: { y: [2, 1], z: 3 }, b: 2 };
    expect(canonicalPolicyJson(left)).toBe(canonicalPolicyJson(right));
    expect(hashPolicyJson(left)).toBe(hashPolicyJson(right));
    expect(hashPolicyJson(left)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  test("creates a version and change request from DB-owned rollout state in one transaction", async () => {
    const principalId = "11111111-1111-4111-8111-111111111111";
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: principalId, status: "active", display_name: "Author" }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{
          id: 42,
          repo_id: 9001,
          proposed_config: { dry_run: true, review: { enabled: true } },
          normalized_config: { dry_run: true, review: { enabled: true } },
          created_by: "legacy-author",
        }],
      })
      .mockResolvedValueOnce({
        rows: [{
          id: "22222222-2222-4222-8222-222222222222",
          repo_id: 9001,
          base_policy_version_id: null,
          content_hash: hashPolicyJson({ dry_run: true, review: { enabled: true } }),
          created_at: "2026-09-26T00:00:00Z",
        }],
      })
      .mockResolvedValueOnce({
        rows: [{
          id: "33333333-3333-4333-8333-333333333333",
          rollout_plan_id: 42,
          repo_id: 9001,
          policy_version_id: "22222222-2222-4222-8222-222222222222",
          author_principal_id: principalId,
          author_display_name: "Author",
          created_at: "2026-09-26T00:00:00Z",
        }],
      });

    const result = await createPolicyChangeRequestForRollout({
      rolloutPlanId: 42,
      authorPrincipalId: principalId,
    });

    expect(mockTransaction).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      rollout_plan_id: 42,
      repo_id: 9001,
      author_principal_id: principalId,
      policy_content_hash: expect.stringMatching(/^sha256:/),
    });
    expect(mockQuery.mock.calls[3][0]).toMatch(/INSERT INTO policy_versions/);
    expect(mockQuery.mock.calls[4][0]).toMatch(/INSERT INTO policy_change_requests/);
  });

  test("refuses to bind an inactive principal", async () => {
    const principalId = "11111111-1111-4111-8111-111111111111";
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: principalId, status: "disabled", display_name: "Disabled" }],
    });

    await expect(createPolicyChangeRequestForRollout({
      rolloutPlanId: 42,
      authorPrincipalId: principalId,
    })).rejects.toThrow("authoritative principal is not active");
  });

  test("expired or rejected approvals are not usable", () => {
    const now = new Date("2026-09-26T12:00:00Z");
    expect(isApprovalRecordUsable({ decision: "approved", expires_at: null }, now)).toBe(true);
    expect(isApprovalRecordUsable({
      decision: "approved",
      expires_at: "2026-09-26T11:59:59Z",
    }, now)).toBe(false);
    expect(isApprovalRecordUsable({ decision: "rejected", expires_at: null }, now)).toBe(false);
    expect(() => assertApprovalRecordUsable({
      decision: "approved",
      expires_at: "2026-09-26T11:59:59Z",
    }, now)).toThrow("expired");
  });
});

describe("W2-01 scope boundary", () => {
  const source = readSource("packages/web/src/services/policyAuthorityService.js");

  test("snapshots policy only from an existing rollout plan", () => {
    expect(source).toMatch(/FROM policy_rollout_plans/);
    expect(source).toMatch(/plan\.proposed_config/);
    expect(source).not.toMatch(/setConfigOverrides/);
  });

  test("enforces active server-owned principals", () => {
    expect(source).toMatch(/gitwire_auth\.auth_principals/);
    expect(source).toMatch(/authoritative principal_id is required/);
    expect(source).toMatch(/status !== "active"/);
  });

  test("forbids self approval", () => {
    expect(source).toMatch(/self-approval is forbidden/);
  });

  test("freezes evidence once an approval decision exists", () => {
    expect(source).toMatch(/Cannot attach authority evidence after an approval decision exists/);
  });

  test("does not mutate active policy", () => {
    expect(source).not.toMatch(/repo_config/);
    expect(source).not.toMatch(/setConfigOverrides/);
    expect(source).not.toMatch(/promoteRolloutPlan/);
  });
});
