#!/usr/bin/env node
// scripts/redis-rdb-vs-aof-precedence-proof.mjs
//
// Synthetic, isolated proof for restore-safety unit #508 (defect 3): when a
// Redis instance is configured with AOF enabled and BOTH an AOF file and an
// RDB file exist, which state does the server actually load?
//
// Two throwaway scenarios, each in its own empty Redis data directory, no
// network, no production contact, no secrets:
//
//   Scenario 1 — RDB only:            the RDB state must load.
//   Scenario 2 — RDB + AOF together:  the state actually loaded is compared
//                                     against both, and the winner is named.
//
// The scenario-2 layout mirrors what scripts/restore.sh produces on CT 115:
// Redis 7 with appendonly yes keeps its AOF under appendonlydir/, while
// restore.sh copies dump.rdb to /data/dump.rdb. If the AOF is older or holds
// different keys, the restored server may come up with the AOF's state and
// silently ignore the freshly restored RDB.
//
// Needs: a redis-server binary (REDIS_SERVER env or `redis-server` on PATH)
// and a writable temp directory. Exits 0 only when both scenarios behave as
// documented; the point of scenario 2 is to RECORD the winner, and the exit
// reflects whether the winner matches the expectation passed in EXPECT
// ("aof" or "rdb"; default: expect the AOF to win, per the Redis docs).

import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const server = process.env.REDIS_SERVER || "redis-server";
const port = Number(process.env.REDIS_PORT || 6399);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rdb-aof-proof-"));
process.on("exit", () => fs.rmSync(dir, { recursive: true, force: true }));

const startRedis = async (dataDir, extraArgs = []) => {
  const child = spawn(server, ["--port", String(port), "--bind", "127.0.0.1", "--dir", dataDir, "--daemonize", "no", ...extraArgs], { stdio: ["ignore", "pipe", "pipe"] });
  child.stderr.on("data", () => {});
  let up = false;
  for (let i = 0; i < 60 && !up; i++) {
    await sleep(250);
    try {
      execFileSync(server.replace(/server$/, "cli"), ["-p", String(port), "ping"], { timeout: 2000, stdio: "ignore" });
      up = true;
    } catch {}
  }
  if (!up) throw new Error("redis did not come up");
  return child;
};
const stopRedis = (child) => {
  try {
    execFileSync(server.replace(/server$/, "cli"), ["-p", String(port), "shutdown", "nosave"], { timeout: 5000, stdio: "ignore" });
  } catch {}
  try { child.kill("SIGKILL"); } catch {}
  return sleep(500);
};
const dbsize = () => Number(execFileSync(server.replace(/server$/, "cli"), ["-p", String(port), "dbsize"], { encoding: "utf8" }).trim());

// ── Scenario 1: RDB only ────────────────────────────────────────────────────
const s1 = path.join(dir, "s1");
fs.mkdirSync(s1);
let child = await startRedis(s1);
try {
  execFileSync(server.replace(/server$/, "cli"), ["-p", String(port), "set", "rdb-state", "present"], { stdio: "ignore" });
  execFileSync(server.replace(/server$/, "cli"), ["-p", String(port), "save"], { stdio: "ignore" });
} finally {
  await stopRedis(child);
}
child = await startRedis(s1);
let s1Loaded = 0;
try { s1Loaded = dbsize(); } finally { await stopRedis(child); }
console.log(`scenario 1 (RDB only): keys after restart = ${s1Loaded} (expected 1: the RDB state loads)`);

// ── Scenario 2: RDB + AOF together, different states ────────────────────────
const s2 = path.join(dir, "s2");
fs.mkdirSync(path.join(s2, "appendonlydir"), { recursive: true });
child = await startRedis(s2, ["--appendonly", "yes"]);
try {
  execFileSync(server.replace(/server$/, "cli"), ["-p", String(port), "set", "aof-state", "older-but-live"], { stdio: "ignore" });
} finally {
  await stopRedis(child); // graceful: writes the AOF
}
// The restore.sh move: a fresh RDB appears at /data/dump.rdb AFTER the AOF exists.
fs.copyFileSync(path.join(s1, "dump.rdb"), path.join(s2, "dump.rdb"));
child = await startRedis(s2, ["--appendonly", "yes"]);
let s2Loaded = 0;
let s2Key = "(none)";
try {
  s2Loaded = dbsize();
  s2Key = execFileSync(server.replace(/server$/, "cli"), ["-p", String(port), "get", "aof-state"], { encoding: "utf8" }).trim() || "(nil)";
  s2Key = execFileSync(server.replace(/server$/, "cli"), ["-p", String(port), "keys", "*"], { encoding: "utf8" }).trim().split("\n").join(", ");
} finally {
  await stopRedis(child);
}
const winner = s2Loaded === 1 && s2Key.includes("aof-state") ? "AOF" : s2Loaded === 1 && s2Key.includes("rdb-state") ? "RDB" : `unknown (${s2Key})`;
const expect = process.env.EXPECT || "AOF";
console.log(`scenario 2 (RDB + AOF together): keys after restart = ${s2Loaded} | contents: ${s2Key}`);
console.log(`  the state that loaded: ${winner}`);
const ok = winner === expect;
console.log(`expectation: ${expect} wins -> ${ok ? "matches" : "DOES NOT match"} (set EXPECT=rdb|aof to assert the other outcome)`);
fs.rmSync(dir, { recursive: true, force: true });
process.exit(ok ? 0 : 1);
