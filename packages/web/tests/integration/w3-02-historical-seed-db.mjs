// W3-02 historical-upgrade seeder (workflow-only helper).
//
// Runs against the two-stage HIST database while it still sits at the 048
// schema (049 moved out by the workflow). Seeds exactly two pre-lifecycle
// commands through the raw 048 surfaces — principal + evidence rows first,
// then the command rows — so the subsequent 049 apply has historical rows to
// initialize. NOT a proof: the assertions live in
// w3-02-historical-verify-db.mjs.

import { randomUUID } from "node:crypto";
import pg from "pg";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");

const client = new pg.Client({ connectionString: databaseUrl });
await client.connect();

try {
  const principalId = randomUUID();
  await client.query(
    `INSERT INTO gitwire_auth.auth_principals (id, principal_type, display_name)
     VALUES ($1, 'user', 'w3-02-hist-seeder')`,
    [principalId],
  );

  for (let i = 0; i < 2; i += 1) {
    const { rows: [evidence] } = await client.query(
      `INSERT INTO gitwire_auth.auth_decision_log
         (principal_id, permission, resource_type, allowed, code)
       VALUES ($1, 'w3-02.hist-seed', 'repository', true, 'seed')
       RETURNING id`,
      [principalId],
    );
    await client.query(
      `INSERT INTO public.mutation_commands (
         namespace, idempotency_key, operation, resource_type, resource_identity,
         target, request, request_hash, principal_id, authorization_evidence_id
       ) VALUES ('w3-02-hist', $1, 'label.add', 'repository', 'repository:1',
                 '{}'::jsonb, '{}'::jsonb, 'sha256:' || repeat('a', 64), $2, $3)`,
      [`seed-${i}`, principalId, evidence.id],
    );
  }
  console.log("seeded 2 historical commands on the 048 schema");
} finally {
  await client.end();
}

process.exit(0);
