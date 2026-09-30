// tests/unit/w3-01-mutation-commands.test.js
// W3-01 unit proofs: source-boundary regressions (A19/A23), validation,
// policy-context shape enforcement (A16/A17), replay/conflict semantics over
// a mocked database, and canonical-hash behavior through the service path.

import { jest } from "@jest/globals";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
function read(relPath) {
  return fs.readFileSync(path.resolve(ROOT, relPath), "utf-8");
}

const mockQuery = jest.fn();
const mockTransaction = jest.fn(async (fn) => fn({ query: mockQuery }));
const mockAuthorizeControlled = jest.fn();

jest.unstable_mockModule("../../src/lib/db.js", () => ({ db: { query: mockQuery, transaction: mockTransaction } }));
jest.unstable_mockModule("../../src/lib/logger.js", () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
}));
jest.unstable_mockModule("../../src/services/auth/authorize.js", () => ({
  authorizeControlled: mockAuthorizeControlled,
}));
jest.unstable_mockModule("../../src/services/auth/decisionLog.js", () => ({
  logDecision: jest.fn(async () => true),
  persistDecisionEvidence: jest.fn(async () => "evidence-row-id-1"),
}));

const { createMutationCommand, MutationCommandError } = await import("../../src/services/mutationCommandService.js");
const { hashCanonical } = await import("@gitwire/rules");

const baseParams = (overrides = {}) => ({
  authority: {
    principal: { principalId: "11111111-1111-4111-8111-111111111111", authenticationMethod: "api_key" },
    permission: "policy_rollout_plan:approve",
  },
  resource: { type: "repository", installationId: 986200001, repositoryId: 986200102 },
  operation: "w3-01.test:op",
  target: { path: "README.md" },
  request: { action: "label", label: "bug" },
  idempotency: { namespace: "w3-01.test", key: "op-1" },
  policyContext: null,
  ...overrides,
});

beforeEach(() => {
  mockQuery.mockReset();
  // Default routing: identity lookups find nothing; inserts return plausible rows.
  mockQuery.mockImplementation(async (sql) => {
    const q = typeof sql === "string" ? sql : "";
    if (q.includes("INSERT INTO public.mutation_commands")) {
      return { rows: [{ id: "cmd-generated-1", request_hash: "x" }] };
    }
    if (q.includes("INSERT INTO public.mutation_outbox")) {
      return { rows: [{ seq: 1, event_id: "event-1", created_at: "2026-09-30T00:00:00Z" }] };
    }
    return { rows: [] };
  });
  mockTransaction.mockClear();
  mockAuthorizeControlled.mockReset();
  mockAuthorizeControlled.mockResolvedValue({
    decision: {
      allowed: true,
      code: "granted",
      principalId: "11111111-1111-4111-8111-111111111111",
      permission: "policy_rollout_plan:approve",
      resource: { type: "repository", installationId: 986200001, repositoryId: 986200102 },
      policyVersion: "level1",
    },
    persisted: true,
    mode: "enforced",
    blocked: false,
    evidenceId: "evidence-row-id-1",
  });
});

