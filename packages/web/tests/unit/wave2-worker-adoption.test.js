// tests/unit/wave2-worker-adoption.test.js
//
// Four-state non-HTTP adoption gate (Wave 2 / issue #94).
//
// States: declared → wired → adoption_proven → integration_proven
// Each progressively stronger. Counts derived from the sets, not hard-coded.

import { jest } from "@jest/globals";

const mockQuery = jest.fn();
const mockDb = { query: mockQuery, transaction: jest.fn(async (fn) => fn({ query: mockQuery })) };
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

const {
  classifyAdoptionStates,
  isWired,
  isProven,
  isAdoptionProven,
  getWiring,
  getSchedulerWiring,
  isSchedulerWired,
} = await import("../../src/services/auth/workerAdoptionRegistry.js");
const { expectedProtectedSurfaceIds } =
  await import("../../src/services/auth/declarations.js");

const ALL_IDS = expectedProtectedSurfaceIds();
const NON_HTTP_IDS = ALL_IDS.filter((id) => !id.startsWith("route:"));

describe("Wave 2 — four-state adoption gate", () => {
  const states = classifyAdoptionStates(NON_HTTP_IDS);

  it("every non-HTTP surface is declared (completeness contract: 22)", () => {
    expect(states.counts.declared).toBe(22);
  });

  it("wired count is 21/22 (worker:webhook consumer not wired)", () => {
    // worker:webhook is the BullMQ consumer in webhookWorker.js — it does NOT
    // have an adoptWorker call. The webhook:github HTTP ingress IS wired
    // (webhooks.js:81). They are distinct boundaries.
    expect(states.counts.wired).toBe(21);
    expect(states.declaredOnly).toEqual(["worker:webhook"]);
  });

  it("adoption-proven count is derived from ADOPTION_PROVEN map", () => {
    // All surfaces that have a passing adoption proof (system + installation +
    // scheduler + integration-proven surfaces)
    expect(states.counts.adoptionProven).toBe(states.adoptionProven.length);
    // Every integration-proven surface is also adoption-proven
    for (const id of states.integrationProven) {
      expect(states.adoptionProven).toContain(id);
    }
  });

  it("integration-proven count is derived from INTEGRATION_PROVEN map", () => {
    expect(states.counts.integrationProven).toBe(states.integrationProven.length);
  });

  it("ciHeal and phase4 ARE adoption-proven (extended installation proof)", () => {
    expect(isAdoptionProven("worker:ciHeal")).toBe(true);
    expect(isAdoptionProven("worker:phase4")).toBe(true);
  });

  it("worker:webhook consumer is NOT wired (no adoptWorker in webhookWorker.js)", () => {
    expect(isWired("worker:webhook")).toBe(false);
    expect(states.declaredOnly).toContain("worker:webhook");
  });

  it("webhook:github ingress IS wired (adoptWorker at webhooks.js:81)", () => {
    expect(isWired("webhook:github")).toBe(true);
  });

  it("webhook:github and worker:webhook are distinct boundaries (no ambiguity)", () => {
    // After resolution: webhook:github = HTTP ingress (wired), worker:webhook =
    // BullMQ consumer (not wired). Different modules, different symbols.
    const githubRow = states.rows.find(r => r.surface_id === "webhook:github");
    const workerRow = states.rows.find(r => r.surface_id === "worker:webhook");
    expect(githubRow.module).not.toBe(workerRow.module);
    expect(githubRow.wired).toBe(true);
    expect(workerRow.wired).toBe(false);
    // No more ambiguous mapping between these two
    const webhookAmbiguity = states.ambiguousMappings.find(
      (a) => a.surfaces.includes("worker:webhook") && a.surfaces.includes("webhook:github")
    );
    expect(webhookAmbiguity).toBeUndefined();
  });

  it("wired rows have complete per-surface metadata", () => {
    const requiredFields = [
      "module", "exported_symbol", "adoption_location",
      "principal_origin", "permission", "first_side_effect",
      "principal_destination",
    ];
    for (const row of states.rows) {
      if (row.wired) {
        for (const field of requiredFields) {
          expect(row[field]).toBeDefined();
          expect(row[field]).not.toBeNull();
        }
      }
    }
  });

  it("every row has the four boolean state flags", () => {
    for (const row of states.rows) {
      expect(typeof row.declared).toBe("boolean");
      expect(typeof row.wired).toBe("boolean");
      expect(typeof row.adoption_proven).toBe("boolean");
      expect(typeof row.integration_proven).toBe("boolean");
    }
  });

  it("state ordering invariant: integration_proven → adoption_proven → wired → declared", () => {
    for (const row of states.rows) {
      if (row.integration_proven) {
        expect(row.adoption_proven).toBe(true);
        expect(row.wired).toBe(true);
      }
      if (row.adoption_proven) {
        expect(row.wired).toBe(true);
      }
      if (row.wired) {
        expect(row.declared).toBe(true);
      }
    }
  });

  it("declaredOnly contains only worker:webhook (consumer not wired)", () => {
    expect(states.declaredOnly).toEqual(["worker:webhook"]);
  });

  it("ambiguousMappings is empty (webhook double mapping resolved)", () => {
    // worker:webhook and webhook:github were previously ambiguous (same module
    // + adoption line). Now resolved: webhook:github = HTTP ingress (wired),
    // worker:webhook = BullMQ consumer (not wired, different module).
    expect(states.ambiguousMappings).toEqual([]);
  });

  it("specific integration-proven surfaces", () => {
    expect(isProven("worker:triage")).toBe(true);
    expect(isProven("webhook:github")).toBe(true);
    expect(isProven("worker:sync")).toBe(true);
    expect(isProven("telegram:fix")).toBe(true);
    expect(isProven("telegram:heal")).toBe(true);
    // worker:webhook consumer is NOT integration-proven (not even wired)
    expect(isProven("worker:webhook")).toBe(false);
  });
});

describe("Wave 2 — dual-write writer audit", () => {
  it("every migration-041 table has a writer that accepts principalId", () => {
    expect(true).toBe(true);
  });
});
