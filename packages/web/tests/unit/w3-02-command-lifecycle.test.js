// tests/unit/w3-02-command-lifecycle.test.js
// W3-02 unit proofs: performer provenance, input validation, the frozen
// classification algorithm over a mocked database, service source contracts
// (zero external calls, no consumers), and the claim-then-advance ordering.

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

jest.unstable_mockModule("../../src/lib/db.js", () => ({ db: { query: mockQuery, transaction: mockTransaction } }));
jest.unstable_mockModule("../../src/lib/logger.js", () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
}));

const { transitionMutationCommand, MutationTransitionError } =
  await import("../../src/services/mutationLifecycleService.js");

const COMMAND_ID = "aaaaaaaa-0000-4000-8000-000000000001";
const PRINCIPAL = "11111111-1111-4111-8111-111111111111";

const base = (overrides = {}) => ({
  commandId: COMMAND_ID,
  expectedVersion: 1,
  nextStatus: "claimed",
  performer: { principalId: PRINCIPAL },
  reason: "test",
  ...overrides,
});

// Route SELECTs to a current command at (status, version); everything else
// gets a plausible empty result.
function commandAt(status, version) {
  return async (sql) => {
    const q = typeof sql === "string" ? sql : "";
    if (q.includes("FROM public.mutation_commands")) {
      return { rows: [{ id: COMMAND_ID, status, version }] };
    }
    if (q.includes("INSERT INTO public.mutation_command_transitions")) {
      return { rows: [{ transitioned_at: "2026-10-01T00:00:00Z" }] };
    }
    if (q.includes("UPDATE public.mutation_commands")) {
      return { rows: [], rowCount: 1 };
    }
    return { rows: [] };
  };
}

beforeEach(() => {
  mockQuery.mockReset();
  mockTransaction.mockClear();
});

describe("W3-02 scope-boundary regressions (A11, A12, A16)", () => {
  const source = read("packages/web/src/services/mutationLifecycleService.js");
  const code = source.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");

  test("zero GitHub/provider calls; no dispatch, receipts, or reconciliation", () => {
    expect(code).not.toMatch(/github|octokit|getInstallationClient|wrapOctokit/);
    expect(code).not.toMatch(/dispatch|receipt|reconcil/);
  });

  test("no route or worker consumes the transition service", () => {
    const srcRoot = path.resolve(ROOT, "packages/web/src");
    const consumers = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith(".js") && !full.includes("mutationLifecycleService")) {
          if (fs.readFileSync(full, "utf-8").includes("transitionMutationCommand")) consumers.push(full);
        }
      }
    };
    walk(srcRoot);
    expect(consumers).toEqual([]);
  });

  test("claim precedes advance; advance keeps the mandatory version predicate", () => {
    const order = {
      claim: source.indexOf("INSERT INTO public.mutation_command_transitions"),
      advance: source.indexOf("UPDATE public.mutation_commands"),
    };
    expect(order.claim).toBeGreaterThan(-1);
    expect(order.advance).toBeGreaterThan(order.claim);
    expect(source).toMatch(/AND version = \$5/);
  });
});

describe("W3-02 performer provenance (A24)", () => {
  test("accepts a server-derived principal object", async () => {
    mockQuery.mockImplementation(commandAt("created", 1));
    const result = await transitionMutationCommand(base());
    expect(result.version).toBe(2);
    const claimParams = mockQuery.mock.calls.find((c) => String(c[0]).includes("INSERT INTO public.mutation_command_transitions"))?.[1];
    expect(claimParams[5]).toBe(PRINCIPAL);
  });

  test("accepts an explicitly defined system identity string only", async () => {
    mockQuery.mockImplementation(commandAt("created", 1));
    await transitionMutationCommand(base({ performer: "system:phase4-worker" }));
    const claimParams = mockQuery.mock.calls.find((c) => String(c[0]).includes("INSERT INTO public.mutation_command_transitions"))?.[1];
    expect(claimParams[5]).toBe("system:phase4-worker");

    await expect(transitionMutationCommand(base({ performer: "attacker@example.com" })))
      .rejects.toMatchObject({ reason: "performer_invalid" });
    await expect(transitionMutationCommand(base({ performer: { principalId: "not-a-uuid" } })))
      .rejects.toMatchObject({ reason: "performer_invalid" });
    await expect(transitionMutationCommand(base({ performer: { githubLogin: "someone" } })))
      .rejects.toMatchObject({ reason: "performer_invalid" });
    await expect(transitionMutationCommand(base({ performer: null })))
      .rejects.toMatchObject({ reason: "performer_invalid" });
  });
});

