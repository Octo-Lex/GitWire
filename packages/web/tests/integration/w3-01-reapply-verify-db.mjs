// W3-01 forward-reapply schema-identity verification (gate group 20).
//
// After the rollback verification and a normal re-run of the forward
// migration runner, asserts the W3-01 schema/constraint identity is
// restored: both tables, both uniqueness constraints, and all six
// append-only triggers. Sequence runtime values are excluded by contract.

import assert from "node:assert/strict";
import pg from "pg";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");

const client = new Client({ connectionString: databaseUrl });
await client.connect();

try {
  const { rows: tables } = await client.query(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name IN ('mutation_commands', 'mutation_outbox')
      ORDER BY table_name`,
  );
  assert.deepEqual(
    tables.map((r) => r.table_name),
    ["mutation_commands", "mutation_outbox"],
    "both W3-01 tables must be restored",
  );

  const { rows: constraints } = await client.query(
    `SELECT constraint_name FROM information_schema.table_constraints
      WHERE constraint_schema = 'public'
        AND constraint_name IN ('uq_mutation_commands_idempotency',
                                'uq_mutation_outbox_event_per_command')
      ORDER BY constraint_name`,
  );
  assert.deepEqual(
    constraints.map((r) => r.constraint_name),
    ["uq_mutation_commands_idempotency", "uq_mutation_outbox_event_per_command"],
    "both uniqueness constraints must be restored",
  );

  const { rows: triggers } = await client.query(
    `SELECT trigger_name FROM information_schema.triggers
      WHERE trigger_schema = 'public'
        AND trigger_name LIKE 'trg_mutation_%'`,
  );
  assert.equal(triggers.length, 6, "all six append-only triggers must be restored");

  const { rows: [applied] } = await client.query(
    `SELECT count(*)::int AS n FROM schema_migrations
      WHERE version = '048_w3_mutation_commands.sql'`,
  );
  assert.equal(applied.n, 1, "forward runner must have re-applied 048");

  console.log("W3-01 reapply verification: PASS (schema identity restored)");
} finally {
  await client.end();
}

process.exit(0);
