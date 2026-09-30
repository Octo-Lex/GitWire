// W3-01 rollback verification (gate groups 18–19).
//
// Executes the explicit CI-only rollback artifact against the proof
// database, then asserts:
//   * W3-01 objects are absent (tables; tracking row removed);
//   * pre-W3-01 schema is intact (representative Wave-1/2 tables present).
//
// Sequence runtime values are excluded from identity by contract; this
// script checks object existence only.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");

const here = dirname(fileURLToPath(import.meta.url));
const rollbackPath = join(here, "..", "..", "db", "rollbacks", "048_w3_mutation_commands.rollback.sql");

const client = new Client({ connectionString: databaseUrl });
await client.connect();

try {
  const sql = await readFile(rollbackPath, "utf8");
  await client.query(sql);
  console.log("rollback artifact executed");

  const { rows: w3Tables } = await client.query(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name IN ('mutation_commands', 'mutation_outbox')`,
  );
  assert.equal(w3Tables.length, 0, "W3-01 tables must be absent after rollback");

  const { rows: prior } = await client.query(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name IN ('repositories', 'repo_config',
                           'policy_promotion_records', 'active_policy_bindings')`,
  );
  assert.equal(prior.length, 4, "pre-W3-01 schema must remain intact");

  const { rows: [applied] } = await client.query(
    `SELECT count(*)::int AS n FROM schema_migrations
      WHERE version = '048_w3_mutation_commands.sql'`,
  );
  assert.equal(applied.n, 0, "schema_migrations row must be removed by rollback");

  console.log("W3-01 rollback verification: PASS (objects absent, prior schema intact)");
} finally {
  await client.end();
}

process.exit(0);
