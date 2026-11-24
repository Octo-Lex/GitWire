// Scratch PostgreSQL helper: docker postgres:16-alpine on a per-test port.
import { spawnSync } from 'node:child_process';
import { run, die } from './helpers.mjs';

export function startPg(name, port) {
  run(['docker', 'rm', '-f', name]);
  const up = run(['docker', 'run', '-d', '--name', name, '-e', 'POSTGRES_PASSWORD=postgres',
    '-p', `${port}:5432`, 'postgres:16-alpine']);
  if (up.code !== 0) die('scratch postgres did not start: ' + up.out.slice(0, 200));
  for (let i = 0; i < 60; i++) {
    if (run(['docker', 'exec', name, 'pg_isready', '-h', '127.0.0.1']).code === 0) return;
    spawnSync('sleep', ['1']);
  }
  die('scratch postgres never answered TCP');
}
export const sql = (name, q, db = 'postgres') =>
  run(['docker', 'exec', name, 'psql', '-U', 'postgres', '-d', db, '-Atc', q]);
