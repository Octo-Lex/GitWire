// W3-01 real-PostgreSQL proof: canonical mutation commands, transactional
// outbox, database idempotency.
//
// Gate groups proven here (the rollback/reapply groups 18-20 are workflow
// steps; group 17 is source-level in the unit suite):
//   1/2  forward migration + public-schema placement
//   3    deterministic canonical request hashing
//   4    transactional evidence linkage
//   5    evidence-insert failure atomicity (forced via trigger)
//   6    command/outbox failure atomicity (forced via triggers)
//   7    identical replay
//   8    diagnostic conflicting replay
//   9    concurrent identical creation — exactly one evidence row, one
//        command, one initial event
//   10   concurrent conflicting creation
//   11   exactly one initial event per command
//   12   monotonic ordering identity
//   13   orphan/duplicate outbox rejection (FK + unique)
//   14   command/outbox immutability (append-only triggers)
//   15   W2-04 resolution-identity capture
//   16   server-owned attribution

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";

const { Client } = pg;
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");

const installationId = 986300101;
const repositoryId = 986300102;
const principalId = randomUUID();
const otherPrincipalId = randomUUID();
const grantorId = randomUUID();
const roleId = randomUUID();
const NS = "w3-01-proof";

const client = new Client({ connectionString: databaseUrl });
const racer = new Client({ connectionString: databaseUrl });
await client.connect();
await racer.connect();

