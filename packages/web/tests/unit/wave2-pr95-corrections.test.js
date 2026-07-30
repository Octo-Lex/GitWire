// tests/unit/wave2-pr95-corrections.test.js
// Regression coverage for PR #95 independent-review findings.

import { jest } from "@jest/globals";

const mockQuery = jest.fn();
const mockTransaction = jest.fn();
const mockDb = { query: mockQuery, transaction: mockTransaction };
const mockRedis = { get: jest.fn(), setex: jest.fn(), del: jest.fn(), expire: jest.fn() };

jest.unstable_mockModule("../../src/lib/db.js", () => ({ db: mockDb }));
jest.unstable_mockModule("../../src/lib/queue.js", () => ({
  redis: mockRedis,
  webhookEventsQueue: { add: jest.fn() },
  triageQueue: { add: jest.fn() },
}));
jest.unstable_mockModule("../../src/lib/logger.js", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const { executeFirstBootstrap } = await import("../../src/services/auth/bootstrapService.js");
const { resolveSession } = await import("../../src/services/auth/sessionResolver.js");
const { authorize } = await import("../../src/services/auth/authorize.js");
const { resolveResource } = await import("../../src/middleware/routeAuthObserver.js");

beforeEach(() => {
  mockQuery.mockReset();
  mockTransaction.mockReset();
  mockRedis.get.mockReset();
});

describe("PR #95 review corrections", () => {
  it("executes bootstrap under gitwire_app session authorization", async () => {
    const clientQuery = jest.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ principal_id: "admin-principal" }] });
    mockTransaction.mockImplementationOnce(async (fn) => fn({ query: clientQuery }));

    const result = await executeFirstBootstrap({
      adminDisplayName: "first-admin",
      credentialLookupId: "first-admin-key",
      rawAdminSecret: "raw-secret-for-test",
    });

    expect(result).toEqual({ ok: true, principalId: "admin-principal" });
    expect(clientQuery).toHaveBeenCalledTimes(2);
    expect(clientQuery.mock.calls[0][0]).toBe("SET LOCAL SESSION AUTHORIZATION gitwire_app");
    expect(clientQuery.mock.calls[1][0]).toContain("gitwire_auth.complete_bootstrap");
    expect(clientQuery.mock.calls[1][1][2]).not.toBe("raw-secret-for-test");
  });

  it("binds session validation to the presented token hash and session id", async () => {
    mockRedis.get.mockResolvedValueOnce(JSON.stringify({
      principalId: "principal-1",
      sessionId: "session-old",
    }));
    mockQuery
      .mockResolvedValueOnce({
        rows: [{
          id: "session-old",
          principal_id: "principal-1",
          auth_epoch: 3,
          expires_at: new Date(Date.now() + 60_000).toISOString(),
          revoked_at: null,
          status: "active",
        }],
      })
      .mockResolvedValueOnce({
        rows: [{
          id: "principal-1",
          principal_type: "user",
          display_name: "user",
          status: "active",
          auth_epoch: 3,
          github_user_id: null,
          installation_id: null,
        }],
      });

    const result = await resolveSession("presented-token");

    expect(result.code).toBe("allowed");
    expect(result.context.sessionId).toBe("session-old");
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toContain("s.session_hash = $2");
    expect(sql).toContain("s.id::text = $3::text");
    expect(params[0]).toBe("principal-1");
    expect(params[1]).toMatch(/^[a-f0-9]{64}$/);
    expect(params[1]).not.toBe("presented-token");
    expect(params[2]).toBe("session-old");
  });

  it("does not let a revoked presented session borrow another session", async () => {
    mockRedis.get.mockResolvedValueOnce(JSON.stringify({
      principalId: "principal-1",
      sessionId: "session-revoked",
    }));
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: "session-revoked",
        principal_id: "principal-1",
        auth_epoch: 3,
        expires_at: new Date(Date.now() + 60_000).toISOString(),
        revoked_at: new Date().toISOString(),
        status: "active",
      }],
    });

    const result = await resolveSession("revoked-token");

    expect(result).toEqual({ context: null, code: "session_revoked" });
    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(mockQuery.mock.calls[0][1][2]).toBe("session-revoked");
  });

  it("resolves a CI run to its trusted repository resource", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ github_id: "99002", installation_id: "99001", owner: "octo", name: "repo" }],
    });

    const resource = await resolveResource("repository", { runId: "ci-run-1" });

    expect(resource).toEqual({
      type: "repository",
      installationId: "99001",
      repositoryId: "99002",
      organization: "octo",
      repository: "repo",
    });
    expect(mockQuery.mock.calls[0][0]).toContain("FROM ci_runs cr");
    expect(mockQuery.mock.calls[0][1]).toEqual(["ci-run-1"]);
  });

  it("resolves repository sync to its trusted installation resource", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ github_id: "99002", installation_id: "99001", owner: "octo", name: "repo" }],
    });

    const resource = await resolveResource("installation", { owner: "octo", repo: "repo" });

    expect(resource).toEqual({
      type: "installation",
      installationId: "99001",
      organization: "octo",
      repository: "repo",
    });
  });

  it("represents aggregate HTTP operations as fleet resources", async () => {
    await expect(resolveResource("fleet", {})).resolves.toEqual({ type: "fleet" });
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("fails closed when an installation resource lacks a trusted id", async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [{
          id: "principal-1",
          principal_type: "user",
          display_name: "user",
          status: "active",
          auth_epoch: 0,
          github_user_id: null,
          installation_id: null,
        }],
      })
      .mockResolvedValueOnce({ rows: [] });

    const decision = await authorize({
      principal: { principalId: "principal-1", authenticationMethod: "api_key" },
      permission: "installation:read",
      resource: { type: "installation" },
    });

    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe("resource_unknown");
  });
});
