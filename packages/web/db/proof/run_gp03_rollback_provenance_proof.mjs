#!/usr/bin/env node
// Focused mutation-sensitive proof for GP-03 migration/rollback provenance.
// Covers review 4839574087 / clarification 4839638764:
//   1. Dynamic fail-closed collision on gp03_function_provenance.
//   2. Explicit PUBLIC (OID 0) ACL provenance.
//   3. Same-name overload isolation by exact function identity.
//   4. Rollback atomicity under a statement-oriented, single-connection runner.

import { execFileSync } from "node:child_process";
import { createServer } from "node:net";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const MIGRATIONS_DIR = join(REPO_ROOT, "packages", "web", "db", "migrations");
const ROLLBACK_PATH = join(__dirname, "rollback_gp03_approval.sql");
const MIGRATION_046 = "046_gp03_approval_functions.sql";

const TARGET_REGPROCEDURES = [
  "gitwire_policy.approve_policy_change_request(uuid,bigint,uuid)",
  "gitwire_policy.create_policy_approval_rule(text,text,text,text,text,integer,jsonb,uuid,integer)",
  "gitwire_policy.evaluate_approval_sufficiency(uuid)",
  "gitwire_policy.expire_policy_approval(uuid,bigint,uuid)",
  "gitwire_policy.record_policy_approval(uuid,uuid,uuid)",
  "gitwire_policy.revoke_policy_approval(uuid,bigint,uuid,text)",
].sort();

let passed = 0;
let failed = 0;
let cleanupFailed = false;

function check(name, ok, detail = "") {
  if (ok) passed += 1;
  else failed += 1;
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${name}${detail ? " — " + detail : ""}`);
}

function docker(...args) {
  return execFileSync("docker", args, {
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

function pickPort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function waitForReady(url, timeoutMs = 60_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const client = new pg.Client({ connectionString: url });
    try {
      await client.connect();
      await client.end();
      return;
    } catch {
      try { await client.end(); } catch {}
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }
  throw new Error("postgres did not become ready");
}

async function withDatabase(label, fn) {
  const port = await pickPort();
  const name = `gp03-prov-${label}-${port}`;
  const cid = docker(
    "run", "-d", "--rm", "--name", name,
    "-p", `127.0.0.1:${port}:5432`,
    "-e", "POSTGRES_USER=proof",
    "-e", "POSTGRES_PASSWORD=proof-only",
    "-e", "POSTGRES_DB=proofdb",
    "postgres:16-alpine",
  );
  const url = `postgresql://proof:proof-only@127.0.0.1:${port}/proofdb`;
  let pool;
  try {
    await waitForReady(url);
    pool = new pg.Pool({ connectionString: url });
    await fn({ pool, cid, name, url });
  } finally {
    if (pool) {
      try { await pool.end(); } catch {}
    }
    try { docker("rm", "-f", cid); }
    catch (error) {
      cleanupFailed = true;
      console.error(`cleanup failed for ${name}: ${error.message}`);
    }
  }
}