describe("W3-01 scope-boundary regressions (A19, A23)", () => {
  const rawServiceSource = read("packages/web/src/services/mutationCommandService.js");
  // Comments may NAME prohibited machinery while prohibiting it; only code counts.
  const serviceSource = rawServiceSource
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");

  test("the command service performs zero GitHub/provider mutation calls", () => {
    expect(serviceSource).not.toMatch(/github|octokit|rest\.repos|api\.github/);
    expect(serviceSource).not.toMatch(/getInstallationClient|wrapOctokit/);
  });

  test("no dispatcher, executor, receipt or reconciliation machinery is introduced", () => {
    expect(serviceSource).not.toMatch(/dispatch|executor|publishReceipt|reconcil/);
    for (const forbidden of [
      "packages/web/src/services/mutationDispatcherService.js",
      "packages/web/src/services/mutationExecutorService.js",
      "packages/web/src/services/effectReceiptService.js",
      "packages/web/src/services/reconciliationService.js",
      "packages/web/src/services/authorityLedgerService.js",
    ]) {
      expect(fs.existsSync(path.resolve(ROOT, forbidden))).toBe(false);
    }
  });

  test("no existing writer is cut over: createMutationCommand is consumed by no route or worker", () => {
    const srcRoot = path.resolve(ROOT, "packages/web/src");
    const consumers = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith(".js") && !full.includes("mutationCommandService")) {
          if (fs.readFileSync(full, "utf-8").includes("createMutationCommand")) consumers.push(full);
        }
      }
    };
    walk(srcRoot);
    expect(consumers).toEqual([]);
  });

  test("the transactional evidence seam leaves logDecision best-effort semantics intact", () => {
    const decisionLogSource = read("packages/web/src/services/auth/decisionLog.js");
    expect(decisionLogSource).toMatch(/Best-effort; never throws/);
    expect(decisionLogSource).toMatch(/decisionLog: insert failed \(non-fatal\)/);
    expect(decisionLogSource).toMatch(/RETURNING id/);
  });

  test("command-bound evidence is routed through authorize's transaction-aware mode (one row, not two)", () => {
    const serviceSourceCode = read("packages/web/src/services/mutationCommandService.js")
      .split("\n").filter((line) => !line.trim().startsWith("//")).join("\n");
    expect(serviceSourceCode).toMatch(/evidenceClient: tx/);
    expect(serviceSourceCode).not.toMatch(/persistDecisionEvidence/);
    const authorizeSource = read("packages/web/src/services/auth/authorize.js");
    expect(authorizeSource).toMatch(/evidenceClient/);
    expect(authorizeSource).toMatch(/persistDecisionEvidence/);
  });
});

describe("W3-01 validation and policy-context identity (A16, A17)", () => {
  test.each([
    ["missing principal", { authority: { principal: {}, permission: "p" } }],
    ["missing permission", { authority: { principal: { principalId: "x" } } }],
    ["missing resource type", { resource: {} }],
    ["missing operation", { operation: "" }],
    ["missing target", { target: null }],
    ["missing request", { request: null }],
    ["missing namespace", { idempotency: { key: "k" } }],
    ["missing key", { idempotency: { namespace: "n" } }],
    ["hostile namespace payload", { idempotency: { namespace: "ns; DROP TABLE x; --", key: "k" } }],
    ["oversized namespace", { idempotency: { namespace: "a".repeat(129), key: "k" } }],
    ["key with whitespace/newlines", { idempotency: { namespace: "n", key: "line1
line2" } }],
  ])("rejects %s", async (_label, overrides) => {
    await expect(createMutationCommand(baseParams(overrides))).rejects.toMatchObject({
      name: "MutationCommandError",
    });
  });

  test("accepts only the canonical W2-04 resolution identity shape", async () => {
    await expect(createMutationCommand(baseParams({
      policyContext: { version_vector: { defaults: "x" }, effective_hash: "sha256:" + "a".repeat(64) },
    }))).rejects.toMatchObject({ reason: "policy_context_invalid" });

    await expect(createMutationCommand(baseParams({
      policyContext: { version_vector: { defaults: "1", org: null, repo: null, governed: null }, effective_hash: "nothex" },
    }))).rejects.toMatchObject({ reason: "policy_context_invalid" });

    // No alternative identity field exists: extra properties are not a
    // client-supplied replacement path.
    const valid = await createMutationCommand(baseParams({
      policyContext: {
        version_vector: { defaults: "w2-04.1", org: null, repo: null, governed: null },
        effective_hash: "sha256:" + "b".repeat(64),
      },
    }));
    expect(valid.created).toBe(true);
    // The stored policy context param is exactly the two canonical values.
    const insertParams = mockQuery.mock.calls.find((c) => String(c[0]).includes("INSERT INTO public.mutation_commands"))?.[1];
    const stored = JSON.parse(insertParams[10]);
    expect(Object.keys(stored).sort()).toEqual(["effective_hash", "version_vector"]);
  });
});

describe("W3-01 replay and conflict semantics (A9, A10)", () => {
  const replayRequest = { action: "label", label: "bug" };
  const committedCommand = {
    id: "22222222-2222-4222-8222-222222222222",
    principal_id: "11111111-1111-4111-8111-111111111111",
    request_hash: hashCanonical({
      operation: "w3-01.test:op",
      resource_type: "repository",
      resource_identity: "repository:986200102",
      target: { path: "README.md" },
      request: replayRequest,
    }),
  };

  test("identical committed replay returns the original and creates nothing", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [committedCommand] });
    const result = await createMutationCommand(baseParams({
      request: { label: "bug", action: "label" }, // same content, different key order
    }));
    // The pre-check must have found a committed row with the SAME hash for
    // this to be a replay — the service hashes before looking up.
    expect(result.replay).toBe(true);
    expect(result.created).toBe(false);
    expect(result.command.id).toBe(committedCommand.id);
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  test("conflicting committed replay fails closed with diagnostics", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [committedCommand] });
    const promise = createMutationCommand(baseParams({ request: { different: true } }));
    await expect(promise).rejects.toMatchObject({
      reason: "idempotency_conflict",
      detail: {
        existing_command_id: committedCommand.id,
        existing_request_hash: committedCommand.request_hash,
      },
    });
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  test("a different principal reusing an idempotency identity fails closed with no disclosure", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [committedCommand] });
    const promise = createMutationCommand(baseParams({
      authority: {
        principal: { principalId: "99999999-9999-4999-8999-999999999999" },
        permission: "policy_rollout_plan:approve",
      },
      request: { action: "label", label: "bug" },
    }));
    await expect(promise).rejects.toMatchObject({
      reason: "idempotency_principal_mismatch",
      detail: null,
    });
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  test("same key with a materially different target is a conflict, not a replay", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [committedCommand] });
    const promise = createMutationCommand(baseParams({
      request: { action: "label", label: "bug" },
      target: { path: "OTHER.md" },
    }));
    await expect(promise).rejects.toMatchObject({
      reason: "idempotency_conflict",
    });
  });

  test("authorization denial fails closed before any persistence", async () => {
    mockAuthorizeControlled.mockResolvedValueOnce({
      decision: { allowed: false, code: "no_assignment", principalId: "p" },
      persisted: true,
      mode: "enforced",
      blocked: true,
    });
    await expect(createMutationCommand(baseParams())).rejects.toMatchObject({
      reason: "authorization_denied",
    });
    const inserts = mockQuery.mock.calls.filter((c) => String(c[0]).includes("INSERT INTO"));
    expect(inserts).toEqual([]);
  });
});