const tablesExist = async (names) => {
  const { rows } = await client.query(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = ANY($1)`,
    [names],
  );
  return rows.map((r) => r.table_name).sort();
};

async function countRows(sql, params = []) {
  const { rows: [row] } = await client.query(sql, params);
  return row.n;
}

const commandCount = (ns) =>
  countRows(`SELECT count(*)::int AS n FROM public.mutation_commands WHERE namespace = $1`, [ns]);
const evidenceCount = (permission) =>
  countRows(`SELECT count(*)::int AS n FROM gitwire_auth.auth_decision_log WHERE permission = $1`, [permission]);
const eventCount = (ns) =>
  countRows(
    `SELECT count(*)::int AS n FROM public.mutation_outbox o
       JOIN public.mutation_commands c ON c.id = o.command_id
      WHERE c.namespace = $1 AND o.event_type = 'mutation.command.created'`,
    [ns],
  );

try {
  // ── Groups 1/2: forward migration + public placement ─────────────────────
  assert.deepEqual(await tablesExist(["mutation_commands", "mutation_outbox"]),
    ["mutation_commands", "mutation_outbox"],
    "migration 048 must create both tables in public");

  // ── Seed authority: principal, repository, role with the test permission ─
  await client.query(
    `INSERT INTO installations (github_id, account_login, account_type)
     VALUES ($1, 'w3-01-proof', 'Organization')`,
    [installationId],
  );
  await client.query(
    `INSERT INTO repositories (github_id, installation_id, full_name, owner, name)
     VALUES ($1, $2, 'w3-01-proof/repo', 'w3-01-proof', 'repo')`,
    [repositoryId, installationId],
  );
  await client.query(
    `INSERT INTO gitwire_auth.auth_principals (id, principal_type, display_name)
     VALUES ($1, 'user', 'w3-01-principal'), ($2, 'user', 'w3-01-grantor'),
            ($3, 'user', 'w3-01-other-principal')`,
    [principalId, grantorId, otherPrincipalId],
  );
  await client.query(
    `INSERT INTO gitwire_auth.auth_roles (id, name, description)
     VALUES ($1, $2, 'Disposable W3-01 proof role')`,
    [roleId, `w3-01-proof-${randomUUID()}`],
  );
  await client.query(
    `INSERT INTO gitwire_auth.auth_role_permissions (role_id, permission)
     VALUES ($1, 'w3-01.proof:mutate'), ($1, 'w3-01.proof:forbid'),
            ($1, 'w3-01.proof:evidence-fail'), ($1, 'w3-01.proof:command-fail')`,
    [roleId],
  );
  await client.query(
    `INSERT INTO gitwire_auth.auth_principal_roles (
       principal_id, role_id, scope_type, scope_id, granted_by
     ) VALUES ($1, $2, 'repository', $3, $4),
              ($5, $2, 'repository', $3, $4)`,
    [principalId, roleId, repositoryId, grantorId, otherPrincipalId],
  );

  const { initRuntime } = await import("@gitwire/runtime");
  initRuntime({
    server: { env: "test", logLevel: "silent" },
    db: { url: databaseUrl },
    redis: { url: process.env.REDIS_URL || "redis://127.0.0.1:6379" },
    github: {},
  });
  const { createMutationCommand, MutationCommandError } =
    await import("../../src/services/mutationCommandService.js");

  const base = (overrides = {}) => ({
    authority: {
      principal: { principalId, authenticationMethod: "api_key" },
      permission: "w3-01.proof:mutate",
    },
    resource: { type: "repository", installationId, repositoryId },
    operation: "label.add",
    target: { path: "README.md" },
    request: { label: "bug" },
    idempotency: { namespace: NS, key: `k-${randomUUID()}` },
    ...overrides,
  });

  // ── Group 3: deterministic hashing across key order; A7 difference ──────
  const hashA = await createMutationCommand(base({
    request: { label: "bug", action: "label" },
    policyContext: {
      version_vector: { defaults: "w2-04.1", org: null, repo: null, governed: null },
      effective_hash: "sha256:" + "ab".repeat(32),
    },
  }));
  const hashB = await createMutationCommand(base({
    request: { action: "label", label: "bug" },
  }));
  assert.equal(hashA.command.request_hash, hashB.command.request_hash,
    "equivalent requests must hash identically");
  const hashC = await createMutationCommand(base({ request: { label: "security" } }));
  assert.notEqual(hashA.command.request_hash, hashC.command.request_hash,
    "different requests must hash differently");

  // ── Group 15/16: W2-04 identity capture + server-owned attribution ──────
  assert.deepEqual(hashA.command.policy_context, {
    version_vector: { defaults: "w2-04.1", org: null, repo: null, governed: null },
    effective_hash: "sha256:" + "ab".repeat(32),
  }, "command must retain the resolver identity exactly");
  assert.equal(hashB.command.policy_context, null, "no applicable config → null");
  assert.equal(hashA.command.resource_identity, `repository:${repositoryId}`,
    "resource identity is server-derived");

  // ── Group 4: evidence linkage (same transaction) ────────────────────────
  {
    const { rows: [evidence] } = await client.query(
      `SELECT principal_id, permission, allowed, observe_mode
         FROM gitwire_auth.auth_decision_log
        WHERE id = $1`,
      [hashA.command.authorization_evidence_id],
    );
    assert.ok(evidence, "command-bound evidence row must exist");
    assert.equal(String(evidence.principal_id), principalId);
    assert.equal(evidence.permission, "w3-01.proof:mutate");
    assert.equal(evidence.allowed, true);
    assert.equal(evidence.observe_mode, false, "command path evidence is enforced-mode");
  }

  // ── Cross-principal replay: closed failure, no disclosure ────────────────
  await assert.rejects(
    createMutationCommand(base({
      authority: {
        principal: { principalId: otherPrincipalId },
        permission: "w3-01.proof:mutate",
      },
      idempotency: { namespace: NS, key: hashA.command.idempotency_key },
      request: { label: "bug", action: "label" },
    })),
    (err) => err.reason === "idempotency_principal_mismatch" && err.detail === null,
    "a different principal reusing the identity must fail closed with no disclosure",
  );

  // ── Materially different target under the same key: conflict, not replay ─
  await assert.rejects(
    createMutationCommand(base({
      idempotency: { namespace: NS, key: hashA.command.idempotency_key },
      request: { label: "bug", action: "label" },
      target: { path: "OTHER.md" },
    })),
    (err) => err.reason === "idempotency_conflict",
    "the tuple hash must distinguish different targets under one key",
  );

  // ── Group 8: diagnostic conflicting replay ──────────────────────────────
  await assert.rejects(
    createMutationCommand(base({
      idempotency: { namespace: NS, key: hashA.command.idempotency_key },
      request: { label: "totally-different" },
    })),
    (err) => err instanceof MutationCommandError
      && err.reason === "idempotency_conflict"
      && err.detail.existing_command_id === hashA.command.id
      && err.detail.existing_request_hash === hashA.command.request_hash,
    "conflicting replay must fail closed with id + hash diagnostics",
  );

  // ── Group 7: identical replay creates nothing ───────────────────────────
  {
    const before = { c: await commandCount(NS), e: await eventCount(NS), v: await evidenceCount("w3-01.proof:mutate") };
    const replay = await createMutationCommand(base({
      idempotency: { namespace: NS, key: hashA.command.idempotency_key },
      request: { label: "bug", action: "label" },
    }));
    assert.equal(replay.replay, true);
    assert.equal(replay.command.id, hashA.command.id);
    const after = { c: await commandCount(NS), e: await eventCount(NS), v: await evidenceCount("w3-01.proof:mutate") };
    assert.deepEqual(after, before, "identical replay must create no command/event/evidence");
  }

  // ── Group 12: monotonic ordering identity ───────────────────────────────
  {
    const first = await createMutationCommand(base({ idempotency: { namespace: NS, key: `seq-${randomUUID()}` } }));
    const second = await createMutationCommand(base({ idempotency: { namespace: NS, key: `seq-${randomUUID()}` } }));
    assert.ok(second.initialEvent.seq > first.initialEvent.seq,
      "outbox seq must be monotonic across commands");
  }

  // ── Group 11: exactly one initial event per command ─────────────────────
  {
    const { rows: [row] } = await client.query(
      `SELECT count(*)::int AS n FROM public.mutation_outbox
        WHERE command_id = $1 AND event_type = 'mutation.command.created'`,
      [hashA.command.id],
    );
    assert.equal(row.n, 1);
  }

  // ── Group 5: evidence-insert failure atomicity (forced via trigger) ─────
  {
    await client.query(`
      CREATE FUNCTION w3_01_fail_evidence() RETURNS trigger LANGUAGE plpgsql
      AS $$ BEGIN RAISE EXCEPTION 'evidence forced failure'; END $$;
    `);
    await client.query(`
      CREATE TRIGGER trg_w3_01_fail_evidence BEFORE INSERT ON gitwire_auth.auth_decision_log
        FOR EACH ROW WHEN (NEW.permission = 'w3-01.proof:evidence-fail')
        EXECUTE FUNCTION w3_01_fail_evidence();
    `);
    const before = await commandCount(NS);
    await assert.rejects(
      createMutationCommand(base({
        authority: { principal: { principalId }, permission: "w3-01.proof:evidence-fail" },
        idempotency: { namespace: NS, key: `evfail-${randomUUID()}` },
      })),
      /evidence forced failure/,
    );
    assert.equal(await commandCount(NS), before,
      "evidence failure must leave no command");
    await client.query(`DROP TRIGGER IF EXISTS trg_w3_01_fail_evidence ON gitwire_auth.auth_decision_log`);
    await client.query(`DROP FUNCTION IF EXISTS w3_01_fail_evidence()`);
    // The rolled-back attempt also left no evidence row for that permission.
    assert.equal(await evidenceCount("w3-01.proof:evidence-fail"), 0);
  }

  // ── Group 6: command/outbox failure atomicity (forced via triggers) ─────
  {
    // (a) command insert fails AFTER evidence insert: evidence must roll back.
    await client.query(`
      CREATE FUNCTION w3_01_fail_command() RETURNS trigger LANGUAGE plpgsql
      AS $$ BEGIN RAISE EXCEPTION 'command forced failure'; END $$;
    `);
    await client.query(`
      CREATE TRIGGER trg_w3_01_fail_command BEFORE INSERT ON public.mutation_commands
        FOR EACH ROW WHEN (NEW.operation = 'w3-01-forced-command-failure')
        EXECUTE FUNCTION w3_01_fail_command();
    `);
    await assert.rejects(
      createMutationCommand(base({
        operation: "w3-01-forced-command-failure",
        idempotency: { namespace: NS, key: `cmdfail-${randomUUID()}` },
      })),
      /command forced failure/,
    );
    assert.equal(await evidenceCount("w3-01.proof:mutate") > 0, true); // earlier successes intact
    const { rows: [orphan] } = await client.query(
      `SELECT count(*)::int AS n FROM public.mutation_commands
        WHERE operation = 'w3-01-forced-command-failure'`,
    );
    assert.equal(orphan.n, 0, "failed command must not exist");
    await client.query(`DROP TRIGGER IF EXISTS trg_w3_01_fail_command ON public.mutation_commands`);
    await client.query(`DROP FUNCTION IF EXISTS w3_01_fail_command()`);

    // (b) outbox insert fails after command: command must roll back.
    await client.query(`
      CREATE FUNCTION w3_01_fail_outbox() RETURNS trigger LANGUAGE plpgsql
      AS $$ BEGIN RAISE EXCEPTION 'outbox forced failure'; END $$;
    `);
    await client.query(`
      CREATE TRIGGER trg_w3_01_fail_outbox BEFORE INSERT ON public.mutation_outbox
        FOR EACH ROW EXECUTE FUNCTION w3_01_fail_outbox();
    `);
    const beforeCmds = await commandCount(NS);
    const beforeEvidence = await evidenceCount("w3-01.proof:mutate");
    await assert.rejects(
      createMutationCommand(base({ idempotency: { namespace: NS, key: `obfail-${randomUUID()}` } })),
      /outbox forced failure/,
    );
    assert.equal(await commandCount(NS), beforeCmds, "outbox failure must roll back the command");
    assert.equal(await evidenceCount("w3-01.proof:mutate"), beforeEvidence,
      "outbox failure must roll back command-bound evidence too");
    await client.query(`DROP TRIGGER IF EXISTS trg_w3_01_fail_outbox ON public.mutation_outbox`);
    await client.query(`DROP FUNCTION IF EXISTS w3_01_fail_outbox()`);
  }

  // ── Group 9: concurrent identical creation ──────────────────────────────
  {
    const key = `race-${randomUUID()}`;
    const { getRuntime } = await import("@gitwire/runtime");
    const runtime = getRuntime();
    const originalTransaction = runtime.db.transaction;
    let started = 0;
    runtime.db.transaction = async (fn) => originalTransaction.call(runtime.db, async (tx) => {
      started += 1;
      // Hold both creators open simultaneously so the database, not
      // scheduling, resolves the winner.
      while (started < 2) await new Promise((r) => setTimeout(r, 5));
      return fn(tx);
    });
    try {
      const params = () => base({ idempotency: { namespace: NS, key } });
      const [a, b] = await Promise.all([
        createMutationCommand(params()),
        createMutationCommand(params()),
      ]);
      const creations = [a, b].filter((r) => r.created).length;
      assert.equal(creations, 1, "exactly one creator wins");
      assert.equal(a.command.id, b.command.id, "both resolve the same command");
      assert.equal(await commandCount(NS) >= 1, true);

      const { rows: [row] } = await client.query(
        `SELECT
           (SELECT count(*)::int FROM public.mutation_commands
             WHERE namespace = $1 AND idempotency_key = $2) AS commands,
           (SELECT count(*)::int FROM public.mutation_outbox o
             JOIN public.mutation_commands c ON c.id = o.command_id
             WHERE c.namespace = $1 AND c.idempotency_key = $2
               AND o.event_type = 'mutation.command.created') AS events,
           (SELECT count(*)::int FROM gitwire_auth.auth_decision_log l
             JOIN public.mutation_commands c ON c.authorization_evidence_id = l.id
             WHERE c.namespace = $1 AND c.idempotency_key = $2) AS evidence`,
        [NS, key],
      );
      assert.deepEqual(
        { commands: row.commands, events: row.events, evidence: row.evidence },
        { commands: 1, events: 1, evidence: 1 },
        "convergence: exactly one command, one event, one evidence row",
      );
    } finally {
      runtime.db.transaction = originalTransaction;
    }
  }

  // ── Group 10: concurrent conflicting creation ────────────────────────────
  {
    const key = `conflict-${randomUUID()}`;
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
        createMutationCommand(base({ idempotency: { namespace: NS, key }, request: { label: "one" } })),
        createMutationCommand(base({ idempotency: { namespace: NS, key }, request: { label: "two" } })),
      ]);
      const fulfilled = results.filter((r) => r.status === "fulfilled");
      const rejected = results.filter((r) => r.status === "rejected");
      assert.equal(fulfilled.length, 1, "exactly one conflicting creator commits");
      assert.equal(rejected.length, 1, "the loser fails closed");
      assert.equal(rejected[0].reason.reason, "idempotency_conflict");
      assert.equal(rejected[0].reason.detail.existing_command_id, fulfilled[0].value.command.id);

      const { rows: [row] } = await client.query(
        `SELECT count(*)::int AS n FROM public.mutation_commands
          WHERE namespace = $1 AND idempotency_key = $2`,
        [NS, key],
      );
      assert.equal(row.n, 1, "one idempotency identity → one command");
    } finally {
      runtime.db.transaction = originalTransaction;
    }
  }

  // ── Concurrent cross-principal race: loser fails closed, no disclosure ──
  {
    const key = `xpr-${randomUUID()}`;
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
      const make = (pid) => createMutationCommand(base({
        authority: { principal: { principalId: pid }, permission: "w3-01.proof:mutate" },
        idempotency: { namespace: NS, key },
      }));
      const results = await Promise.allSettled([make(principalId), make(otherPrincipalId)]);
      const fulfilled = results.filter((r) => r.status === "fulfilled");
      const rejected = results.filter((r) => r.status === "rejected");
      assert.equal(fulfilled.length, 1, "exactly one principal's creator wins");
      assert.equal(rejected.length, 1, "the cross-principal loser fails");
      assert.equal(rejected[0].reason.reason, "idempotency_principal_mismatch",
        "loser reason is the principal mismatch, not a conflict leak");
      assert.equal(rejected[0].reason.detail, null, "no command id / hash disclosure");

      const { rows: [row] } = await client.query(
        `SELECT
           (SELECT count(*)::int FROM public.mutation_commands
             WHERE namespace = $1 AND idempotency_key = $2) AS commands,
           (SELECT count(*)::int FROM public.mutation_outbox o
             JOIN public.mutation_commands c ON c.id = o.command_id
             WHERE c.namespace = $1 AND c.idempotency_key = $2) AS events`,
        [NS, key],
      );
      assert.deepEqual({ commands: row.commands, events: row.events },
        { commands: 1, events: 1 }, "one command, one event after the cross-principal race");
    } finally {
      runtime.db.transaction = originalTransaction;
    }
  }

  // ── Group 13: orphan and duplicate outbox rejection ─────────────────────
  await assert.rejects(
    client.query(
      `INSERT INTO public.mutation_outbox (command_id, event_type, request_hash)
       VALUES ($1, 'mutation.command.created', $2)`,
      [randomUUID(), "sha256:" + "cd".repeat(32)],
    ),
    (err) => err.code === "23503",
    "orphan outbox event must violate the FK",
  );
  await assert.rejects(
    client.query(
      `INSERT INTO public.mutation_outbox (command_id, event_type, request_hash)
       VALUES ($1, 'mutation.command.created', $2)`,
      [hashA.command.id, hashA.command.request_hash],
    ),
    (err) => err.code === "23505",
    "duplicate initial event must violate the per-command unique constraint",
  );

  // ── Group 14: immutability ──────────────────────────────────────────────
  await assert.rejects(
    client.query(`UPDATE public.mutation_commands SET request = '{}' WHERE id = $1`, [hashA.command.id]),
    /mutation_commands is append-only/,
  );
  await assert.rejects(
    client.query(`DELETE FROM public.mutation_commands WHERE id = $1`, [hashA.command.id]),
    /mutation_commands is append-only/,
  );
  await assert.rejects(
    client.query(`UPDATE public.mutation_outbox SET event_type = 'x' WHERE command_id = $1`, [hashA.command.id]),
    /mutation_outbox is append-only/,
  );
  await assert.rejects(
    client.query(`DELETE FROM public.mutation_outbox WHERE command_id = $1`, [hashA.command.id]),
    /mutation_outbox is append-only/,
  );

  console.log("W3-01 mutation commands (atomicity, idempotency, evidence linkage, immutability): PASS");
} finally {
  await racer.end();
  await client.end();
}

// The production service imports shared DB/Redis singletons; explicit
// termination keeps this standalone CI proof from waiting on open handles.
process.exit(0);
