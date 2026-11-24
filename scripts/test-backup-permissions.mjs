// Synthetic test for #502: backup.sh must create its artifacts owner-only.
// Runs the REAL backup.sh against a temp destination with a stub `docker` on
// PATH, then asserts: the backup dir is 700, every artifact 600, and an
// owner reader can read each file (what the authorized restore procedure does).
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, statSync, readFileSync, accessSync, constants, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const log = (...a) => console.log(...a);
const die = (m) => { console.log('FAIL:', m); process.exit(1); };
const ROOT = process.cwd();
const DEST = mkdtempSync(join(tmpdir(), 'backup-perm-'));

// The stub docker: emulates every container call backup.sh makes.
const stub = join(DEST, 'stubbin');
const { mkdirSync, writeFileSync, chmodSync } = await import('node:fs');
mkdirSync(stub);
chmodSync(stub, 0o755);
writeFileSync(join(stub, 'docker'), `#!/usr/bin/env bash
case "$1 $2" in
  "exec gitwire-postgres-1") case "$3" in
    pg_dump) printf 'PGDMP-fake-%s' "$$";;
    psql) echo 77;;
  esac;;
  "exec gitwire-redis-1") case "$3" in
    redis-cli) case "$4" in
      BGSAVE) echo "Background saving started";;
      KEYS) echo "bull:default:wait";;
    esac;;
  esac;;
  cp) case "$3" in
    *dump.rdb) echo fake-rdb > "$4";;
    *pem) echo fake-pem > "$4";;
  esac;;
  inspect) echo "sha256:deadbeefdeadbeef";;
  *) exit 0;;
esac
`);
chmodSync(join(stub, 'docker'), 0o755);

// backup.sh hard-codes its production paths; plant stand-ins for the run.
const sudo = (args) => spawnSync('sudo', args, { encoding: 'utf8' });
if (sudo(['mkdir', '-p', '/opt/gitwire/packages/web']).status !== 0) die('sudo mkdir failed');
if (sudo(['bash', '-c', 'echo FAKE_ENV_SECRET > /opt/gitwire/packages/web/.env']).status !== 0) die('could not plant the fake .env');
if (sudo(['bash', '-c', 'echo FAKE_COMPOSE > /opt/gitwire/docker-compose.yml']).status !== 0) die('could not plant the fake compose file');

// Run the REAL backup.sh with the stub docker and a temp destination.
const env = { ...process.env, PATH: `${stub}:${process.env.PATH}` };
const r = spawnSync('bash', [join(ROOT, 'scripts/backup.sh'), DEST], { env, encoding: 'utf8' });
if (r.status !== 0) die('backup.sh exited nonzero: ' + (r.stdout + r.stderr).slice(-400));
const run0 = readdirSync(DEST).find((d) => /^\d{8}_\d{6}$/.test(d));
if (!run0) die('no backup dir was created');
const BD = join(DEST, run0);
const mode = (p) => (statSync(p).mode & 0o777).toString(8).padStart(3, '0');
if (mode(BD) !== '700') die(`backup dir mode is ${mode(BD)}, expected 700`);

// Every artifact must be 600, and an owner reader must be able to read it
// (what the authorized restore procedure does).
const EXPECT = ['gitops_hub.dump', 'redis_dump.rdb', 'redis_keys.txt', 'web.env',
  'docker-compose.yml', 'manifest.json'];
for (const f of EXPECT) {
  const p = join(BD, f);
  let ok = true;
  try { accessSync(p, constants.R_OK); } catch { ok = false; }
  const m = existsSync(p) ? mode(p) : 'absent';
  if (!ok || m !== '600') die(`${f}: mode ${m} readable=${ok}, expected 600+readable`);
}
log('all artifacts 600 + owner-readable; dir 700');
rmSync(DEST, { recursive: true, force: true });
pass('backup-permissions: umask 077 yields dir 700 and 600 owner-readable artifacts');
