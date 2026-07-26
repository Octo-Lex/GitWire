// tests/unit/wave2-authorize-integration.test.js
//
// Real authorize() integration test (Wave 2 / issue #94).
//
// Runs the REAL authorize() implementation (NOT mocked) against a controlled
// mock DB. Proves the actual authorization logic evaluates principal,
// permission, resource, and scope — and persists the correct decision.
//
// This complements the handler interaction test (which may spy on authorize)
// by verifying the real implementation behavior.

import { jest } from "@jest/globals";

const mockQuery = jest.fn();
const mockDb = {
  query: mockQuery,
  transaction: jest.fn(async (fn) => fn({ query: mockQuery })),
};

jest.unstable_mockModule("../../src/lib/db.js", () => ({ db: mockDb }));
jest.unstable_mockModule("../../src/lib/logger.js", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// Do NOT mock authorize — let the real implementation run.
const { authorize } = await import("../../src/services/auth/authorize.js");
const { DecisionCode } = await import("../../src/services/auth/denialCodes.js");

beforeEach(() => {
  mockQuery.mockReset();
});

describe("Wave 2 — real authorize() integration", () => {
  it("returns ALLOWED when principal has a matching fleet-scope assignment", async () => {
    // Principal exists and is active.
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: "p1", principal_type: "user", display_name: "test", status: "active", auth_epoch: 0, github_user_id: null, installation_id: null }],
    });
    // Matching assignment found (fleet scope, correct permission).
    mockQuery.mockResolvedValueOnce({
      rows: [{ assignment_id: "a1", scope_type: "fleet", scope_id: null, permission: "repository:read" }],
    });
    // The decision log INSERT (best-effort, returns rows).
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const decision = await authorize({
      principal: { principalId: "p1", authenticationMethod: "api_key" },
      permission: "repository:read",
      resource: { type: "repository", installationId: 100, repositoryId: 200, organization: "org", repository: "repo" },
    });

    expect(decision.allowed).toBe(true);
    expect(decision.code).toBe(DecisionCode.ALLOWED);
    expect(decision.matchedAssignmentId).toBe("a1");
    expect(decision.matchedScopeType).toBe("fleet");
    expect(decision.principalId).toBe("p1");
    expect(decision.permission).toBe("repository:read");
  });

  it("returns PERMISSION_MISSING when principal has no assignment granting the permission", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: "p1", principal_type: "user", display_name: "test", status: "active", auth_epoch: 0, github_user_id: null, installation_id: null }],
    });
    mockQuery.mockResolvedValueOnce({ rows: [] }); // no matching assignment
    mockQuery.mockResolvedValueOnce({ rows: [] }); // scope check: no permission at all
    mockQuery.mockResolvedValueOnce({ rows: [] }); // decision log INSERT

    const decision = await authorize({
      principal: { principalId: "p1", authenticationMethod: "api_key" },
      permission: "repository:read",
      resource: { type: "repository", installationId: 100, repositoryId: 200 },
    });

    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe(DecisionCode.PERMISSION_MISSING);
  });

  it("returns SCOPE_MISMATCH when principal has the permission but wrong scope", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: "p1", principal_type: "user", display_name: "test", status: "active", auth_epoch: 0, github_user_id: null, installation_id: null }],
    });
    mockQuery.mockResolvedValueOnce({ rows: [] }); // no matching assignment in scope
    mockQuery.mockResolvedValueOnce({
      rows: [{ "1": 1 }], // scope check: HAS the permission but not in this scope
    });
    mockQuery.mockResolvedValueOnce({ rows: [] }); // decision log

    const decision = await authorize({
      principal: { principalId: "p1", authenticationMethod: "api_key" },
      permission: "repository:read",
      resource: { type: "repository", installationId: 100, repositoryId: 200 },
    });

    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe(DecisionCode.SCOPE_MISMATCH);
  });

  it("returns PRINCIPAL_DISABLED for a disabled principal", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: "p1", principal_type: "user", display_name: "test", status: "disabled", auth_epoch: 0, github_user_id: null, installation_id: null }],
    });
    mockQuery.mockResolvedValueOnce({ rows: [] }); // decision log

    const decision = await authorize({
      principal: { principalId: "p1", authenticationMethod: "api_key" },
      permission: "repository:read",
      resource: { type: "repository", installationId: 100, repositoryId: 200 },
    });

    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe(DecisionCode.PRINCIPAL_DISABLED);
  });

  it("returns UNAUTHENTICATED for a null principal", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] }); // decision log

    const decision = await authorize({
      principal: null,
      permission: "repository:read",
      resource: { type: "repository", installationId: 100, repositoryId: 200 },
    });

    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe(DecisionCode.UNAUTHENTICATED);
  });

  it("returns AUTHORIZATION_ERROR on DB failure (fail-closed)", async () => {
    mockQuery.mockRejectedValueOnce(new Error("connection lost"));
    mockQuery.mockResolvedValueOnce({ rows: [] }); // decision log for the error case

    const decision = await authorize({
      principal: { principalId: "p1", authenticationMethod: "api_key" },
      permission: "repository:read",
      resource: { type: "repository", installationId: 100, repositoryId: 200 },
    });

    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe(DecisionCode.AUTHORIZATION_ERROR);
  });

  it("returns RESOURCE_UNKNOWN for repository without installationId/repositoryId", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: "p1", principal_type: "user", display_name: "test", status: "active", auth_epoch: 0, github_user_id: null, installation_id: null }],
    });
    mockQuery.mockResolvedValueOnce({ rows: [] }); // decision log

    const decision = await authorize({
      principal: { principalId: "p1", authenticationMethod: "api_key" },
      permission: "repository:read",
      resource: { type: "repository", installationId: null, repositoryId: null },
    });

    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe(DecisionCode.RESOURCE_UNKNOWN);
  });

  it("returns RESOURCE_MISSING for null resource", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: "p1", principal_type: "user", display_name: "test", status: "active", auth_epoch: 0, github_user_id: null, installation_id: null }],
    });
    mockQuery.mockResolvedValueOnce({ rows: [] }); // decision log

    const decision = await authorize({
      principal: { principalId: "p1", authenticationMethod: "api_key" },
      permission: "repository:read",
      resource: null,
    });

    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe(DecisionCode.RESOURCE_MISSING);
  });

  it("persists exactly one auth_decision_log row per decision", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: "p1", principal_type: "user", display_name: "test", status: "active", auth_epoch: 0, github_user_id: null, installation_id: null }],
    });
    mockQuery.mockResolvedValueOnce({
      rows: [{ assignment_id: "a1", scope_type: "fleet", scope_id: null, permission: "repository:read" }],
    });
    mockQuery.mockResolvedValueOnce({ rows: [] }); // decision log INSERT

    await authorize({
      principal: { principalId: "p1", authenticationMethod: "api_key" },
      permission: "repository:read",
      resource: { type: "repository", installationId: 100, repositoryId: 200 },
    });

    // Count INSERT INTO auth_decision_log calls — exactly one.
    const decisionLogInserts = mockQuery.mock.calls.filter(
      ([text]) => text && text.includes("INSERT INTO gitwire_auth.auth_decision_log")
    );
    expect(decisionLogInserts.length).toBe(1);

    // Verify the persisted row has the exact principal, permission, resource.
    const params = decisionLogInserts[0][1];
    expect(params).toContain("p1");           // principal_id
    expect(params).toContain("repository:read"); // permission
    expect(params).toContain("repository");     // resource_type
    expect(params).toContain(100);              // resource_installation_id
    expect(params).toContain(200);              // resource_repository_id
    expect(params).toContain(true);             // allowed
    expect(params).toContain("allowed");        // code
  });
});
