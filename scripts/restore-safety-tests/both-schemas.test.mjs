// Test 2/5: both-schema verification. A seed whose gitwire_auth is broken
// passes a public-only verifier (the current defect) and must fail the
// declaration-driven both-schema verifier; a good seed passes it.
import { run, log, die, pass } from './helpers.mjs';
import { startPg, sql } from './pg.mjs';

const F = { name: 'rs-t2-fixture', port: 5493 };
const G = { name: 'rs-t2-good', port: 5494 };
const X = { name: 'rs-t2-broken', port: 5495 };
const DUMP = '/tmp/t2.dump';

// The verifier under test: declaration-driven, both schemas.
function verify(dbName, decl, db) {
  const count = (q) => sql(dbName, q, db).out.trim();
  const tables = count("SELECT count(*) FROM pg_tables WHERE schemaname IN ('public','gitwire_auth')");
  const tokens = count('SELECT count(*) FROM gitwire_auth.tokens');
  if (tables !== String(decl.tables)) return `table count ${tables} != ${decl.tables}`;
  if (tokens !== String(decl.rows)) return `gitwire_auth.tokens rows ${tokens} != ${decl.rows}`;
  return null;
}
// The defective verifier: public-only, what restore.sh checks today.
function verifyPublicOnly(dbName, decl, db) {
  const t = sql(dbName, "SELECT count(*) FROM pg_tables WHERE schemaname='public'", db).out.trim();
  return t === String(decl.publicTables) ? null : `public tables ${t}`;
}

startPg(F.name, F.port);
sql(F.name, "CREATE ROLE gitwire NOLOGIN");
sql(F.name, "CREATE SCHEMA gitwire_auth AUTHORIZATION gitwire");
sql(F.name, "CREATE TABLE public.items (id bigserial primary key, name text)");
sql(F.name, "ALTER TABLE public.items OWNER TO gitwire");
sql(F.name, "CREATE TABLE gitwire_auth.tokens (id bigserial primary key, t text)");
sql(F.name, "ALTER TABLE gitwire_auth.tokens OWNER TO gitwire");
sql(F.name, "INSERT INTO public.items(name) VALUES ('a'),('b')");
sql(F.name, "INSERT INTO gitwire_auth.tokens(t) VALUES ('tok1'),('tok2')");
const dump = run(['docker', 'exec', F.name, 'pg_dump', '-U', 'postgres', '-Fc', '-f', DUMP]);
if (dump.code !== 0) die('fixture dump failed');
run(['docker', 'cp', `${F.name}:${DUMP}`, DUMP]);
const DECL = { tables: 2, rows: 2, publicTables: 1 };

for (const [name, port] of [[G.name, G.port], [X.name, X.port]]) startPg(name, port);
run(['docker', 'cp', DUMP, `${G.name}:${DUMP}`]);
run(['docker', 'cp', DUMP, `${X.name}:/tmp/t2.dump`]);

// Broken seed: gitwire_auth.tokens emptied AFTER the restore.
sql(G.name, 'CREATE ROLE gitwire NOLOGIN');
sql(X.name, 'CREATE ROLE gitwire NOLOGIN');
for (const n of [G.name, X.name]) {
  const r = run(['docker', 'exec', n, 'pg_restore', '-U', 'postgres', '-d', 'postgres', '/tmp/t2.dump']);
  if (r.code !== 0) die('restore into ' + n + ' failed: ' + r.out.slice(0, 200));
}
sql(X.name, 'DELETE FROM gitwire_auth.tokens');

// The defective verifier PASSES the broken seed (the defect, shown).
const pubOnly = verifyPublicOnly(X.name, DECL);
if (pubOnly !== null) die('expected the public-only verifier to MISS the breakage, but it returned: ' + pubOnly);
log('defect shown: public-only verifier passed a broken seed');
// The both-schema verifier MUST fail the broken seed and pass the good seed.
const broken = verify(X.name, DECL);
if (broken === null) die('both-schema verifier FAILED to catch the broken gitwire_auth');
log('both-schema verifier caught the broken seed:', broken);
const good = verify(G.name, DECL);
if (good !== null) die('both-schema verifier failed the GOOD seed: ' + good);
pass('both-schemas: public-only misses the breakage, both-schema catches it, good seed passes');
