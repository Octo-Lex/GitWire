// tests/unit/wave2-auth-context.test.js
//
// Unit tests for the Wave 2 runtime identity + authorization layer (issue #94).
// Exercises the actual service modules (denialCodes, context, principalResolver,
// authorize, workerContext, observeAdopt) with mocked db.

import { jest } from "@jest/globals";

// Mock db before importing modules that depend on it.
const mockQuery = jest.fn();
const mockDb = { query: mockQuery, transaction: jest.fn(async (fn) => fn({ query: mockQuery })) };

// Mock redis for session resolver.
const mockRedis = { get: jest.fn(), setex: jest.fn(), del: jest.fn(), expire: jest.fn() };

// Inject mocks via module mocks.
jest.unstable_mockModule("../../src/lib/db.js", () => ({ db: mockDb }));
jest.unstable_mockModule("../../src/lib/queue.js", () => ({
  redis: mockRedis,
  // Re-export the real queue singletons the app expects.
  webhookEventsQueue: { add: jest.fn() },
  triageQueue: { add: jest.fn() },
}));
jest.unstable_mockModule("../../src/lib/logger.js", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const { DecisionCode, REQUIRED_DENIAL_CATEGORIES, ALL_DECISION_CODES } =
  await import("../../src/services/auth/denialCodes.js");
const { createContext, createDecision, unauthenticatedContext } =
  await import("../../src/services/auth/context.js");
const { getPrincipalById, principalValidityCode, getInstallationPrincipal } =
  await import("../../src/services/auth/principalResolver.js");
const { authorize } = await import("../../src/services/auth/authorize.js");
const { resolveSystemWorkerContext, resolveInstallationWorkerContext } =
  await import("../../src/services/auth/workerContext.js");

beforeEach(() => {
  mockQuery.mockReset();
  mockRedis.get.mockReset();
});

describe("Wave 2 — denial codes", () => {
  it("provides the required stable denial categories", () => {
    for (const code of REQUIRED_DENIAL_CATEGORIES) {
      expect(typeof code).toBe("string");
      expect(code.length).toBeGreaterThan(0);
    }
    expect(REQUIRED_DENIAL_CATEGORIES.length).toBeGreaterThanOrEqual(14);
  });

  it("every code is unique", () => {
    const set = new Set(ALL_DECISION_CODES);
    expect(set.size).toBe(ALL_DECISION_CODES.length);
  });

  it("ALLOWED is the only non-deny code", () => {
    expect(DecisionCode.ALLOWED).toBe("allowed");
    const denies = ALL_DECISION_CODES.filter((c) => c !== DecisionCode.ALLOWED);
    expect(denies.length).toBeGreaterThanOrEqual(14);
  });
});

describe("Wave 2 — context model", () => {
  it("creates an immutable AuthContext with explicit nulls", () => {
    const ctx = createContext({
      principalId: "uuid-1",
      principalType: "user",
      sessionId: null,
      credentialId: null,
      authenticationMethod: "session",
      assuranceLevel: "level1",
      authEpoch: 0,
    });
    expect(ctx.principalId).toBe("uuid-1");
    expect(ctx.sessionId).toBeNull();
    expect(ctx.credentialId).toBeNull();
    expect(ctx.installationId).toBeNull();
    expect(() => { ctx.principalId = "mutated"; }).toThrow();
  });

  it("unauthenticatedContext has null principalId", () => {
    const ctx = unauthenticatedContext();
    expect(ctx.principalId).toBeNull();
    expect(ctx.principalType).toBe("anonymous");
  });

  it("creates an immutable AuthorizationDecision", () => {
    const d = createDecision({
      allowed: false,
      code: DecisionCode.PERMISSION_MISSING,
      principalId: "uuid-1",
      permission: "repository:read",
      resource: { type: "repository", installationId: 1, repositoryId: 2 },
    });
    expect(d.allowed).toBe(false);
    expect(d.code).toBe("permission_missing");
    expect(d.resource.installationId).toBe(1);
    expect(() => { d.allowed = true; }).toThrow();
  });
});

describe("Wave 2 — principal validity", () => {
  it("null principal → unauthenticated", () => {
    expect(principalValidityCode(null)).toBe("unauthenticated");
  });

  it("disabled principal → principal_disabled", () => {
    expect(principalValidityCode({ status: "disabled" })).toBe("principal_disabled");
  });

  it("active principal → allowed", () => {
    expect(principalValidityCode({ status: "active" })).toBe("allowed");
  });
});

describe("Wave 2 — authorize service", () => {
  it("returns UNAUTHENTICATED for null principal", async () => {
    const d = await authorize({
      principal: null,
      permission: "repository:read",
      resource: { type: "repository", installationId: 1, repositoryId: 2 },
    });
    expect(d.allowed).toBe(false);
    expect(d.code).toBe(DecisionCode.UNAUTHENTICATED);
  });

  it("returns AUTHORIZATION_ERROR on DB error (fail-closed)", async () => {
    mockQuery.mockRejectedValueOnce(new Error("connection lost"));
    const d = await authorize({
      principal: { principalId: "uuid-1", authenticationMethod: "api_key" },
      permission: "repository:read",
      resource: { type: "repository", installationId: 1, repositoryId: 2 },
    });
    expect(d.allowed).toBe(false);
    expect(d.code).toBe(DecisionCode.AUTHORIZATION_ERROR);
  });

  it("returns RESOURCE_MISSING for null resource", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: "uuid-1", principal_type: "user", display_name: "test", status: "active", auth_epoch: 0 }] });
    const d = await authorize({
      principal: { principalId: "uuid-1", authenticationMethod: "api_key" },
      permission: "repository:read",
      resource: null,
    });
    expect(d.allowed).toBe(false);
    expect(d.code).toBe(DecisionCode.RESOURCE_MISSING);
  });

  it("returns ALLOWED when a matching assignment grants the permission", async () => {
    // principal lookup
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: "uuid-1", principal_type: "user", display_name: "test", status: "active", auth_epoch: 0, github_user_id: null, installation_id: null }],
    });
    // matching assignment
    mockQuery.mockResolvedValueOnce({
      rows: [{ assignment_id: "asg-1", scope_type: "fleet", scope_id: null, permission: "repository:read" }],
    });
    const d = await authorize({
      principal: { principalId: "uuid-1", authenticationMethod: "api_key" },
      permission: "repository:read",
      resource: { type: "repository", installationId: 1, repositoryId: 2 },
    });
    expect(d.allowed).toBe(true);
    expect(d.code).toBe(DecisionCode.ALLOWED);
    expect(d.matchedScopeType).toBe("fleet");
  });

  it("returns PERMISSION_MISSING when principal has no assignment granting the permission", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: "uuid-1", principal_type: "user", display_name: "test", status: "active", auth_epoch: 0, github_user_id: null, installation_id: null }],
    });
    // no matching assignment
    mockQuery.mockResolvedValueOnce({ rows: [] });
    // scope check: also no permission at all
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const d = await authorize({
      principal: { principalId: "uuid-1", authenticationMethod: "api_key" },
      permission: "repository:read",
      resource: { type: "repository", installationId: 1, repositoryId: 2 },
    });
    expect(d.allowed).toBe(false);
    expect(d.code).toBe(DecisionCode.PERMISSION_MISSING);
  });
});

