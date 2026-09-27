// W2-02 locked authorization expiry proof against real PostgreSQL.
//
// PostgreSQL NOW() is transaction-start time. A promotion transaction may wait
// on the repository mutex before it evaluates role assignments, so locked
// authorization must use wall-clock time for assignment expiry. This proof
// starts a transaction before an assignment expires, waits until after the
// expiry instant, then requires the locked enforced decision to deny.

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";

const { Client } = pg;
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");

const installationId = 984000001;
const repositoryId = 984000002;
const principalId = randomUUID();
const grantorId = randomUUID();
const roleId = randomUUID();
const roleName = `w2-expiry-wall-clock-${randomUUID()}`;

const seed = new Client({ connectionString: databaseUrl });
await seed.connect();

try {
  await seed.query(
    `INSERT INTO installations (github_id, account_login, account_type)
     VALUES ($1, 'w2-expiry-wall-clock', 'Organization')`,
    [installationId],
  );
  await seed.query(
    `INSERT INTO repositories (github_id, installation_id, full_name, owner, name)
     VALUES ($1, $2, 'w2-expiry-wall-clock/repo', 'w2-expiry-wall-clock', 'repo')`,
    [repositoryId, installationId],
  );
  await seed.query(
    `INSERT INTO gitwire_auth.auth_principals (id, principal_type, display_name)
     VALUES
       ($1, 'user', 'w2-expiry-wall-clock-principal'),
       ($2, 'user', 'w2-expiry-wall-clock-grantor')`,
    [principalId, grantorId],
  );
  await seed.query(
    `INSERT INTO gitwire_auth.auth_roles (id, name, description)
     VALUES ($1, $2, 'Disposable W2-02 wall-clock expiry proof role')`,
    [roleId, roleName],
  );
  await seed.query(
    `INSERT INTO gitwire_auth.auth_role_permissions (role_id, permission)
     VALUES ($1, 'policy_rollout_plan:approve')`,
    [roleId],
  );

  const { initRuntime } = await import("@gitwire/runtime");
  initRuntime({
    server: { env: "test", logLevel: "silent" },
    db: { url: databaseUrl },
    redis: { url: process.env.REDIS_URL || "redis://127.0.0.1:6379" },
    github: {},
  });

  const { db: runtimeDb } = await import("../../src/lib/db.js");
  const { authorizeControlled } = await import("../../src/services/auth/authorize.js");

  const { rows: [assignment] } = await seed.query(
    `INSERT INTO gitwire_auth.auth_principal_roles (
       principal_id, role_id, scope_type, scope_id, granted_by, expires_at
     ) VALUES ($1, $2, 'repository', $3, $4, clock_timestamp() + interval '1500 milliseconds')
     RETURNING id, expires_at`,
    [principalId, roleId, repositoryId, grantorId],
  );

  const resource = Object.freeze({
    type: "repository",
    installationId,
    repositoryId,
    fullName: "w2-expiry-wall-clock/repo",
  });

  await runtimeDb.transaction(async (tx) => {
    // Establish the PostgreSQL transaction timestamp while the assignment is
    // still valid. The historical NOW()-based implementation would keep using
    // this earlier instant for the rest of the transaction and incorrectly allow.
    const { rows: [started] } = await tx.query(
      `SELECT now() AS transaction_time, clock_timestamp() AS wall_time`,
    );
    assert.ok(
      new Date(started.transaction_time).getTime() < new Date(assignment.expires_at).getTime(),
      "transaction must begin before assignment expiry",
    );

    const waitMs = Math.max(
      0,
      new Date(assignment.expires_at).getTime() - Date.now() + 300,
    );
    await new Promise((resolve) => setTimeout(resolve, waitMs));

    const { rows: [afterWait] } = await tx.query(
      `SELECT now() AS transaction_time, clock_timestamp() AS wall_time`,
    );
    assert.equal(
      new Date(afterWait.transaction_time).getTime(),
      new Date(started.transaction_time).getTime(),
      "NOW() must demonstrate transaction-start semantics for the regression setup",
    );
    assert.ok(
      new Date(afterWait.wall_time).getTime() > new Date(assignment.expires_at).getTime(),
      "wall clock must be past assignment expiry before authorization",
    );

    const outcome = await authorizeControlled({
      principal: {
        principalId,
        authenticationMethod: "api_key",
      },
      permission: "policy_rollout_plan:approve",
      resource,
      mode: "enforced",
      queryable: tx,
      lockAuthorityRows: true,
    });

    assert.equal(outcome.persisted, true, "expired denial evidence must persist through caller tx");
    assert.equal(outcome.blocked, true, "expired assignment must block enforced authorization");
    assert.equal(outcome.decision.allowed, false, "expired assignment must not authorize");
    assert.equal(outcome.decision.code, "permission_missing", "expired assignment must not count as active permission");
  });

  const { rows: [logged] } = await seed.query(
    `SELECT count(*)::int AS n
       FROM gitwire_auth.auth_decision_log
      WHERE principal_id = $1
        AND permission = 'policy_rollout_plan:approve'
        AND resource_repository_id = $2
        AND allowed = false
        AND code = 'permission_missing'
        AND observe_mode = false`,
    [principalId, repositoryId],
  );
  assert.equal(logged.n, 1, "wall-clock expiry denial must commit durable enforced evidence");

  console.log("W2-02 locked authorization wall-clock expiry: PASS");
} finally {
  await seed.end();
}

process.exit(0);