describe("W3-01 canonical hashing through the service path (A6, A7)", () => {
  test("equivalent requests in different key orders produce identical stored hashes", async () => {
    await createMutationCommand(baseParams({ idempotency: { namespace: "w3-01.test", key: "hash-a" } }));
    await createMutationCommand(baseParams({
      request: { label: "bug", action: "label" },
      idempotency: { namespace: "w3-01.test", key: "hash-b" },
    }));
    const hashes = mockQuery.mock.calls
      .filter((c) => String(c[0]).includes("INSERT INTO public.mutation_commands"))
      .map((c) => c[1][7]);
    expect(hashes).toHaveLength(2);
    expect(hashes[0]).toBe(hashes[1]);
    expect(hashes[0]).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  test("meaningfully different requests produce different hashes", async () => {
    await createMutationCommand(baseParams({ idempotency: { namespace: "w3-01.test", key: "hash-c" } }));
    await createMutationCommand(baseParams({
      request: { action: "label", label: "security" },
      idempotency: { namespace: "w3-01.test", key: "hash-d" },
    }));
    const hashes = mockQuery.mock.calls
      .filter((c) => String(c[0]).includes("INSERT INTO public.mutation_commands"))
      .map((c) => c[1][7]);
    expect(hashes[0]).not.toBe(hashes[1]);
  });
});

describe("W3-01 server-owned attribution (A3)", () => {
  test("resource identity derives from the authoritative id, ignoring caller-supplied display identity", async () => {
    await createMutationCommand(baseParams({
      resource: { type: "repository", installationId: 986200001, repositoryId: 986200102, identity: "attacker/override", repository: "display-name" },
    }));
    const insertParams = mockQuery.mock.calls.find((c) => String(c[0]).includes("INSERT INTO public.mutation_commands"))?.[1];
    expect(insertParams[4]).toBe("repository:986200102");
  });

  test("compatibility actor metadata cannot override the server principal", async () => {
    await createMutationCommand(baseParams({
      authority: {
        principal: { principalId: "11111111-1111-4111-8111-111111111111", authenticationMethod: "api_key" },
        permission: "policy_rollout_plan:approve",
        actor: "attacker-display-name", // compatibility metadata: ignored
      },
    }));
    const insertParams = mockQuery.mock.calls.find((c) => String(c[0]).includes("INSERT INTO public.mutation_commands"))?.[1];
    expect(insertParams[8]).toBe("11111111-1111-4111-8111-111111111111");
  });
});
