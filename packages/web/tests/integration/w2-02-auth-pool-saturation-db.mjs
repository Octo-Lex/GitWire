// W2-02 authorization pool-saturation proof.
//
// Occupies all 20 runtime DB pool connections with authority-holding
// transactions, then runs both allowed and denied locked authorization phases.
// A regression that persists either decision through the global pool needs a
// 21st connection and times out; the intended path logs through the caller's
// transaction client and all 20 decisions commit successfully in each phase.

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";

const { Client } = pg;
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");

const POOL_SIZE = 20;
const installationId = 983000001;
const repositoryId = 983000002;
const allowedPrincipalId = randomUUID();
const deniedPrincipalId = randomUUID();
const grantorId = randomUUID();
const roleId = randomUUID();
const roleName = `w2-pool-saturation-${randomUUID()}`;

const seed = new Client({ connectionString: databaseUrl });
await seed.connect();

try {
  await seed.query(
    `INSERT INTO installations (github_id, account_login, account_type)
     VALUES ($1, 'w2-pool-saturation', 'Organization')`,
    [installationId],
  );
  await seed.query(
    `INSERT INTO repositories (github_id, installation_id, full_name, owner, name)
     VALUES ($1, $2, 'w2-pool-saturation/repo', 'w2-pool-saturation', 'repo')`,
    [repositoryId, installationId],
  );
  await seed.query(
    `INSERT INTO gitwire_auth.auth_principals (id, principal_type, display_name)
     VALUES
       ($1, 'user', 'w2-pool-saturation-allowed'),
       ($2, 'user', 'w2-pool-saturation-denied'),
       ($3, 'user', 'w2-pool-saturation-grantor')`,
    [allowedPrincipalId, deniedPrincipalId, grantorId],
  );
  await seed.query(
    `INSERT INTO gitwire_auth.auth_roles (id, name, description)
     VALUES ($1, $2, 'Disposable W2-02 pool-saturation proof role')`,
    [roleId, roleName],
  );
  await seed.query(
    `INSERT INTO gitwire_auth.auth_role_permissions (role_id, permission)
     VALUES ($1, 'policy_rollout_plan:approve')`,
    [roleId],
  );
  await seed.query(
    `INSERT INTO gitwire_auth.auth_principal_roles (
       principal_id, role_id, scope_type, scope_id, granted_by
     ) VALUES ($1, $2, 'repository', $3, $4)`,
    [allowedPrincipalId, roleId, repositoryId, grantorId],
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

  const resource = Object.freeze({
    type: "repository",
    installationId,
    repositoryId,
    fullName: "w2-pool-saturation/repo",
  });

  async function runSaturationPhase({
    principalId,
    expectedAllowed,
    expectedBlocked,
    expectedCode,
    label,
  }) {
    let ready = 0;
    let releaseGate;
    const gate = new Promise((resolve) => { releaseGate = resolve; });

    const attempts = Array.from({ length: POOL_SIZE }, () =>
      runtimeDb.transaction(async (tx) => {
        ready += 1;
        if (ready === POOL_SIZE) releaseGate();
        await gate;

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

        assert.equal(outcome.persisted, true, `${label} decision must persist through caller tx`);
        assert.equal(outcome.blocked, expectedBlocked, `${label} blocked state`);
        assert.equal(outcome.decision.allowed, expectedAllowed, `${label} allowed state`);
        assert.equal(outcome.decision.code, expectedCode, `${label} decision code`);
      })
    );

    const timeout = new Promise((_, reject) => {
      setTimeout(
        () => reject(new Error(`${label} locked authorization pool-saturation proof timed out`)),
        12_000,
      ).unref();
    });

    await Promise.race([Promise.all(attempts), timeout]);
    assert.equal(ready, POOL_SIZE, `${label} proof must occupy every runtime pool connection`);
  }

  await runSaturationPhase({
    principalId: allowedPrincipalId,
    expectedAllowed: true,
    expectedBlocked: false,
    expectedCode: "allowed",
    label: "allowed",
  });

  await runSaturationPhase({
    principalId: deniedPrincipalId,
    expectedAllowed: false,
    expectedBlocked: true,
    expectedCode: "permission_missing",
    label: "denied",
  });

  const { rows: [allowedLogged] } = await seed.query(
    `SELECT count(*)::int AS n
       FROM gitwire_auth.auth_decision_log
      WHERE principal_id = $1
        AND permission = 'policy_rollout_plan:approve'
        AND resource_repository_id = $2
        AND allowed = true
        AND observe_mode = false`,
    [allowedPrincipalId, repositoryId],
  );
  assert.equal(
    allowedLogged.n,
    POOL_SIZE,
    "every successful locked authorization must commit its enforced decision evidence",
  );

  const { rows: [deniedLogged] } = await seed.query(
    `SELECT count(*)::int AS n
       FROM gitwire_auth.auth_decision_log
      WHERE principal_id = $1
        AND permission = 'policy_rollout_plan:approve'
        AND resource_repository_id = $2
        AND allowed = false
        AND code = 'permission_missing'
        AND observe_mode = false`,
    [deniedPrincipalId, repositoryId],
  );
  assert.equal(
    deniedLogged.n,
    POOL_SIZE,
    "every denied locked authorization must commit its enforced decision evidence",
  );

  console.log("W2-02 authorization pool saturation (allow + deny): PASS");
} finally {
  await seed.end();
}

process.exit(0);
