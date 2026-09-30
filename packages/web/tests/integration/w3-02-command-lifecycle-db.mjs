// W3-02 real-PostgreSQL proof: claim-then-advance lifecycle primitives.
//
// Gate groups proven here (the historical-upgrade group runs as a separate
// workflow stage against a two-stage-migrated database):
//   A2    legal transition commits once; version increments; audit fields
//         agree with the journal claim
//   A3    concurrent same-version claims: one winner, loser stale_version
//   A4    stale attempts never overwrite
//   A5    replay rejected by claim uniqueness; journal unchanged
//   A6    illegal edges rejected at claim guard and command guard
//   A7    claim+advance commit/rollback together
//   A8    intent mutation through the transition path rejected
//   A10   terminal states admit no outgoing transitions
//   A17   performer matches between journal and command row
//   A19   journal append-only
//   A21   direct lifecycle UPDATE without a claim rejected
//   A22   claim without advance cannot commit (deferred check)
//   gate8 both uniqueness constraints reject independently (guard disabled
//         inside a rolled-back transaction — CI proof only)
//
// A9/A13 (W3-01 proofs incl. outbox append-only) run in the same workflow
// after this migration; A11/A12/A16/A24 are unit source-contract proofs.

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";

const { Client } = pg;
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");

const installationId = 986400101;
const repositoryId = 986400102;
const principalId = randomUUID();
const grantorId = randomUUID();
const roleId = randomUUID();
const NS = "w3-02-proof";

const client = new Client({ connectionString: databaseUrl });
const racer = new Client({ connectionString: databaseUrl });
await client.connect();
await racer.connect();