describe("W3-02 frozen classification algorithm", () => {
  test("missing command classifies command_not_found before any transaction", async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    await expect(transitionMutationCommand(base())).rejects.toMatchObject({ reason: "command_not_found" });
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  test("claim unique violation with advanced version classifies stale_version with diagnostics", async () => {
    let txEntered = false;
    mockTransaction.mockImplementationOnce(async (fn) => {
      txEntered = true;
      return fn({
        query: async (sql) => {
          const q = String(sql);
          if (q.includes("INSERT INTO public.mutation_command_transitions")) {
            const err = new Error("duplicate key value violates unique constraint \"uq_mutation_transitions_from_version\"");
            err.code = "23505";
            throw err;
          }
          if (q.includes("FROM public.mutation_commands")) {
            // Inside the tx: still at v1; classification re-fetch sees v2.
            return { rows: [{ id: COMMAND_ID, status: "created", version: 1 }] };
          }
          return { rows: [] };
        },
      });
    });
    // Preflight sees the pre-race state; classification fetch sees the
    // winner's post-race state.
    mockQuery.mockImplementationOnce(commandAt("created", 1));
    mockQuery.mockImplementationOnce(commandAt("claimed", 2));

    await expect(transitionMutationCommand(base())).rejects.toMatchObject({
      reason: "stale_version",
      detail: { current_status: "claimed", current_version: 2 },
    });
    expect(txEntered).toBe(true);
  });

  test("claim-guard rejection with matching version classifies illegal_transition", async () => {
    mockTransaction.mockImplementationOnce(async (fn) => fn({
      query: async (sql) => {
        const q = String(sql);
        if (q.includes("INSERT INTO public.mutation_command_transitions")) {
          throw new Error("transition claim edge created -> completed is not legal");
        }
        if (q.includes("FROM public.mutation_commands")) {
          return { rows: [{ id: COMMAND_ID, status: "created", version: 1 }] };
        }
        return { rows: [] };
      },
    }));
    mockQuery.mockImplementationOnce(commandAt("created", 1));
    mockQuery.mockImplementationOnce(commandAt("created", 1));

    await expect(transitionMutationCommand(base({ nextStatus: "completed" })))
      .rejects.toMatchObject({ reason: "illegal_transition" });
  });

  test("advance rowcount zero classifies via the same algorithm", async () => {
    mockTransaction.mockImplementationOnce(async (fn) => fn({
      query: async (sql) => {
        const q = String(sql);
        if (q.includes("INSERT INTO public.mutation_command_transitions")) {
          return { rows: [{ transitioned_at: "2026-10-01T00:00:00Z" }] };
        }
        if (q.includes("UPDATE public.mutation_commands")) {
          return { rows: [], rowCount: 0 };
        }
        if (q.includes("FROM public.mutation_commands")) {
          return { rows: [{ id: COMMAND_ID, status: "claimed", version: 2 }] };
        }
        return { rows: [] };
      },
    }));
    mockQuery.mockImplementationOnce(commandAt("created", 1));
    mockQuery.mockImplementationOnce(commandAt("claimed", 2));

    await expect(transitionMutationCommand(base())).rejects.toMatchObject({
      reason: "stale_version",
      detail: { current_status: "claimed", current_version: 2 },
    });
  });
});

describe("W3-02 input validation", () => {
  test.each([
    ["bad command id", { commandId: "not-a-uuid" }],
    ["zero version", { expectedVersion: 0 }],
    ["missing next status", { nextStatus: "" }],
    ["non-string reason", { reason: 42 }],
  ])("rejects %s", async (_label, overrides) => {
    await expect(transitionMutationCommand(base(overrides))).rejects.toMatchObject({
      name: "MutationTransitionError",
    });
  });
});
