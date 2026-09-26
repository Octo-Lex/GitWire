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
const mockAuthorizeControlled = jest.fn();

jest.unstable_mockModule("../../src/lib/db.js", () => ({
  db: { query: mockQuery, transaction: mockTransaction },
}));
jest.unstable_mockModule("../../src/services/auth/authorize.js", () => ({
  authorizeControlled: mockAuthorizeControlled,
}));

const {
  POLICY_EVIDENCE_TYPES,
  POLICY_AUTHORITY_PERMISSIONS,
  canonicalPolicyJson,
  createPolicyChangeRequestForRollout,
  appendPolicyEvidenceForRollout,
  recordPolicyApprovalForRollout,
  isApprovalRecordTemporallyValid,
  assertApprovalRecordTemporallyValid,
} = await import("../../src/services/policyAuthorityService.js");

const authorPrincipal = Object.freeze({
  principalId: "11111111-1111-4111-8111-111111111111",
  principalType: "user",
  authenticationMethod: "session",
});
const approverPrincipal = Object.freeze({
  principalId: "22222222-2222-4222-8222-222222222222",
  principalType: "user",
  authenticationMethod: "session",
});

function allowedOutcome(resource) {
  return {
    decision: Object.freeze({ allowed: true, code: "allowed", resource }),
    persisted: true,
    mode: "enforced",
    blocked: false,
  };
}

function makeState() {
  const proposed = { dry_run: true, review: { enabled: true } };
  return {
    repo: {
      repo_id: "9001",
      github_id: "9001",
      installation_id: 7,
      full_name: "trusted-owner/trusted-repo",
    },
    plan: {
      id: 42,
      repo_id: "9001",
      proposed_config: proposed,
      normalized_config: proposed,
      status: "draft",
      validation_result: { valid: true },
      simulation_summary: { changed: 2 },
      diff_impact_summary: { risk: "low" },
      recommendations_summary: {
        summary: { critical: 1, warning: 0, info: 0 },
        recommendations: [{ id: "rec-critical", severity: "critical" }],
      },
    },
    activePrincipalIds: new Set([authorPrincipal.principalId, approverPrincipal.principalId]),
    envelope: null,
    baseVersion: null,
    approvalExists: false,
    duplicateApproval: false,
    evidenceRows: [],
    inserts: [],
  };
}

function envelopeFromState(state, overrides = {}) {
  return {
    change_request_id: "33333333-3333-4333-8333-333333333333",
    rollout_plan_id: state.plan.id,
    repo_id: state.plan.repo_id,
    policy_version_id: "44444444-4444-4444-8444-444444444444",
    author_principal_id: authorPrincipal.principalId,
    change_request_created_at: "2026-09-26T00:00:00Z",
    policy_content_hash: "sha256:" + "a".repeat(64),
    base_policy_version_id: null,
    policy_document: state.plan.proposed_config,
    proposed_config: state.plan.proposed_config,
    rollout_status: state.plan.status,
    validation_result: state.plan.validation_result,
    simulation_summary: state.plan.simulation_summary,
    diff_impact_summary: state.plan.diff_impact_summary,
    recommendations_summary: state.plan.recommendations_summary,
    ...overrides,
  };
}

