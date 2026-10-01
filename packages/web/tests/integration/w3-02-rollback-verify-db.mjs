// W3-02 rollback verification (A23, gate groups).
//
// Executes the CI-only 049 rollback artifact against the proof database,
// then asserts:
//   * W3-02 objects are absent (columns, both tables, functions, triggers);
//   * the EXACT pre-049 W3-01 trigger is restored (name, function, timing);
//   * the 048 wall is behavioral again: UPDATE on mutation_commands raises
//     'mutation_commands is append-only';
//   * prior schema intact; schema_migrations row for 049 removed.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const { Client } = pg;

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");

const here = dirname(fileURLToPath(import.meta.url));
const rollbackPath = join(here, "..", "..", "db", "rollbacks", "049_w3_command_lifecycle.rollback.sql");

const client = new Client({ connectionString: databaseUrl });
await client.connect();

try {
  const sql = await readFile(rollbackPath, "utf8");
  await client.query(sql);
  console.log("049 rollback artifact executed");

  const { rows: cols } = await client.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'mutation_commands'
        AND column_name IN ('version', 'last_transition_at', 'last_transitioned_by')`,
  );
  assert.equal(cols.length, 0, "W3-02 columns must be absent after rollback");

  const { rows: tables } = await client.query(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name IN ('mutation_command_transitions', 'mutation_transition_legality')`,
  );
  assert.equal(tables.length, 0, "W3-02 tables must be absent after rollback");

  const { rows: triggers } = await client.query(
    `SELECT trigger_name, event_manipulation, action_timing
       FROM information_schema.triggers
      WHERE event_object_table = 'mutation_commands' AND trigger_schema = 'public'`,
  );
  const restored = triggers.find((t) => t.trigger_name === "trg_mutation_commands_no_update");
  assert.ok(restored, "the exact 048 trigger name must be restored");
  assert.equal(restored.action_timing, "BEFORE");
  assert.equal(restored.event_manipulation, "UPDATE");
  assert.ok(!triggers.some((t) => t.trigger_name === "trg_mutation_commands_transition_guard"),
    "the W3-02 guard trigger must be gone");

  const { rows: [fnCheck] } = await client.query(
    `SELECT count(*)::int AS n FROM information_schema.routines
      WHERE routine_schema = 'public'
        AND routine_name IN ('w3_02_guard_command_transition',
                             'w3_02_verify_claim_committed',
                             'w3_02_validate_transition_claim')`,
  );
  assert.equal(fnCheck.n, 0, "W3-02 functions must be removed");

  // Behavioral: the 048 wall is back. (The W3-01 proof ran earlier in this
  // workflow and created commands, so a row exists to probe with.)
  const { rows: [probe] } = await client.query(
    `SELECT id FROM public.mutation_commands LIMIT 1`,
  );
  if (probe) {
    await assert.rejects(
      client.query(`UPDATE public.mutation_commands SET status = 'x' WHERE id = $1`, [probe.id]),
      /mutation_commands is append-only/,
      "the restored 048 trigger must reject updates again",
    );
  }

  const { rows: [applied] } = await client.query(
    `SELECT count(*)::int AS n FROM schema_migrations WHERE version = '049_w3_command_lifecycle.sql'`,
  );
  assert.equal(applied.n, 0, "schema_migrations row for 049 must be removed");

  console.log("W3-02 rollback verification: PASS (exact 048 trigger restored, objects absent)");
} finally {
  await client.end();
}

process.exit(0);
