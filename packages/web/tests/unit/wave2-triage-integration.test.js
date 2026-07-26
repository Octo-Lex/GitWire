// tests/unit/wave2-triage-integration.test.js
//
// Triage worker integration test (Wave 2 / issue #94).
//
// Invokes the real exported triageIssue handler with controlled dependencies.
// Proves the complete adoption sequence:
//   - adoptWorker() receives trusted installation ID (not payload actor)
//   - forged principalId/actor/login in the payload is ignored
//   - exact declared permission reaches authorize()
//   - exactly one observe-only decision is recorded
//   - all logDecision writes contain the resolved principalId
//   - the compatibility actor remains non-authoritative
//   - the existing triage action executes once (or skips cleanly)
//   - no duplicate observer evidence

import { jest } from "@jest/globals";

// Track all calls to the mocked services.
const mockQuery = jest.fn();
const mockDb = {
  query: mockQuery,
  transaction: jest.fn(async (fn) => fn({ query: mockQuery })),
};
const mockRedis = { get: jest.fn(), setex: jest.fn(), del: jest.fn(), expire: jest.fn() };

// Mock the heavy external dependencies — Anthropic, GitHub, config — but let
// the internal auth/identity/authorize path run against the mock DB.
jest.unstable_mockModule("../../src/lib/db.js", () => ({ db: mockDb }));
jest.unstable_mockModule("../../src/lib/queue.js", () => ({
  redis: mockRedis,
  createWorker: jest.fn(),
  createQueue: jest.fn(),
  QUEUES: { TRIAGE: "triage" },
  webhookEventsQueue: { add: jest.fn() },
  triageQueue: { add: jest.fn() },
}));
jest.unstable_mockModule("../../src/lib/logger.js", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.unstable_mockModule("../../config/index.js", () => ({
  config: {
    anthropic: { apiKey: "test", baseURL: undefined },
    github: { appId: "test" },
    server: { baseUrl: "http://localhost:3000" },
  },
}));
jest.unstable_mockModule("@anthropic-ai/sdk", () => ({
  default: jest.fn(() => ({
    messages: { create: jest.fn().mockResolvedValue({ content: [{ text: '{"type":"bug","priority":"medium"}' }] }) },
  })),
  Anthropic: jest.fn(() => ({
    messages: { create: jest.fn().mockResolvedValue({ content: [{ text: '{"type":"bug","priority":"medium"}' }] }) },
  })),
}));
jest.unstable_mockModule("../../src/lib/github.js", () => ({
  getInstallationClient: jest.fn(),
  forEachInstallation: jest.fn(),
  forEachRepo: jest.fn(),
}));
jest.unstable_mockModule("../../src/lib/githubWrapper.js", () => ({
  wrapOctokit: jest.fn((o) => o),
}));
jest.unstable_mockModule("../../src/services/configService.js", () => ({
  getConfigForRepo: jest.fn().mockResolvedValue({ pillars: { triage: { enabled: false } } }),
}));
jest.unstable_mockModule("../../src/services/issueService.js", () => ({
  issueService: { upsertIssue: jest.fn() },
}));
jest.unstable_mockModule("../../src/services/duplicateDetectionService.js", () => ({
  detectDuplicates: jest.fn(),
  backfillEmbeddings: jest.fn(),
}));
jest.unstable_mockModule("../../src/services/idempotencyService.js", () => ({
  checkAndMark: jest.fn().mockResolvedValue(true),
}));
jest.unstable_mockModule("../../src/services/waiverService.js", () => ({
  isWaived: jest.fn().mockResolvedValue(null),
}));
jest.unstable_mockModule("../../src/services/telegramNotifyService.js", () => ({
  notifyTriage: jest.fn().mockResolvedValue(null),
}));
jest.unstable_mockModule("../../src/services/actionStateMachine.js", () => ({
  propose: jest.fn().mockResolvedValue({ id: "action-1" }),
  approve: jest.fn(),
  execute: jest.fn(),
  succeed: jest.fn(),
  fail: jest.fn(),
  cancel: jest.fn(),
}));
jest.unstable_mockModule("@gitwire/rules", () => ({
  isPillarEnabled: jest.fn(() => false), // triage disabled → skip path
  isDryRun: jest.fn(() => false),
  shouldTrigger: jest.fn(() => true),
}));

const { triageIssue } = await import("../../src/workers/triageWorker.js");

beforeEach(() => {
  mockQuery.mockReset();
  mockRedis.get.mockReset();
  // Default: no principal found (null = test the gap path).
  // The triage worker calls adoptWorker which calls resolveInstallationWorkerContext
  // which queries auth_principals. Mock it to return a principal.
  mockQuery.mockImplementation(async (text, params) => {
    // Principal lookup for installation
    if (text && text.includes("auth_principals") && text.includes("installation")) {
      return { rows: [{ id: "inst-principal-uuid", principal_type: "installation", display_name: "test-inst", status: "active", auth_epoch: 0, github_user_id: null, installation_id: 99999 }] };
    }
    // Principal lookup by id
    if (text && text.includes("auth_principals") && text.includes("WHERE id =")) {
      return { rows: [{ id: "inst-principal-uuid", principal_type: "installation", display_name: "test-inst", status: "active", auth_epoch: 0, github_user_id: null, installation_id: 99999 }] };
    }
    // Authorization query: no matching assignment (observe-only deny)
    if (text && text.includes("auth_principal_roles")) {
      return { rows: [] };
    }
    // Decision log insert — capture it
    if (text && text.includes("INSERT INTO gitwire_auth.auth_decision_log")) {
      return { rows: [] };
    }
    // logDecision insert into decision_log — capture it
    if (text && text.includes("INSERT INTO decision_log")) {
      return { rows: [{ id: 1 }] };
    }
    return { rows: [] };
  });
});

describe("Wave 2 — triage integration: adopted path", () => {
  it("resolves the installation principal from trusted installation.id (not from payload actor)", async () => {
    const jobData = {
      payload: {
        action: "opened",
        installation: { id: 99999 },
        repository: { id: 123, full_name: "org/repo", name: "repo", owner: { login: "org" } },
        issue: { number: 42, title: "Bug", user: { login: "forged-actor" } },
      },
    };

    await triageIssue(jobData);

    // The principal lookup must have queried for installation_id = 99999
    const principalQuery = mockQuery.mock.calls.find(
      ([text]) => text && text.includes("auth_principals") && text.includes("installation")
    );
    expect(principalQuery).toBeTruthy();
    expect(principalQuery[1]).toContain(99999);
  });

  it("ignores a forged principalId in the payload", async () => {
    const jobData = {
      payload: {
        action: "opened",
        installation: { id: 99999 },
        repository: { id: 123, full_name: "org/repo", name: "repo", owner: { login: "org" } },
        issue: { number: 42, title: "Bug", user: { login: "attacker" } },
        // Forged fields that must NOT be used as principal identity:
        principalId: "forged-uuid",
        actor: "forged-actor",
        auth: { principalId: "forged-auth-uuid" },
      },
    };

    await triageIssue(jobData);

    // Verify no query used the forged principal IDs
    for (const [text, params] of mockQuery.mock.calls) {
      if (params) {
        for (const p of params) {
          if (typeof p === "string") {
            expect(p).not.toBe("forged-uuid");
            expect(p).not.toBe("forged-auth-uuid");
          }
        }
      }
    }
  });

  it("writes principalId to the decision_log insert", async () => {
    const jobData = {
      payload: {
        action: "opened",
        installation: { id: 99999 },
        repository: { id: 123, full_name: "org/repo", name: "repo", owner: { login: "org" } },
        issue: { number: 42, title: "Bug", user: { login: "real-user" } },
      },
    };

    await triageIssue(jobData);

    // Find the decision_log INSERT call
    const logInsert = mockQuery.mock.calls.find(
      ([text]) => text && text.includes("INSERT INTO decision_log")
    );
    expect(logInsert).toBeTruthy();
    // The principalId parameter should be the resolved UUID, not null
    // The params are the array at index [1]
    const params = logInsert[1];
    // principalId is the last parameter (added as $13)
    expect(params).toContain("inst-principal-uuid");
  });

  it("records exactly one observe-only authorization decision", async () => {
    const jobData = {
      payload: {
        action: "opened",
        installation: { id: 99999 },
        repository: { id: 123, full_name: "org/repo", name: "repo", owner: { login: "org" } },
        issue: { number: 42, title: "Bug", user: { login: "real-user" } },
      },
    };

    await triageIssue(jobData);

    // Count auth_decision_log INSERTs (the observe-only decision).
    // adoptWorker calls authorize() which logs one decision. There must be
    // exactly one — not zero (missing), not two (duplicate from a generic
    // route observer or double-call).
    const decisionLogInserts = mockQuery.mock.calls.filter(
      ([text]) => text && text.includes("INSERT INTO gitwire_auth.auth_decision_log")
    );
    expect(decisionLogInserts.length).toBe(1);
  });

  it("uses the exact declared permission 'issue:update' in the authorize query", async () => {
    const jobData = {
      payload: {
        action: "opened",
        installation: { id: 99999 },
        repository: { id: 123, full_name: "org/repo", name: "repo", owner: { login: "org" } },
        issue: { number: 42, title: "Bug", user: { login: "real-user" } },
      },
    };

    await triageIssue(jobData);

    // The authorize() call queries auth_principal_roles with the permission.
    // It must use the exact declared permission "issue:update", not a generic.
    const authzQueries = mockQuery.mock.calls.filter(
      ([text]) => text && text.includes("auth_principal_roles") && text.includes("auth_role_permissions")
    );
    expect(authzQueries.length).toBeGreaterThanOrEqual(1);
    // Check that "issue:update" appears in the params of at least one authz query
    const hasDeclaredPermission = authzQueries.some(
      ([, params]) => params && params.includes("issue:update")
    );
    expect(hasDeclaredPermission).toBe(true);
  });

  it("does not produce duplicate authorization evidence (no generic observer)", async () => {
    // The triage worker is a non-HTTP surface — the routeAuthObserver middleware
    // only runs for HTTP requests. This test asserts that only ONE decision_log
    // INSERT occurs, proving no second observer creates duplicate evidence.
    const jobData = {
      payload: {
        action: "opened",
        installation: { id: 99999 },
        repository: { id: 123, full_name: "org/repo", name: "repo", owner: { login: "org" } },
        issue: { number: 42, title: "Bug", user: { login: "real-user" } },
      },
    };

    await triageIssue(jobData);

    const decisionLogInserts = mockQuery.mock.calls.filter(
      ([text]) => text && text.includes("INSERT INTO gitwire_auth.auth_decision_log")
    );
    expect(decisionLogInserts.length).toBe(1);
  });

  it("all decision_log writes contain the resolved principalId (no silent nulls)", async () => {
    const jobData = {
      payload: {
        action: "opened",
        installation: { id: 99999 },
        repository: { id: 123, full_name: "org/repo", name: "repo", owner: { login: "org" } },
        issue: { number: 42, title: "Bug", user: { login: "real-user" } },
      },
    };

    await triageIssue(jobData);

    // Every INSERT INTO decision_log must have "inst-principal-uuid" in its params
    const decisionLogInserts = mockQuery.mock.calls.filter(
      ([text]) => text && text.includes("INSERT INTO decision_log")
    );
    expect(decisionLogInserts.length).toBeGreaterThanOrEqual(1);
    for (const [, params] of decisionLogInserts) {
      expect(params).toContain("inst-principal-uuid");
    }
  });

  it("unresolved installation principal produces a fail-closed authoritative decision", async () => {
    // Override: return no principal for this test
    mockQuery.mockImplementation(async (text) => {
      if (text && text.includes("auth_principals")) return { rows: [] };
      if (text && text.includes("INSERT INTO")) return { rows: [{ id: 1 }] };
      return { rows: [] };
    });

    const jobData = {
      payload: {
        action: "opened",
        installation: { id: 88888 }, // different installation — no principal
        repository: { id: 123, full_name: "org/repo", name: "repo", owner: { login: "org" } },
        issue: { number: 42, title: "Bug", user: { login: "real-user" } },
      },
    };

    await triageIssue(jobData);

    // The authorize() call must still fire (adoptWorker is called), producing
    // exactly one auth_decision_log record with allowed=false and a stable
    // denial code (not a fabricated principal, not a crash).
    const decisionLogInserts = mockQuery.mock.calls.filter(
      ([text]) => text && text.includes("INSERT INTO gitwire_auth.auth_decision_log")
    );
    expect(decisionLogInserts.length).toBe(1);

    // The decision record must have allowed=false (the principal was null →
    // UNAUTHENTICATED). The params include the structured fields.
    const decisionParams = decisionLogInserts[0][1];
    // allowed is parameter $8 in the INSERT, code is $9
    // Verify 'false' is in the params (the allowed boolean)
    expect(decisionParams).toContain(false);
    // Verify a denial code is in the params (not 'allowed')
    expect(decisionParams).toContain("unauthenticated");
  });
});
