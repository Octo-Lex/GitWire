// W3-01 forward-reapply schema-identity verification (gate group 20).
//
// After the rollback verification and a normal re-run of the forward
// migration runner, asserts the W3-01 schema/constraint identity is
// restored: both tables, both uniqueness constraints, and all six
// append-only triggers. Sequence runtime values are excluded by contract.

import assert from "node:assert/strict";
import pg from "pg";

const { Client } = pg;
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

  // pg_catalog, not information_schema: the standard view does not report
  // TRUNCATE statement triggers, and here all six must be verified.
  const { rows: triggers } = await client.query(
    `SELECT c.relname AS table_name, t.tgname AS trigger_name
       FROM pg_trigger t
       JOIN pg_class c ON c.oid = t.tgrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relname IN ('mutation_commands', 'mutation_outbox')
        AND NOT t.tgisinternal`,
  );
  assert.equal(triggers.length, 6, "all six append-only triggers must be restored: " + JSON.stringify(triggers));

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
