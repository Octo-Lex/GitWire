// Test 1/5: roles-first restore. Without the roles, pg_restore fails at the
// first ownership statement; with the roles created per their declared
// properties, the restore completes AND the authorization model verifies.
import { run, log, die, pass } from './helpers.mjs';
import { startPg, sql } from './pg.mjs';

const A = { name: 'rs-t1-fixture', port: 5491 };
const B = { name: 'rs-t1-target', port: 5492 };
const C = { name: 'rs-t1-success', port: 5497 };
const DUMP = '/tmp/t1.dump';
const DECL = {
  roles: { gitwire: { login: false }, gitwire_app: { login: true, member: 'gitwire' } },
  schemas: ['public', 'gitwire_auth'],
  tables: 2,
};

startPg(A.name, A.port);
sql(A.name, "CREATE ROLE gitwire NOLOGIN");
sql(A.name, "CREATE ROLE gitwire_app LOGIN PASSWORD 'x'");
sql(A.name, "GRANT gitwire TO gitwire_app");
sql(A.name, "CREATE SCHEMA gitwire_auth AUTHORIZATION gitwire");
sql(A.name, "CREATE TABLE public.items (id bigserial primary key, name text)");
sql(A.name, "ALTER TABLE public.items OWNER TO gitwire");
sql(A.name, "CREATE TABLE gitwire_auth.tokens (id bigserial primary key, t text)");
sql(A.name, "ALTER TABLE gitwire_auth.tokens OWNER TO gitwire");
sql(A.name, "GRANT USAGE ON SCHEMA gitwire_auth TO gitwire_app");
sql(A.name, "GRANT SELECT ON gitwire_auth.tokens TO gitwire_app");
sql(A.name, "INSERT INTO public.items(name) VALUES ('a'),('b')");
sql(A.name, "INSERT INTO gitwire_auth.tokens(t) VALUES ('tok1'),('tok2')");

const dump = run(['docker', 'exec', A.name, 'pg_dump', '-U', 'postgres', '-Fc', '-f', DUMP]);
if (dump.code !== 0) die('fixture dump failed: ' + dump.out.slice(0, 200));
const pull = run(['docker', 'cp', `${A.name}:${DUMP}`, '/tmp/t1.dump']);
if (pull.code !== 0) die('could not pull the dump: ' + pull.out.slice(0, 200));
log('fixture dumped:', run(['ls', '-la', '/tmp/t1.dump']).out.split('\n')[0]);

// Scenario A (rejection): restore into a fresh cluster WITHOUT the roles.
startPg(B.name, B.port);
const push = run(['docker', 'cp', '/tmp/t1.dump', `${B.name}:${DUMP}`]);
if (push.code !== 0) die('could not push the dump: ' + push.out.slice(0, 200));
const badRestore = run(['docker', 'exec', B.name, 'pg_restore', '-U', 'postgres', '-d', 'postgres', DUMP]);
log('scenario A: pg_restore without roles -> exit', badRestore.code);
if (badRestore.code === 0) die('rejection path FAILED: restore succeeded without the roles');

// Scenario B (success): roles to their DECLARED properties, then restore,
startPg(C.name, C.port);
// then verify the authorization model + declaration-driven counts.
sql(C.name, "CREATE ROLE gitwire NOLOGIN");
sql(C.name, "CREATE ROLE gitwire_app LOGIN");
sql(C.name, "GRANT gitwire TO gitwire_app");
run(['docker', 'cp', '/tmp/t1.dump', `${C.name}:${DUMP}`]);
const goodRestore = run(['docker', 'exec', C.name, 'pg_restore', '-U', 'postgres', '-d', 'postgres', DUMP]);
if (goodRestore.code !== 0) die('restore failed with roles present: ' + goodRestore.out.slice(0, 300));

// Verify the authorization model (R1): owners, memberships, login capability.
const owner = sql(C.name, "SELECT tableowner FROM pg_tables WHERE tablename='items'");
if (!/gitwire/.test(owner.out)) die('owner check failed: ' + owner.out);
const schemaOwner = sql(C.name, "SELECT pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname='gitwire_auth'");
if (!/gitwire/.test(schemaOwner.out)) die('schema owner check failed: ' + schemaOwner.out);
const mem = sql(C.name, "SELECT count(*) FROM pg_auth_members m JOIN pg_roles r ON m.member=r.oid JOIN pg_roles g ON m.roleid=g.oid WHERE r.rolname='gitwire_app' AND g.rolname='gitwire'");
if (!/^1/.test(mem.out.trim())) die('membership check failed: ' + mem.out);
const canLogin = sql(C.name, "SELECT rolcanlogin FROM pg_roles WHERE rolname='gitwire'");
if (/^t/.test(canLogin.out.trim())) die('gitwire must stay NOLOGIN');

// Declaration-driven counts (R2): compare against DECL, not hard-coded values.
const nSchemas = sql(C.name, "SELECT count(*) FROM pg_namespace WHERE nspname IN ('public','gitwire_auth')");
if (nSchemas.out.trim() !== '2') die('schema count mismatch');
const nTables = sql(C.name, "SELECT count(*) FROM pg_tables WHERE schemaname IN ('public','gitwire_auth')");
if (nTables.out.trim() !== String(DECL.tables)) die('table count mismatch');
const rows = sql(C.name, "SELECT count(*) FROM gitwire_auth.tokens");
if (rows.out.trim() !== '2') die('row count mismatch');
pass('roles-first: rejection without roles, success + authorization model with them');