function installQueryRouter(state) {
  mockQuery.mockImplementation(async (sql, params = []) => {
    const q = sql.replace(/\s+/g, " ").trim();

    if (q.includes("FROM policy_rollout_plans p") && q.includes("JOIN repositories r")) {
      return { rows: [state.repo] };
    }
    if (q.includes("FROM gitwire_auth.auth_principals")) {
      const id = params[0];
      return {
        rows: state.activePrincipalIds.has(id)
          ? [{ id, status: "active" }]
          : [{ id, status: "disabled" }],
      };
    }
    if (q.includes("FROM policy_rollout_plans") && q.includes("FOR UPDATE")) {
      return { rows: [state.plan] };
    }
    if (q.includes("FROM policy_change_requests cr") && q.includes("JOIN policy_versions pv")) {
      return { rows: state.envelope ? [state.envelope] : [] };
    }
    if (q.startsWith("SELECT id, repo_id FROM policy_versions")) {
      return { rows: state.baseVersion ? [state.baseVersion] : [] };
    }
    if (q.startsWith("INSERT INTO policy_versions")) {
      state.inserts.push({ kind: "version", params });
      return {
        rows: [{
          id: "44444444-4444-4444-8444-444444444444",
          repo_id: state.plan.repo_id,
          base_policy_version_id: params[1] ?? null,
          content_hash: "sha256:" + "a".repeat(64),
          created_at: "2026-09-26T00:00:00Z",
        }],
      };
    }
    if (q.startsWith("INSERT INTO policy_change_requests")) {
      state.inserts.push({ kind: "change_request", params });
      return {
        rows: [{
          id: "33333333-3333-4333-8333-333333333333",
          rollout_plan_id: state.plan.id,
          repo_id: state.plan.repo_id,
          policy_version_id: "44444444-4444-4444-8444-444444444444",
          author_principal_id: params[3],
          created_at: "2026-09-26T00:00:00Z",
        }],
      };
    }
    if (q.includes("FROM policy_approval_records") && q.includes("LIMIT 1")) {
      return { rows: state.approvalExists ? [{ id: "approval-existing" }] : [] };
    }
    if (q.includes("FROM policy_approval_records") && q.includes("approver_principal_id = $2")) {
      return { rows: state.duplicateApproval ? [{ id: "approval-duplicate" }] : [] };
    }
    if (q.startsWith("INSERT INTO policy_evidence_records")) {
      const [, policyVersionId, type, payload, principalId] = params;
      const row = {
        id: `evidence-${type}`,
        evidence_type: type,
        evidence_payload: payload,
        evidence_hash: "sha256:" + type.padEnd(64, "0").slice(0, 64),
        recorded_at: "2026-09-26T00:01:00Z",
      };
      state.inserts.push({ kind: "evidence", policyVersionId, principalId, payload, type });
      state.evidenceRows.push(row);
      return { rows: [row] };
    }
    if (q.includes("FROM policy_evidence_records") && q.includes("evidence_payload = $3::jsonb")) {
      const [, type] = params;
      const row = [...state.evidenceRows].reverse().find((item) => item.evidence_type === type);
      return { rows: row ? [row] : [] };
    }
    if (q.includes("FROM policy_evidence_records") && q.includes("evidence_payload, evidence_hash")) {
      return { rows: state.evidenceRows };
    }
    if (q.startsWith("INSERT INTO policy_approval_records")) {
      state.inserts.push({ kind: "approval", params });
      return {
        rows: [{
          id: "55555555-5555-4555-8555-555555555555",
          change_request_id: params[0],
          policy_version_id: params[1],
          approver_principal_id: params[2],
          decision: params[3],
          reason: params[4],
          acknowledged_recommendations: params[5],
          evidence_manifest: params[6],
          evidence_set_hash: "sha256:" + "b".repeat(64),
          expires_at: params[7],
          created_at: "2026-09-26T00:02:00Z",
        }],
      };
    }

    throw new Error(`Unhandled SQL in W2-01 test: ${q}`);
  });
}

function seedCompleteEvidence(state) {
  state.evidenceRows = POLICY_EVIDENCE_TYPES.map((type, index) => ({
    id: `evidence-${index}`,
    evidence_type: type,
    evidence_payload: state.plan[type],
    evidence_hash: "sha256:" + String(index + 1).repeat(64),
    recorded_at: `2026-09-26T00:0${index}:00Z`,
  }));
}