try {
  await client.query(
    `INSERT INTO installations (github_id, account_login, account_type)
     VALUES ($1, 'w3-02-proof', 'Organization')`,
    [installationId],
  );
  await client.query(
    `INSERT INTO repositories (github_id, installation_id, full_name, owner, name)
     VALUES ($1, $2, 'w3-02-proof/repo', 'w3-02-proof', 'repo')`,
    [repositoryId, installationId],
  );
  await client.query(
    `INSERT INTO gitwire_auth.auth_principals (id, principal_type, display_name)
     VALUES ($1, 'user', 'w3-02-principal'), ($2, 'user', 'w3-02-grantor')`,
    [principalId, grantorId],
  );
  await client.query(
    `INSERT INTO gitwire_auth.auth_roles (id, name, description)
     VALUES ($1, $2, 'Disposable W3-02 proof role')`,
    [roleId, `w3-02-proof-${randomUUID()}`],
  );
  await client.query(
    `INSERT INTO gitwire_auth.auth_role_permissions (role_id, permission)
     VALUES ($1, 'w3-02.proof:mutate')`,
    [roleId],
  );
  await client.query(
    `INSERT INTO gitwire_auth.auth_principal_roles (
       principal_id, role_id, scope_type, scope_id, granted_by
     ) VALUES ($1, $2, 'repository', $3, $4)`,
    [principalId, roleId, repositoryId, grantorId],
  );

  const { initRuntime } = await import("@gitwire/runtime");
  initRuntime({
    server: { env: "test", logLevel: "silent" },
    db: { url: databaseUrl },
    redis: { url: process.env.REDIS_URL || "redis://127.0.0.1:6379" },
    github: {},
  });
  const { createMutationCommand } = await import("../../src/services/mutationCommandService.js");
  const { transitionMutationCommand, MutationTransitionError } =
    await import("../../src/services/mutationLifecycleService.js");

  async function newCommand(suffix) {
    const created = await createMutationCommand({
      authority: {
        principal: { principalId, authenticationMethod: "api_key" },
        permission: "w3-02.proof:mutate",
      },
      resource: { type: "repository", installationId, repositoryId },
      operation: "label.add",
      target: { path: "README.md" },
      request: { label: "bug", suffix },
      idempotency: { namespace: NS, key: `c-${suffix}` },
    });
    assert.equal(created.created, true);
    assert.equal(Number(created.command.version), 1, "new command initializes at version 1");
    return created.command;
  }

  const transition = (cmd, next, version, performer = { principalId }) =>
    transitionMutationCommand({
      commandId: cmd.id,
      expectedVersion: version,
      nextStatus: next,
      performer,
      reason: `to-${next}`,
    });

  // ── A2/A17: legal transition; audit fields agree with the claim ─────────
  {
    const cmd = await newCommand("legal");
    const result = await transition(cmd, "claimed", 1);
    assert.deepEqual(
      { status: result.status, version: result.version },
      { status: "claimed", version: 2 },
    );

    const { rows: [row] } = await client.query(
      `SELECT c.status, c.version, c.last_transitioned_by, c.last_transition_at,
              t.transitioned_by AS journal_by, t.transitioned_at AS journal_at,
              t.from_status, t.to_status, t.from_version, t.to_version
         FROM public.mutation_commands c
         JOIN public.mutation_command_transitions t ON t.command_id = c.id
        WHERE c.id = $1`,
      [cmd.id],
    );
    assert.equal(row.status, "claimed");
    assert.equal(Number(row.version), 2);
    assert.equal(String(row.last_transitioned_by), String(row.journal_by));
    assert.equal(new Date(row.last_transition_at).getTime(), new Date(row.journal_at).getTime());
    assert.deepEqual(
      [row.from_status, row.to_status, Number(row.from_version), Number(row.to_version)],
      ["created", "claimed", 1, 2],
    );
  }

  // ── A5/A4: replay rejected; command byte-identical; journal unchanged ────
  {
    const cmd = await newCommand("replay");
    await transition(cmd, "claimed", 1);
    const before = await client.query(
      `SELECT (to_jsonb(c) - 'last_transition_at' - 'last_transitioned_by') AS intent,
              c.status, c.version FROM public.mutation_commands c WHERE c.id = $1`,
      [cmd.id],
    );
    await assert.rejects(
      transition(cmd, "claimed", 1),
      (err) => err instanceof MutationTransitionError
        && err.reason === "stale_version"
        && err.detail.current_version === 2
        && err.detail.current_status === "claimed",
    );
    const after = await client.query(
      `SELECT (to_jsonb(c) - 'last_transition_at' - 'last_transitioned_by') AS intent,
              c.status, c.version FROM public.mutation_commands c WHERE c.id = $1`,
      [cmd.id],
    );
    assert.deepEqual(after.rows[0], before.rows[0], "replay leaves the command untouched");
    const { rows: [count] } = await client.query(
      `SELECT count(*)::int AS n FROM public.mutation_command_transitions WHERE command_id = $1`,
      [cmd.id],
    );
    assert.equal(count.n, 1, "replay adds no journal row");
  }

  // ── A6: illegal edge rejected with matching version → illegal_transition ──
  await assert.rejects(
    (async () => {
      const cmd = await newCommand("illegal");
      return transition(cmd, "completed", 1);
    })(),
    (err) => err instanceof MutationTransitionError && err.reason === "illegal_transition",
  );

  // ── A10: terminal states admit no outgoing transitions ───────────────────
  {
    const cmd = await newCommand("terminal");
    await transition(cmd, "claimed", 1);
    await transition(cmd, "executing", 2);
    await transition(cmd, "completed", 3);
    await assert.rejects(
      transition(cmd, "failed", 4),
      (err) => err instanceof MutationTransitionError && err.reason === "illegal_transition",
    );
  }

  // ── A21: direct lifecycle UPDATE without a claim rejected at the guard ───
  {
    const cmd = await newCommand("rawsql");
    await assert.rejects(
      client.query(
        `UPDATE public.mutation_commands
            SET status = 'claimed', version = version + 1,
                last_transition_at = clock_timestamp(), last_transitioned_by = $2
          WHERE id = $1`,
        [cmd.id, String(principalId)],
      ),
      /no matching journal claim/,
    );
    const { rows: [row] } = await client.query(
      `SELECT status, version FROM public.mutation_commands WHERE id = $1`,
      [cmd.id],
    );
    assert.deepEqual(
      { status: row.status, version: Number(row.version) },
      { status: "created", version: 1 },
    );
  }

  // ── A8: intent mutation through the transition path rejected ─────────────
  {
    const cmd = await newCommand("intent");
    // A claim exists (valid), but the direct update also rewrites the request.
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO public.mutation_command_transitions
         (command_id, from_status, to_status, from_version, to_version, transitioned_by)
       VALUES ($1, 'created', 'claimed', 1, 2, $2)`,
      [cmd.id, String(principalId)],
    );
    await assert.rejects(
      client.query(
        `UPDATE public.mutation_commands
            SET status = 'claimed', version = 2,
                request = '{"tampered":true}'::jsonb,
                last_transition_at = clock_timestamp(), last_transitioned_by = $2
          WHERE id = $1`,
        [cmd.id, String(principalId)],
      ),
      /intent is immutable/,
    );
    await client.query("ROLLBACK");
  }

  // ── gate-proof 6: performer disagreement between claim and row rejected ───
  {
    const cmd = await newCommand("perf-disagree");
    await client.query("BEGIN");
    const { rows: [claim] } = await client.query(
      `INSERT INTO public.mutation_command_transitions
         (command_id, from_status, to_status, from_version, to_version, transitioned_by)
       VALUES ($1, 'created', 'claimed', 1, 2, $2)
       RETURNING transitioned_at`,
      [cmd.id, String(principalId)],
    );
    await assert.rejects(
      client.query(
        `UPDATE public.mutation_commands
            SET status = 'claimed', version = 2,
                last_transition_at = $2, last_transitioned_by = 'system:imposter'
          WHERE id = $1`,
        [cmd.id, claim.transitioned_at],
      ),
      /no matching journal claim/,
      "a different last_transitioned_by than the claim must be rejected",
    );
    await client.query("ROLLBACK");
  }

  // ── A22 (proofs 5/7): claim without advance cannot commit ────────────────
  {
    const cmd = await newCommand("orphan");
    await assert.rejects(
      client.query(
        `INSERT INTO public.mutation_command_transitions
           (command_id, from_status, to_status, from_version, to_version, transitioned_by)
         VALUES ($1, 'created', 'claimed', 1, 2, $2)`,
        [cmd.id, String(principalId)],
      ),
      /orphaned transition claim/,
      "a committed claim without its advance must be rejected by the deferred check",
    );
    const { rows: [count] } = await client.query(
      `SELECT count(*)::int AS n FROM public.mutation_command_transitions WHERE command_id = $1`,
      [cmd.id],
    );
    assert.equal(count.n, 0, "orphaned claim rolled back with its transaction");
  }

  // ── gate-proof 4: malformed/stale claim rejected at the claim guard ──────
  {
    const cmd = await newCommand("badclaim");
    await assert.rejects(
      client.query(
        `INSERT INTO public.mutation_command_transitions
           (command_id, from_status, to_status, from_version, to_version, transitioned_by)
         VALUES ($1, 'created', 'claimed', 7, 8, $2)`,
        [cmd.id, String(principalId)],
      ),
      /transition claim version mismatch/,
    );
    await assert.rejects(
      client.query(
        `INSERT INTO public.mutation_command_transitions
           (command_id, from_status, to_status, from_version, to_version, transitioned_by)
         VALUES ($1, 'executing', 'completed', 1, 2, $2)`,
        [cmd.id, String(principalId)],
      ),
      /transition claim status mismatch/,
    );
  }

  // ── A19: journal is append-only ───────────────────────────────────────────
  {
    const cmd = await newCommand("journal-immutable");
    await transition(cmd, "claimed", 1);
    const { rows: [row] } = await client.query(
      `SELECT seq FROM public.mutation_command_transitions WHERE command_id = $1`,
      [cmd.id],
    );
    await assert.rejects(
      client.query(`UPDATE public.mutation_command_transitions SET reason = 'rewritten' WHERE seq = $1`, [row.seq]),
      /mutation_command_transitions is append-only/,
    );
    await assert.rejects(
      client.query(`DELETE FROM public.mutation_command_transitions WHERE seq = $1`, [row.seq]),
      /mutation_command_transitions is append-only/,
    );
  }

  // ── gate-proof 8: both uniqueness constraints reject independently ────────
  // A BEFORE trigger runs before constraint checking, so proving each
  // uniqueness constraint independently requires the claim guard disabled —
  // CI-only, in a fresh transaction (ALTER TABLE is blocked while deferred
  // trigger events are pending) that rolls back, restoring the guard.
  {
    const cmd = await newCommand("dupclaims");
    // Commit one valid transition so both duplicate shapes target real rows.
    await transition(cmd, "claimed", 1);

    await client.query("BEGIN");
    await client.query(`ALTER TABLE public.mutation_command_transitions DISABLE TRIGGER trg_mutation_transitions_validate_claim`);

    // A failed statement aborts the transaction, so each duplicate insert
    // runs inside its own savepoint.
    async function expectUniqueViolation(sql, params, constraint) {
      await client.query("SAVEPOINT sp");
      let caught = null;
      try {
        await client.query(sql, params);
      } catch (err) {
        caught = err;
      }
      assert.ok(caught, `expected a violation of ${constraint}`);
      assert.equal(caught.code, "23505", constraint);
      assert.equal(caught.constraint, constraint);
      await client.query("ROLLBACK TO SAVEPOINT sp");
      await client.query("RELEASE SAVEPOINT sp");
    }

    await expectUniqueViolation(
      `INSERT INTO public.mutation_command_transitions
         (command_id, from_status, to_status, from_version, to_version, transitioned_by)
       VALUES ($1, 'created', 'claimed', 1, 2, $2)`,
      [cmd.id, String(principalId)],
      "uq_mutation_transitions_from_version",
    );
    await expectUniqueViolation(
      `INSERT INTO public.mutation_command_transitions
         (command_id, from_status, to_status, from_version, to_version, transitioned_by)
       VALUES ($1, 'claimed', 'executing', 0, 2, $2)`,
      [cmd.id, String(principalId)],
      "uq_mutation_transitions_to_version",
    );

    await client.query("ROLLBACK");
    const { rows: [guardCheck] } = await client.query(
      `SELECT count(*)::int AS n FROM public.mutation_command_transitions
        WHERE command_id = $1`,
      [cmd.id],
    );
    assert.equal(guardCheck.n, 1, "rollback leaves only the committed transition");
  }

  // ── A3 (proofs 1/2): concurrent same-version claims ───────────────────────
  {
    const cmd = await newCommand("race");
    const { getRuntime } = await import("@gitwire/runtime");
    const runtime = getRuntime();
    const originalTransaction = runtime.db.transaction;
    let started = 0;
    runtime.db.transaction = async (fn) => originalTransaction.call(runtime.db, async (tx) => {
      started += 1;
      while (started < 2) await new Promise((r) => setTimeout(r, 5));
      return fn(tx);
    });
    try {
      const results = await Promise.allSettled([
        transition(cmd, "claimed", 1),
        transition(cmd, "claimed", 1, "system:race-racer"),
      ]);
      const fulfilled = results.filter((r) => r.status === "fulfilled");
      const rejected = results.filter((r) => r.status === "rejected");
      assert.equal(fulfilled.length, 1, "exactly one claim wins");
      assert.equal(rejected.length, 1, "the loser fails closed");
      assert.equal(rejected[0].reason.reason, "stale_version");
      assert.equal(rejected[0].reason.detail.current_version, 2);

      const { rows: [row] } = await client.query(
        `SELECT
           (SELECT count(*)::int FROM public.mutation_command_transitions WHERE command_id = $1) AS journal_rows,
           (SELECT version FROM public.mutation_commands WHERE id = $1) AS version`,
        [cmd.id],
      );
      assert.deepEqual(
        { journal_rows: row.journal_rows, version: Number(row.version) },
        { journal_rows: 1, version: 2 },
        "convergence: one journal row, one version increment",
      );
    } finally {
      runtime.db.transaction = originalTransaction;
    }
  }

  console.log("W3-02 command lifecycle (claim-then-advance CAS, guards, journal coupling): PASS");
} finally {
  await racer.end();
  await client.end();
}

process.exit(0);
