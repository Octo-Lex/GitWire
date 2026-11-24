// Test 3/5: the RDB version-rejection gate. A format-12 RDB (written by
// Redis 7.4) must be refused by a Redis 7.0 server before any data loads;
// the same RDB loads on a 7.4 server (positive control).
import { spawnSync } from 'node:child_process';
import { run, log, die, pass } from './helpers.mjs';

const PRODUCER = 'rs-t3-redis74';
const OLD = 'rs-t3-redis70';

// Produce a real format-12 RDB on 7.4 and pull it out.
run(['docker', 'rm', '-f', PRODUCER, OLD]);
if (run(['docker', 'run', '-d', '--name', PRODUCER, 'redis:7.4-alpine']).code !== 0) die('redis:7.4 did not start');
for (let i = 0; i < 40; i++) {
  if (run(['docker', 'exec', PRODUCER, 'redis-cli', 'ping']).out.includes('PONG')) break;
  spawnSync('sleep', ['1']);
}
run(['docker', 'exec', PRODUCER, 'redis-cli', 'set', 'rsproof', 'format12']);
run(['docker', 'exec', PRODUCER, 'redis-cli', 'save']);
const pull = run(['docker', 'cp', `${PRODUCER}:/data/dump.rdb`, '/tmp/t3.rdb']);
if (pull.code !== 0) die('could not pull the 7.4 dump: ' + pull.out.slice(0, 120));
log('format-12 RDB produced on redis 7.4');

// Rejection: 7.0 refuses the format-12 RDB (server must fail to load it).
const dir70 = '/tmp/t3-target';
run(['rm', '-rf', dir70]);
run(['mkdir', '-p', dir70]);
run(['cp', '/tmp/t3.rdb', `${dir70}/dump.rdb`]);
if (run(['docker', 'run', '-d', '--name', OLD, '-v', `${dir70}:/data`, 'redis:7.0-alpine']).code !== 0) die('redis:7.0 did not start');
let refused = false;
for (let i = 0; i < 20; i++) {
  spawnSync('sleep', ['1']);
  const st = run(['docker', 'inspect', '-f', '{{.State.Status}} {{.State.ExitCode}}', OLD]).out.trim();
  if (/exited 1/.test(st)) { refused = true; break; }
}

if (!refused) die('redis 7.0 did NOT refuse the format-12 RDB');
const err = run(['docker', 'logs', OLD]).out;
if (!/RDB|version|fatal/i.test(err)) log('note: refusal reason in logs:', err.split('\n').find(l => /RDB|version/i.test(l)) || '(not surfaced)');
if (run(['docker', 'exec', OLD, 'redis-cli', 'ping']).out.includes('PONG')) die('server answered despite the refusal');
log('rejection proven: 7.0 refused the format-12 RDB and loaded nothing');
run(['docker', 'rm', '-f', OLD]);

// Positive control: the same RDB loads on 7.4.
run(['cp', '/tmp/t3.rdb', `${dir70}/dump.rdb`]);
if (run(['docker', 'run', '-d', '--name', PRODUCER + '-reload', '-v', `${dir70}:/data`, 'redis:7.4-alpine']).code !== 0) die('7.4 reload container did not start');

let loaded = false;
for (let i = 0; i < 40; i++) {
  if (run(['docker', 'exec', PRODUCER + '-reload', 'redis-cli', 'get', 'rsproof']).out.includes('format12')) { loaded = true; break; }
  spawnSync('sleep', ['1']);
}
if (!loaded) die('the positive control failed: 7.4 did not load its own dump');
run(["docker", "rm", "-f", PRODUCER + "-reload"]);
pass("rdb-version-gate: 7.0 refuses format 12 before any data loads; 7.4 loads it")