describe("Wave 2 — worker context", () => {
  it("resolveSystemWorkerContext returns a system principal context", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: "sys-uuid", principal_type: "system", display_name: "system:scheduler", status: "active", auth_epoch: 0, github_user_id: null, installation_id: null }],
    });
    const ctx = await resolveSystemWorkerContext("system:scheduler");
    expect(ctx).not.toBeNull();
    expect(ctx.principalType).toBe("system");
    expect(ctx.authenticationMethod).toBe("system");
  });

  it("resolveSystemWorkerContext returns null for unknown system principal", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const ctx = await resolveSystemWorkerContext("system:nonexistent");
    expect(ctx).toBeNull();
  });

  it("resolveInstallationWorkerContext returns an installation principal context", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: "inst-uuid", principal_type: "installation", display_name: "fx-inst", status: "active", auth_epoch: 0, github_user_id: null, installation_id: 99999 }],
    });
    const ctx = await resolveInstallationWorkerContext(99999);
    expect(ctx).not.toBeNull();
    expect(ctx.principalType).toBe("installation");
    expect(ctx.authenticationMethod).toBe("webhook_hmac");
    expect(ctx.installationId).toBe(99999);
  });

  it("resolveInstallationWorkerContext returns null for missing installationId", async () => {
    const ctx = await resolveInstallationWorkerContext(null);
    expect(ctx).toBeNull();
  });
});
