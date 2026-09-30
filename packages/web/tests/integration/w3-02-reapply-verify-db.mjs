// W3-02 forward-reapply schema-identity verification (A23, gate group).
//
// After the rollback verification and a normal re-run of the forward
// migration runner, asserts the W3-02 schema/constraint identity is
// restored: columns, both tables, both uniqueness constraints, the version
// step CHECK, all lifecycle triggers (claim guard, journal append-only trio,
// deferred check, command transition guard — and NOT the blanket 048
// no-update), and the legality table with exactly the six frozen edges.
// Sequence runtime values are excluded by contract.

import assert from "node:assert/strict";
import pg from "pg";

const { Client } = pg;

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");

const client = new Client({ connectionString: databaseUrl });
await client.connect();

try {
  const { rows: cols } = await client.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'mutation_commands'
        AND column_name IN ('version', 'last_transition_at', 'last_transitioned_by')
      ORDER BY column_name`,
  );
  assert.deepEqual(cols.map((c) => c.column_name), [
    "last_transition_at", "last_transitioned_by", "version",
  ], "W3-02 columns restored");

  const { rows: constraints } = await client.query(
    `SELECT constraint_name FROM information_schema.table_constraints
      WHERE constraint_schema = 'public'
        AND constraint_name IN ('uq_mutation_transitions_from_version',
                                'uq_mutation_transitions_to_version',
                                'chk_mutation_transitions_version_step')
      ORDER BY constraint_name`,
  );
  assert.deepEqual(constraints.map((c) => c.constraint_name), [
    "chk_mutation_transitions_version_step",
    "uq_mutation_transitions_from_version",
    "uq_mutation_transitions_to_version",
  ], "journal constraints restored");

  // pg_catalog (not information_schema) so statement triggers are counted.
  const { rows: triggers } = await client.query(
    `SELECT c.relname AS table_name, t.tgname AS trigger_name
       FROM pg_trigger t
       JOIN pg_class c ON c.oid = t.tgrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relname IN ('mutation_command_transitions', 'mutation_commands')
        AND NOT t.tgisinternal`,
  );
  const journalTriggers = triggers.filter((t) => t.table_name === "mutation_command_transitions")
    .map((t) => t.trigger_name).sort();
  assert.deepEqual(journalTriggers, [
    "trg_mutation_transitions_no_delete",
    "trg_mutation_transitions_no_truncate",
    "trg_mutation_transitions_no_update",
    "trg_mutation_transitions_validate_claim",
    "trg_mutation_transitions_verify_committed",
  ], "all five journal triggers restored");
  const commandTriggers = triggers.filter((t) => t.table_name === "mutation_commands")
    .map((t) => t.trigger_name).sort();
  assert.ok(commandTriggers.includes("trg_mutation_commands_transition_guard"),
    "the transition guard is restored on mutation_commands");
  assert.ok(!commandTriggers.includes("trg_mutation_commands_no_update"),
    "the 048 blanket no-update trigger is NOT present post-049");

  const { rows: edges } = await client.query(
    `SELECT from_status, to_status FROM public.mutation_transition_legality
      ORDER BY from_status, to_status`,
  );
  assert.deepEqual(edges, [
    { from_status: "claimed", to_status: "cancelled" },
    { from_status: "claimed", to_status: "executing" },
    { from_status: "created", to_status: "cancelled" },
    { from_status: "created", to_status: "claimed" },
    { from_status: "executing", to_status: "completed" },
    { from_status: "executing", to_status: "failed" },
  ], "exactly the six frozen legal edges");

  const { rows: [applied] } = await client.query(
    `SELECT count(*)::int AS n FROM schema_migrations WHERE version = '049_w3_command_lifecycle.sql'`,
  );
  assert.equal(applied.n, 1, "forward runner re-applied 049");

  console.log("W3-02 reapply verification: PASS (schema identity restored)");
} finally {
  await client.end();
}

process.exit(0);
