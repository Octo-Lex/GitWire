// W3-02 historical-upgrade verification (gate group for A20).
//
// Runs against the two-stage-migrated HIST database (workflow applied 001-048,
// seeded commands, then applied 049). Asserts:
//   * every seeded command initialized deterministically at version 1;
//   * status remains 'created';
//   * the journal is empty (no synthetic creation entries);
//   * the first lifecycle transition consumes expected_version = 1 and works.

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";

const { Client } = pg;

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");

const client = new Client({ connectionString: databaseUrl });
await client.connect();

try {
  const { rows: seeded } = await client.query(
    `SELECT id, status, version FROM public.mutation_commands ORDER BY created_at`,
  );
  assert.equal(seeded.length, 2, "the workflow seeded exactly two historical commands");
  for (const row of seeded) {
    assert.equal(row.status, "created", "historical command keeps status created");
    assert.equal(Number(row.version), 1, "historical command initializes at version 1");
  }

  const { rows: [journal] } = await client.query(
    `SELECT count(*)::int AS n FROM public.mutation_command_transitions`,
  );
  assert.equal(journal.n, 0, "no synthetic journal entries for historical creation");

  // The first lifecycle transition consumes expected_version = 1.
  const { initRuntime } = await import("@gitwire/runtime");
  initRuntime({
    server: { env: "test", logLevel: "silent" },
    db: { url: databaseUrl },
    redis: { url: process.env.REDIS_URL || "redis://127.0.0.1:6379" },
    github: {},
  });
  const { transitionMutationCommand, MutationTransitionError } =
    await import("../../src/services/mutationLifecycleService.js");

  const result = await transitionMutationCommand({
    commandId: seeded[0].id,
    expectedVersion: 1,
    nextStatus: "cancelled",
    performer: "system:historical-proof",
    reason: "first transition from historical init",
  });
  assert.deepEqual(
    { status: result.status, version: result.version },
    { status: "cancelled", version: 2 },
  );
  // Terminal now: replaying version 1 classifies stale_version.
  await assert.rejects(
    transitionMutationCommand({
      commandId: seeded[0].id,
      expectedVersion: 1,
      nextStatus: "cancelled",
      performer: "system:historical-proof",
    }),
    (err) => err instanceof MutationTransitionError && err.reason === "stale_version",
  );

  console.log("W3-02 historical upgrade verification: PASS (version 1 / created / empty journal)");
} finally {
  await client.end();
}

process.exit(0);