describe("W2-01 migration contract", () => {
  const migration = readSource("packages/web/db/migrations/045_w2_policy_authority.sql");

  test("creates the four bounded policy authority tables", () => {
    for (const table of [
      "policy_versions",
      "policy_change_requests",
      "policy_evidence_records",
      "policy_approval_records",
    ]) {
      expect(migration).toMatch(new RegExp(`CREATE TABLE ${table}`));
    }
  });

  test("mechanically binds rollout, repository, version and author relationships", () => {
    expect(migration).toMatch(/FOREIGN KEY \(rollout_plan_id, repo_id\)/);
    expect(migration).toMatch(/FOREIGN KEY \(policy_version_id, repo_id, author_principal_id\)/);
    expect(migration).toMatch(/FOREIGN KEY \(change_request_id, policy_version_id\)/);
  });

  test("database derives policy, evidence, and evidence-set hashes from stored JSONB", () => {
    expect(migration).toMatch(/NEW\.content_hash := 'sha256:' \|\| encode\(public\.digest\(NEW\.policy_document::text/);
    expect(migration).toMatch(/NEW\.evidence_hash := 'sha256:' \|\| encode\(public\.digest\(NEW\.evidence_payload::text/);
    expect(migration).toMatch(/NEW\.evidence_set_hash := 'sha256:' \|\| encode\(public\.digest\(NEW\.evidence_manifest::text/);
  });

  test("database serializes evidence with approval and forbids self-approval", () => {
    expect(migration).toMatch(/policy evidence is frozen after an approval decision exists/);
    expect(migration).toMatch(/self-approval is forbidden for policy change requests/);
    expect(migration).toMatch(/FOR UPDATE/);
  });

  test("approved records require the complete four-type evidence manifest", () => {
    expect(migration).toMatch(/approved policy change requires the complete evidence set/);
    for (const type of POLICY_EVIDENCE_TYPES) expect(migration).toContain(`('${type}')`);
  });

  test("all authority tables reject UPDATE, DELETE, and TRUNCATE", () => {
    for (const table of [
      "policy_versions",
      "policy_change_requests",
      "policy_evidence_records",
      "policy_approval_records",
    ]) {
      expect(migration).toMatch(new RegExp(`BEFORE UPDATE ON ${table}`));
      expect(migration).toMatch(new RegExp(`BEFORE DELETE ON ${table}`));
      expect(migration).toMatch(new RegExp(`BEFORE TRUNCATE ON ${table}`));
    }
  });

  test("immutable authority records do not copy mutable display names", () => {
    expect(migration).not.toMatch(/author_display_name/);
    expect(migration).not.toMatch(/recorded_by_display_name/);
    expect(migration).not.toMatch(/approver_display_name/);
  });

  test("does not introduce a live-policy writer in W2-01", () => {
    expect(migration).not.toMatch(/CREATE TABLE active_policy/);
    expect(migration).not.toMatch(/UPDATE repo_config/i);
  });
});

describe("W2-01 policy authority service", () => {
  let state;

  beforeEach(() => {
    state = makeState();
    mockQuery.mockReset();
    mockTransaction.mockClear();
    mockAuthorizeControlled.mockReset();
    mockAuthorizeControlled.mockImplementation(async ({ resource }) => allowedOutcome(resource));
    installQueryRouter(state);
  });

  test("freezes the exact evidence and permission vocabulary", () => {
    expect(POLICY_EVIDENCE_TYPES).toEqual([
      "validation_result",
      "simulation_summary",
      "diff_impact_summary",
      "recommendations_summary",
    ]);
    expect(POLICY_AUTHORITY_PERMISSIONS).toEqual({
      create: "policy_definition:create",
      evidence: "policy_rollout_plan:update",
      decision: "policy_rollout_plan:approve",
    });
  });

  test("canonical comparison is independent of object key ordering", () => {
    expect(canonicalPolicyJson({ b: 2, a: { z: 3, y: [2, 1] } }))
      .toBe(canonicalPolicyJson({ a: { y: [2, 1], z: 3 }, b: 2 }));
  });

  test("creates a rollout-bound immutable version only after persisted repository authorization", async () => {
    const result = await createPolicyChangeRequestForRollout({
      rolloutPlanId: 42,
      principal: authorPrincipal,
    });

    expect(mockAuthorizeControlled).toHaveBeenCalledWith({
      principal: authorPrincipal,
      permission: "policy_definition:create",
      resource: {
        type: "repository",
        installationId: 7,
        repositoryId: 9001,
        organization: "trusted-owner",
        repository: "trusted-repo",
      },
      mode: "enforced",
    });
    expect(mockTransaction).toHaveBeenCalledTimes(1);
    expect(state.inserts.map((item) => item.kind)).toEqual(["version", "change_request"]);
    expect(result).toMatchObject({
      rollout_plan_id: 42,
      repo_id: "9001",
      author_principal_id: authorPrincipal.principalId,
      policy_content_hash: expect.stringMatching(/^sha256:/),
    });
  });

  test("authorization denial or missing durable decision evidence blocks authority writes", async () => {
    mockAuthorizeControlled.mockResolvedValue({
      decision: { allowed: true, code: "allowed" },
      persisted: false,
      mode: "enforced",
      blocked: true,
    });

    await expect(createPolicyChangeRequestForRollout({
      rolloutPlanId: 42,
      principal: authorPrincipal,
    })).rejects.toMatchObject({ reason: "authorization_denied" });

    expect(mockTransaction).not.toHaveBeenCalled();
    expect(state.inserts).toEqual([]);
  });

  test("existing envelope is idempotent only for the same principal and base", async () => {
    state.envelope = envelopeFromState(state);

    const result = await createPolicyChangeRequestForRollout({
      rolloutPlanId: 42,
      principal: authorPrincipal,
    });
    expect(result.change_request_id).toBe(state.envelope.change_request_id);
    expect(state.inserts).toEqual([]);

    await expect(createPolicyChangeRequestForRollout({
      rolloutPlanId: 42,
      principal: approverPrincipal,
    })).rejects.toMatchObject({ reason: "rollout_authority_bound_to_different_principal" });
  });

  test("base repository comparison is exact for BIGINT values beyond JS safe integer precision", async () => {
    state.plan.repo_id = "9007199254740993";
    state.repo.repo_id = state.plan.repo_id;
    state.repo.github_id = state.plan.repo_id;
    state.baseVersion = {
      id: "66666666-6666-4666-8666-666666666666",
      repo_id: "9007199254740992",
    };

    await expect(createPolicyChangeRequestForRollout({
      rolloutPlanId: 42,
      principal: authorPrincipal,
      basePolicyVersionId: state.baseVersion.id,
    })).rejects.toMatchObject({ reason: "base_policy_version_repository_mismatch" });
  });

  test("snapshots evidence from DB-owned rollout fields rather than caller payload", async () => {
    state.envelope = envelopeFromState(state);

    const recorded = await appendPolicyEvidenceForRollout({
      rolloutPlanId: 42,
      principal: authorPrincipal,
      evidenceTypes: ["validation_result", "simulation_summary"],
    });

    expect(mockAuthorizeControlled).toHaveBeenLastCalledWith(expect.objectContaining({
      permission: "policy_rollout_plan:update",
      mode: "enforced",
    }));
    expect(recorded).toHaveLength(2);
    expect(state.inserts.filter((item) => item.kind === "evidence").map((item) => item.payload))
      .toEqual([state.plan.validation_result, state.plan.simulation_summary]);
  });

  test("rejects unknown evidence types and evidence after a decision", async () => {
    state.envelope = envelopeFromState(state);
    await expect(appendPolicyEvidenceForRollout({
      rolloutPlanId: 42,
      principal: authorPrincipal,
      evidenceTypes: ["invented_evidence"],
    })).rejects.toMatchObject({ reason: "unsupported_evidence_type" });

    state.approvalExists = true;
    await expect(appendPolicyEvidenceForRollout({
      rolloutPlanId: 42,
      principal: authorPrincipal,
      evidenceTypes: ["validation_result"],
    })).rejects.toMatchObject({ reason: "policy_evidence_frozen_after_decision" });
  });

  test("rejects mutable rollout policy drift after the immutable version snapshot", async () => {
    state.envelope = envelopeFromState(state, {
      policy_document: { dry_run: true },
      proposed_config: { dry_run: false },
    });

    await expect(appendPolicyEvidenceForRollout({
      rolloutPlanId: 42,
      principal: authorPrincipal,
      evidenceTypes: ["validation_result"],
    })).rejects.toMatchObject({ reason: "rollout_policy_changed_after_authority_snapshot" });
  });

  test("records an approval bound to the complete immutable evidence set", async () => {
    state.plan.status = "review_ready";
    state.envelope = envelopeFromState(state, { rollout_status: "review_ready" });
    seedCompleteEvidence(state);

    const record = await recordPolicyApprovalForRollout({
      rolloutPlanId: 42,
      principal: approverPrincipal,
      decision: "approved",
      reason: "reviewed",
      acknowledgedRecommendations: ["rec-critical"],
      expiresAt: "2099-01-01T00:00:00Z",
    });

    expect(mockAuthorizeControlled).toHaveBeenLastCalledWith(expect.objectContaining({
      permission: "policy_rollout_plan:approve",
      mode: "enforced",
    }));
    expect(record.decision).toBe("approved");
    expect(record.evidence_manifest).toHaveLength(4);
    expect(record.acknowledged_recommendations).toEqual(["rec-critical"]);
  });

  test("self-approval is forbidden", async () => {
    state.plan.status = "review_ready";
    state.envelope = envelopeFromState(state, { rollout_status: "review_ready" });
    seedCompleteEvidence(state);

    await expect(recordPolicyApprovalForRollout({
      rolloutPlanId: 42,
      principal: authorPrincipal,
      decision: "approved",
      acknowledgedRecommendations: ["rec-critical"],
    })).rejects.toMatchObject({ reason: "self_approval_forbidden" });
  });

  test("approval requires exact current immutable evidence and critical acknowledgements", async () => {
    state.plan.status = "review_ready";
    state.envelope = envelopeFromState(state, { rollout_status: "review_ready" });
    state.evidenceRows = POLICY_EVIDENCE_TYPES
      .filter((type) => type !== "simulation_summary")
      .map((type, index) => ({
        id: `evidence-${index}`,
        evidence_type: type,
        evidence_payload: state.plan[type],
        evidence_hash: "sha256:" + String(index + 1).repeat(64),
        recorded_at: "2026-09-26T00:00:00Z",
      }));

    await expect(recordPolicyApprovalForRollout({
      rolloutPlanId: 42,
      principal: approverPrincipal,
      decision: "approved",
      acknowledgedRecommendations: ["rec-critical"],
    })).rejects.toMatchObject({ reason: "approval_evidence_mismatch" });

    seedCompleteEvidence(state);
    await expect(recordPolicyApprovalForRollout({
      rolloutPlanId: 42,
      principal: approverPrincipal,
      decision: "approved",
      acknowledgedRecommendations: [],
    })).rejects.toMatchObject({ reason: "critical_recommendations_unacknowledged" });
  });

  test("inactive principals and duplicate approval decisions fail closed", async () => {
    state.plan.status = "review_ready";
    state.envelope = envelopeFromState(state, { rollout_status: "review_ready" });
    seedCompleteEvidence(state);
    state.activePrincipalIds.delete(approverPrincipal.principalId);

    await expect(recordPolicyApprovalForRollout({
      rolloutPlanId: 42,
      principal: approverPrincipal,
      decision: "approved",
      acknowledgedRecommendations: ["rec-critical"],
    })).rejects.toMatchObject({ reason: "authoritative_principal_inactive" });

    state.activePrincipalIds.add(approverPrincipal.principalId);
    state.duplicateApproval = true;
    await expect(recordPolicyApprovalForRollout({
      rolloutPlanId: 42,
      principal: approverPrincipal,
      decision: "approved",
      acknowledgedRecommendations: ["rec-critical"],
    })).rejects.toMatchObject({ reason: "approval_decision_already_recorded" });
  });

  test("approval expiry helper is explicitly temporal, not an authority verdict", () => {
    const now = new Date("2026-09-26T12:00:00Z");
    expect(isApprovalRecordTemporallyValid({ decision: "approved", expires_at: null }, now)).toBe(true);
    expect(isApprovalRecordTemporallyValid({
      decision: "approved",
      expires_at: "2026-09-26T11:59:59Z",
    }, now)).toBe(false);
    expect(isApprovalRecordTemporallyValid({ decision: "rejected", expires_at: null }, now)).toBe(false);
    expect(() => assertApprovalRecordTemporallyValid({
      decision: "approved",
      expires_at: "2026-09-26T11:59:59Z",
    }, now)).toThrow("approval_record_expired_or_unusable");
  });
});

describe("W2-01 scope boundary", () => {
  const source = readSource("packages/web/src/services/policyAuthorityService.js");

  test("uses the central persisted enforced authorization engine", () => {
    expect(source).toMatch(/authorizeControlled/);
    expect(source).toMatch(/mode: "enforced"/);
    expect(source).toMatch(/outcome\.persisted !== true/);
  });

  test("does not accept arbitrary evidence payloads from callers", () => {
    expect(source).toMatch(/evidenceTypes = \[\]/);
    expect(source).toMatch(/const payload = envelope\[type\]/);
  });

  test("does not mutate active policy", () => {
    expect(source).not.toMatch(/setConfigOverrides/);
    expect(source).not.toMatch(/repo_config/);
    expect(source).not.toMatch(/promoteRolloutPlan/);
  });

  test("does not use lossy Number conversion for BIGINT relationship comparisons", () => {
    expect(source).not.toMatch(/Number\(base\.repo_id\)/);
    expect(source).toMatch(/return String\(left\) === String\(right\)/);
  });
});