async function applyMigrations(pool, { stopBefore = null } = {}) {
  const client = await pool.connect();
  try {
    await client.query(
      "CREATE TABLE IF NOT EXISTS public.schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
    );
    const { rows } = await client.query("SELECT version FROM public.schema_migrations");
    const applied = new Set(rows.map(row => row.version));
    const files = (await readdir(MIGRATIONS_DIR))
      .filter(file => file.endsWith(".sql"))
      .sort();
    for (const file of files) {
      if (stopBefore && file === stopBefore) break;
      if (applied.has(file)) continue;
      const sql = await readFile(join(MIGRATIONS_DIR, file), "utf8");
      try {
        await client.query("BEGIN");
        await client.query(sql);
        await client.query(
          "INSERT INTO public.schema_migrations(version) VALUES ($1)",
          [file],
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw new Error(`${file}: ${error.message}`);
      }
    }
  } finally {
    client.release();
  }
}

function stripLeadingComments(statement) {
  return statement
    .replace(/^\s*(?:(?:--[^\n]*(?:\n|$))|(?:\/\*[\s\S]*?\*\/))\s*/g, "")
    .trim();
}

function splitSqlStatements(sql) {
  const statements = [];
  let start = 0;
  let i = 0;
  let single = false;
  let double = false;
  let lineComment = false;
  let blockCommentDepth = 0;
  let dollarTag = null;

  while (i < sql.length) {
    const ch = sql[i];
    const next = sql[i + 1];

    if (lineComment) {
      if (ch === "\n") lineComment = false;
      i += 1;
      continue;
    }
    if (blockCommentDepth > 0) {
      if (ch === "/" && next === "*") {
        blockCommentDepth += 1;
        i += 2;
        continue;
      }
      if (ch === "*" && next === "/") {
        blockCommentDepth -= 1;
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }
    if (dollarTag !== null) {
      if (sql.startsWith(dollarTag, i)) {
        i += dollarTag.length;
        dollarTag = null;
      } else {
        i += 1;
      }
      continue;
    }
    if (single) {
      if (ch === "'" && next === "'") {
        i += 2;
        continue;
      }
      if (ch === "'") single = false;
      i += 1;
      continue;
    }
    if (double) {
      if (ch === '"' && next === '"') {
        i += 2;
        continue;
      }
      if (ch === '"') double = false;
      i += 1;
      continue;
    }

    if (ch === "-" && next === "-") {
      lineComment = true;
      i += 2;
      continue;
    }
    if (ch === "/" && next === "*") {
      blockCommentDepth = 1;
      i += 2;
      continue;
    }
    if (ch === "'") {
      single = true;
      i += 1;
      continue;
    }
    if (ch === '"') {
      double = true;
      i += 1;
      continue;
    }
    if (ch === "$") {
      const match = sql.slice(i).match(/^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/);
      if (match) {
        dollarTag = match[0];
        i += dollarTag.length;
        continue;
      }
    }
    if (ch === ";") {
      const statement = sql.slice(start, i + 1).trim();
      if (statement) statements.push(statement);
      start = i + 1;
    }
    i += 1;
  }

  const tail = sql.slice(start).trim();
  if (tail) statements.push(tail);
  return statements;
}

async function snapshotCollisionState(pool) {
  const { rows } = await pool.query(`
    WITH relations AS (
      SELECT c.oid, n.nspname, c.relname, c.relkind,
             pg_get_userbyid(c.relowner) AS owner_name,
             COALESCE(c.relacl::text, 'NULL') AS relacl
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname IN ('gitwire_policy','gitwire_auth','public')
        AND c.relkind IN ('r','p','S','v','m')
    ), items AS (
      SELECT 'REL|' || nspname || '|' || relname || '|' || relkind || '|' || owner_name || '|' || relacl AS item
      FROM relations
      UNION ALL
      SELECT 'COL|' || n.nspname || '|' || c.relname || '|' || a.attnum || '|' || a.attname || '|'
             || pg_catalog.format_type(a.atttypid, a.atttypmod) || '|' || a.attnotnull || '|'
             || COALESCE(pg_get_expr(d.adbin, d.adrelid), 'NULL') || '|' || COALESCE(a.attacl::text, 'NULL')
      FROM pg_attribute a
      JOIN pg_class c ON c.oid = a.attrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
      WHERE c.oid IN (SELECT oid FROM relations)
        AND a.attnum > 0 AND NOT a.attisdropped
      UNION ALL
      SELECT 'CON|' || n.nspname || '|' || c.relname || '|' || con.conname || '|'
             || con.contype || '|' || pg_get_constraintdef(con.oid, true)
      FROM pg_constraint con
      JOIN pg_class c ON c.oid = con.conrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.oid IN (SELECT oid FROM relations)
      UNION ALL
      SELECT 'SCHEMA|' || n.nspname || '|' || pg_get_userbyid(n.nspowner) || '|'
             || COALESCE(n.nspacl::text, 'NULL')
      FROM pg_namespace n
      WHERE n.nspname IN ('gitwire_policy','gitwire_auth','public')
      UNION ALL
      SELECT 'FN|' || n.nspname || '|' || p.oid::regprocedure::text || '|'
             || encode(public.digest(p.prosrc, 'sha256'), 'hex') || '|'
             || pg_get_userbyid(p.proowner) || '|' || p.prosecdef || '|'
             || COALESCE(array_to_string(p.proconfig, ','), '') || '|'
             || COALESCE(p.proacl::text, 'NULL')
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname IN ('gitwire_policy','gitwire_auth','public')
      UNION ALL
      SELECT 'LEDGER|' || version || '|' || applied_at::text
      FROM public.schema_migrations
      UNION ALL
      SELECT 'FOREIGN_PROVENANCE|' || marker || '|' || payload::text
      FROM gitwire_policy.gp03_function_provenance
    )
    SELECT item FROM items ORDER BY item
  `);
  return rows.map(row => row.item).join("\n");
}

const ACL_SQL = `
  SELECT COALESCE(string_agg(
    COALESCE(grantee_role.rolname, CASE WHEN acl.grantee = 0 THEN 'PUBLIC' ELSE '#' || acl.grantee::text END)
      || '=' || acl.privilege_type || '/'
      || COALESCE(grantor_role.rolname, '#' || acl.grantor::text)
      || '(' || CASE WHEN acl.is_grantable THEN 't' ELSE 'f' END || ')',
    ',' ORDER BY
      COALESCE(grantee_role.rolname, CASE WHEN acl.grantee = 0 THEN 'PUBLIC' ELSE '#' || acl.grantee::text END),
      acl.privilege_type,
      COALESCE(grantor_role.rolname, '#' || acl.grantor::text),
      acl.is_grantable
  ), 'NULL') AS acl
  FROM pg_proc function_row
  CROSS JOIN LATERAL aclexplode(COALESCE(function_row.proacl, '{}'::aclitem[])) AS acl
  LEFT JOIN pg_roles grantee_role ON grantee_role.oid = acl.grantee
  LEFT JOIN pg_roles grantor_role ON grantor_role.oid = acl.grantor
  WHERE function_row.oid = $1::regprocedure
`;

async function functionAcl(pool, regprocedure) {
  return (await pool.query(ACL_SQL, [regprocedure])).rows[0].acl;
}

async function snapshotState(pool) {
  const { rows } = await pool.query(`
    WITH relevant_relations AS (
      SELECT c.oid, n.nspname, c.relname, c.relkind,
             pg_get_userbyid(c.relowner) AS owner_name,
             COALESCE(c.relacl::text, 'NULL') AS relacl
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE (n.nspname = 'gitwire_policy' AND c.relname IN (
               'policy_approval_rules','policy_approvals','policy_approval_lifecycle',
               'policy_validation_evidence','policy_simulation_evidence',
               'policy_transition_events','gp03_function_provenance'))
         OR (n.nspname = 'gitwire_auth' AND c.relname IN (
               'auth_principals','auth_roles','auth_principal_roles'))
         OR (n.nspname = 'public' AND c.relname IN (
               'repositories','installations','schema_migrations'))
    ), items AS (
      SELECT 'REL|' || nspname || '|' || relname || '|' || relkind || '|' || owner_name || '|' || relacl AS item
      FROM relevant_relations
      UNION ALL
      SELECT 'COL|' || n.nspname || '|' || c.relname || '|' || a.attnum || '|' || a.attname || '|'
             || pg_catalog.format_type(a.atttypid, a.atttypmod) || '|' || a.attnotnull || '|'
             || COALESCE(pg_get_expr(d.adbin, d.adrelid), 'NULL') || '|' || COALESCE(a.attacl::text, 'NULL')
      FROM pg_attribute a
      JOIN pg_class c ON c.oid = a.attrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
      WHERE c.oid IN (SELECT oid FROM relevant_relations)
        AND a.attnum > 0 AND NOT a.attisdropped
      UNION ALL
      SELECT 'CON|' || n.nspname || '|' || c.relname || '|' || con.conname || '|'
             || con.contype || '|' || pg_get_constraintdef(con.oid, true)
      FROM pg_constraint con
      JOIN pg_class c ON c.oid = con.conrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.oid IN (SELECT oid FROM relevant_relations)
      UNION ALL
      SELECT 'SCHEMA|' || n.nspname || '|' || pg_get_userbyid(n.nspowner) || '|'
             || COALESCE(n.nspacl::text, 'NULL')
      FROM pg_namespace n
      WHERE n.nspname IN ('gitwire_policy','gitwire_auth','public')
      UNION ALL
      SELECT 'FN|' || p.oid::regprocedure::text || '|'
             || encode(public.digest(p.prosrc, 'sha256'), 'hex') || '|'
             || pg_get_function_result(p.oid) || '|' || l.lanname || '|'
             || pg_get_userbyid(p.proowner) || '|' || p.prosecdef || '|'
             || COALESCE(array_to_string(p.proconfig, ','), '') || '|'
             || COALESCE((
                  SELECT string_agg(
                    COALESCE(grantee_role.rolname, CASE WHEN acl.grantee = 0 THEN 'PUBLIC' ELSE '#' || acl.grantee::text END)
                      || '=' || acl.privilege_type || '/'
                      || COALESCE(grantor_role.rolname, '#' || acl.grantor::text)
                      || '(' || CASE WHEN acl.is_grantable THEN 't' ELSE 'f' END || ')',
                    ',' ORDER BY
                      COALESCE(grantee_role.rolname, CASE WHEN acl.grantee = 0 THEN 'PUBLIC' ELSE '#' || acl.grantee::text END),
                      acl.privilege_type,
                      COALESCE(grantor_role.rolname, '#' || acl.grantor::text),
                      acl.is_grantable)
                  FROM aclexplode(COALESCE(p.proacl, '{}'::aclitem[])) acl
                  LEFT JOIN pg_roles grantee_role ON grantee_role.oid = acl.grantee
                  LEFT JOIN pg_roles grantor_role ON grantor_role.oid = acl.grantor
                ), 'NULL')
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      JOIN pg_language l ON l.oid = p.prolang
      WHERE n.nspname = 'gitwire_policy'
        AND p.proname IN (
          'approve_policy_change_request','create_policy_approval_rule',
          'evaluate_approval_sufficiency','expire_policy_approval',
          'record_policy_approval','revoke_policy_approval')
      UNION ALL
      SELECT 'PROV|' || row_to_json(provenance_row)::text
      FROM (
        SELECT * FROM gitwire_policy.gp03_function_provenance
        ORDER BY proname, identity_args
      ) provenance_row
      UNION ALL
      SELECT 'LEDGER|' || version || '|' || applied_at::text
      FROM public.schema_migrations
    )
    SELECT item FROM items ORDER BY item
  `);
  return rows.map(row => row.item).join("\n");
}

const migration046Sql = await readFile(join(MIGRATIONS_DIR, MIGRATION_046), "utf8");
const rollbackSql = await readFile(ROLLBACK_PATH, "utf8");

console.log("=== GP-03 rollback provenance focused proof ===");

check(
  "static fail-closed: migration does not use CREATE TABLE IF NOT EXISTS for provenance",
  !/CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+gp03_function_provenance/i.test(migration046Sql),
);
check(
  "static transaction: rollback begins with BEGIN",
  /^\s*(?:--[^\n]*\n\s*)*BEGIN\s*;/i.test(rollbackSql),
);
check(
  "static transaction: rollback ends with COMMIT",
  /COMMIT\s*;\s*$/i.test(rollbackSql),
);

await withDatabase("collision", async ({ pool }) => {
  console.log("\n--- dynamic provenance-table collision ---");
  await applyMigrations(pool, { stopBefore: MIGRATION_046 });
  await pool.query(`
    CREATE TABLE gitwire_policy.gp03_function_provenance (
      marker text PRIMARY KEY,
      payload jsonb NOT NULL
    );
    INSERT INTO gitwire_policy.gp03_function_provenance(marker, payload)
    VALUES ('foreign', '{"owner":"preexisting"}'::jsonb);
  `);
  const before = await snapshotCollisionState(pool);

  let rejected = false;
  try { await applyMigrations(pool); }
  catch (error) { rejected = /gp03_function_provenance|already exists/i.test(error.message); }
  check("foreign provenance table causes atomic migration rejection", rejected);

  const after = await snapshotCollisionState(pool);
  check("collision preserves exact fixture-inclusive baseline", before === after);
  const ledger046 = (await pool.query(
    "SELECT count(*)::int AS n FROM public.schema_migrations WHERE version=$1",
    [MIGRATION_046],
  )).rows[0].n;
  check("collision does not record migration 046", ledger046 === 0, `ledger=${ledger046}`);
});

await withDatabase("public-acl", async ({ pool }) => {
  console.log("\n--- explicit PUBLIC ACL provenance ---");
  await applyMigrations(pool);
  const target = "gitwire_policy.evaluate_approval_sufficiency(uuid)";
  await pool.query(`GRANT EXECUTE ON FUNCTION ${target} TO PUBLIC`);
  const beforeAcl = await functionAcl(pool, target);
  check("explicit PUBLIC ACL is visible canonically", beforeAcl.includes("PUBLIC=EXECUTE/"), beforeAcl);

  let rejected = false;
  try { await pool.query(rollbackSql); }
  catch (error) {
    rejected = /provenance mismatch/i.test(error.message);
    try { await pool.query("ROLLBACK"); } catch {}
  }
  check("rollback rejects explicit PUBLIC ACL drift", rejected);
  const afterAcl = await functionAcl(pool, target);
  check("rollback rejection preserves exact OID-0 ACL entry", beforeAcl === afterAcl, afterAcl);
  const targetExists = (await pool.query("SELECT to_regprocedure($1) IS NOT NULL AS present", [target])).rows[0].present;
  check("rollback rejection preserves target function", targetExists);
  const ledger046 = (await pool.query(
    "SELECT count(*)::int AS n FROM public.schema_migrations WHERE version=$1",
    [MIGRATION_046],
  )).rows[0].n;
  check("rollback rejection preserves migration ledger", ledger046 === 1, `ledger=${ledger046}`);
});

await withDatabase("overload", async ({ pool }) => {
  console.log("\n--- same-name overload isolation ---");
  await applyMigrations(pool);
  await pool.query(`
    CREATE FUNCTION gitwire_policy.record_policy_approval(text)
    RETURNS text LANGUAGE sql AS $$ SELECT $1 $$;
    COMMENT ON FUNCTION gitwire_policy.record_policy_approval(text)
      IS 'foreign overload must survive GP-03 rollback';
  `);
  const overload = "gitwire_policy.record_policy_approval(text)";
  const before = (await pool.query(`
    SELECT p.oid::regprocedure::text AS signature,
           pg_get_userbyid(p.proowner) AS owner_name,
           pg_get_functiondef(p.oid) AS definition,
           obj_description(p.oid, 'pg_proc') AS comment_text,
           COALESCE(p.proacl::text, 'NULL') AS acl
    FROM pg_proc p
    WHERE p.oid = $1::regprocedure
  `, [overload])).rows[0];

  const provenanceRows = (await pool.query(`
    SELECT proname, identity_args
    FROM gitwire_policy.gp03_function_provenance
    ORDER BY proname, identity_args
  `)).rows;
  check("provenance contains exactly six composite signatures", provenanceRows.length === 6, `count=${provenanceRows.length}`);
  const targetRows = (await pool.query(`
    SELECT p.oid::regprocedure::text AS signature
    FROM pg_proc p
    WHERE p.oid::regprocedure::text = ANY($1::text[])
    ORDER BY 1
  `, [TARGET_REGPROCEDURES])).rows.map(row => row.signature).sort();
  check("all six exact target signatures resolve", JSON.stringify(targetRows) === JSON.stringify(TARGET_REGPROCEDURES));
  const overloadIdentity = (await pool.query(
    "SELECT pg_get_function_identity_arguments($1::regprocedure) AS args",
    [overload],
  )).rows[0].args;
  check("foreign overload is not recorded as provenance",
    !provenanceRows.some(row => row.proname === "record_policy_approval" && row.identity_args === overloadIdentity),
    `identity_args=${overloadIdentity}`);

  await pool.query(rollbackSql);

  const remainingTargets = (await pool.query(`
    SELECT count(*)::int AS n
    FROM unnest($1::text[]) AS signatures(signature)
    WHERE to_regprocedure(signature) IS NOT NULL
  `, [TARGET_REGPROCEDURES])).rows[0].n;
  check("rollback removes only the six exact GP-03 signatures", remainingTargets === 0, `remaining=${remainingTargets}`);
  const after = (await pool.query(`
    SELECT p.oid::regprocedure::text AS signature,
           pg_get_userbyid(p.proowner) AS owner_name,
           pg_get_functiondef(p.oid) AS definition,
           obj_description(p.oid, 'pg_proc') AS comment_text,
           COALESCE(p.proacl::text, 'NULL') AS acl
    FROM pg_proc p
    WHERE p.oid = $1::regprocedure
  `, [overload])).rows[0];
  check("foreign same-name overload survives exactly", JSON.stringify(before) === JSON.stringify(after));
  const ledger046 = (await pool.query(
    "SELECT count(*)::int AS n FROM public.schema_migrations WHERE version=$1",
    [MIGRATION_046],
  )).rows[0].n;
  check("successful rollback removes migration ledger entry", ledger046 === 0, `ledger=${ledger046}`);
});

await withDatabase("transaction", async ({ pool }) => {
  console.log("\n--- statement-oriented rollback atomicity ---");
  await applyMigrations(pool);
  const before = await snapshotState(pool);
  const statements = splitSqlStatements(rollbackSql);
  check("statement splitter retains BEGIN and COMMIT",
    /^BEGIN\s*;/i.test(stripLeadingComments(statements[0]))
      && /^COMMIT\s*;/i.test(stripLeadingComments(statements.at(-1))));

  const client = await pool.connect();
  let injectedAfterMutation = false;
  let observedFailure = false;
  try {
    for (const statement of statements) {
      await client.query(statement);
      if (!injectedAfterMutation && /^REVOKE\s+EXECUTE\s+ON\s+FUNCTION/i.test(stripLeadingComments(statement))) {
        injectedAfterMutation = true;
        await client.query("SELECT 1 / 0");
      }
    }
  } catch (error) {
    observedFailure = /division by zero/i.test(error.message);
    try { await client.query("ROLLBACK"); } catch {}
  } finally {
    client.release();
  }
  check("failure injected after a destructive rollback statement", injectedAfterMutation);
  check("statement-oriented runner observes injected failure", observedFailure);
  const after = await snapshotState(pool);
  check("BEGIN/ROLLBACK restores complete catalog, ACL, provenance, and ledger state", before === after,
    before === after ? "" : `before=${before.length} after=${after.length}`);
});

console.log(`\n=== Focused provenance proof: ${passed} passed, ${failed} failed ===`);
if (cleanupFailed) console.error("cleanup failure detected");
process.exit(failed > 0 || cleanupFailed ? 1 : 0);
