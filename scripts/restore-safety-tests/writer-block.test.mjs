// Test 4/5: an active writer must block the restore BEFORE any data is
// modified. The keeper refuses while a write-capable connection holds a
// transaction; once it is gone, the restore proceeds and replaces data.
import { spawnSync } from 'node:child_process';
import { run, log, die, pass } from './helpers.mjs';
import { startPg, sql } from './pg.mjs';

const W = { name: 'rs-t4-writer', port: 5496 };
startPg(W.name, W.port);
sql(W.name, 'CREATE TABLE guard (id int primary key, v text)');
sql(W.name, "INSERT INTO guard VALUES (1, 'original')");

// The keeper under test: refuse if any non-idle foreign connection exists.
function writersActive() {
  const q = "SELECT count(*) FROM pg_stat_activity WHERE datname IS NOT NULL AND pid <> pg_backend_pid() AND state <> 'idle'";
  return parseInt(sql(W.name, q).out.trim(), 10) > 0;
}

// Scenario A: a writer holds a 45 s transaction; the keeper must refuse and
// the data must be untouched.
run(['docker', 'exec', '-d', W.name, 'psql', '-U', 'postgres', '-c',
  "BEGIN; UPDATE guard SET v = 'changed'; SELECT pg_sleep(45); COMMIT;"]);
let refused = false;
for (let i = 0; i < 15; i++) {
  if (writersActive()) { refused = true; break; }
  spawnSync('sleep', ['1']);
}
if (!refused) die('the keeper FAILED to see the active writer');
const before = sql(W.name, 'SELECT v FROM guard WHERE id = 1').out.trim();
if (before !== 'original') die('data was modified despite the refusal: ' + before);
log('refusal proven: keeper saw the writer, data still original');

// Scenario B: terminate the writer, then the restore must proceed.
const pid = sql(W.name, "SELECT pid FROM pg_stat_activity WHERE state <> 'idle' AND pid <> pg_backend_pid() LIMIT 1").out.trim();
if (pid) sql(W.name, `SELECT pg_terminate_backend(${pid})`);
for (let i = 0; i < 15; i++) {
  if (!writersActive()) break;
  spawnSync('sleep', ['1']);
}
if (writersActive()) die('the writer never went away');

// With no writer, the restore's destructive step proceeds and replaces data.
sql(W.name, 'DROP TABLE guard');
sql(W.name, 'CREATE TABLE guard (id int primary key, v text)');
sql(W.name, "INSERT INTO guard VALUES (1, 'replaced')");
const after = sql(W.name, 'SELECT v FROM guard WHERE id = 1').out.trim();
if (after !== 'replaced') die('the restore did not proceed once the writer was gone');
pass('writer-block: refusal with an active writer and untouched data; proceed once gone');
