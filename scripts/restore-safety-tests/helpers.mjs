// Shared helpers for the #508 phase-1 isolated tests. Scratch engines via
// docker, per-test names/ports, no secrets, no production contact.
import { spawnSync } from 'node:child_process';

export const log = (...a) => console.log(...a);
export const die = (m) => { console.log('FAIL:', m); process.exit(1); };
export const pass = (name) => { console.log('PASS:', name); };
export const run = (cmd, opts = {}) => {
  const r = spawnSync(cmd[0], cmd.slice(1), { encoding: 'utf8', ...opts });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
};
