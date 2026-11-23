#!/usr/bin/env node
// scripts/redis-restore-proof.mjs
//
// The synthetic restore trial of #10-R1 (design comment 7086734566): with
// generated jobs and no secrets, it shows what a restored BullMQ queue does
// when a worker starts on it. It answers the design's table with numbers:
//
//   a job completed before the snapshot does not run again;
//   a job that was active at the snapshot runs again;
//   a job that completed after the snapshot runs again;
//   a job still waiting at the snapshot runs once, on the restored queue;
//   a delayed job survives the restore with its schedule intact.
//
// Two Redis instances are used. Instance A holds the live queue. The snapshot
// is an RDB file written by BGSAVE while one job is active. Instance B loads
// that file and a second worker starts on it, which is what a restore does.
// No worker of GitWire runs here and nothing leaves the two instances.
//
// The script runs in two phases, because moving the snapshot into instance B
// is the runner's work, between the phases:
//   phase 1 (no RESUME in the environment): work on A, take the snapshot,
//     print the states at the snapshot, exit 0;
//   phase 2 (RESUME=1): start a worker on B, print the table, exit 0 when
//     the table matches the expectation, 1 otherwise.
//
// Environment: REDIS_A_URL, REDIS_B_URL, RESUME (optional).

import fs from "node:fs";
import Redis from "ioredis";
import { Queue, Worker } from "bullmq";

const urlA = process.env.REDIS_A_URL ?? "redis://127.0.0.1:6379";
const urlB = process.env.REDIS_B_URL ?? "redis://127.0.0.1:6380";
const IDS = ["J0", "J1", "J2", "J3", "J4", "J5", "JD"];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const resume = Boolean(process.env.RESUME);

const clientA = new Redis(urlA);
const queue = new Queue("restore-proof", { connection: { url: urlA } });
const states = {};
if (!resume) {
  await queue.obliterate({ force: true });

  const runOnA = [];
  const slow = new Worker("restore-proof", async (job) => {
    await sleep(1100);
    runOnA.push(job.id);
  }, { connection: { url: urlA }, lockDuration: 3000, stalledInterval: 2000, maxStalledCount: 5 });

  await queue.add("job", { which: "J0" }, { jobId: "J0" });
  for (let i = 0; i < 60 && runOnA.length < 1; i++) await sleep(250);
  for (const which of ["J1", "J2", "J3", "J4", "J5"]) await queue.add("job", { which }, { jobId: which });
  await queue.add("job", { which: "JD" }, { jobId: "JD", delay: 1800000 });
  await sleep(300); // J1 becomes active

  // The snapshot, while J1 is active.
  await clientA.bgsave();
  for (let i = 0; i < 120; i++) {
    await sleep(250);
    const raw = await clientA.info("persistence");
    if (!/^rdb_bgsave_in_progress:1$/m.test(raw)) break;
  }
  for (const id of IDS) states[id] = await (await queue.getJob(id)).getState();

  // Worker A keeps working: J1, J2 and J3 finish after the snapshot.
  for (let i = 0; i < 120 && runOnA.length < 4; i++) await sleep(250);
  await slow.close();
  console.log(JSON.stringify({ phase: "snapshot", states, finishedOnA: [...runOnA] }, null, 1));
  process.exit(0);
}

// Phase 2: a worker starts on the restored instance B.
// The states at the snapshot come back through the environment, so that the
// two phases stay independent processes.
const snapshotStates = process.env.SNAPSHOT_STATES
  ? JSON.parse(process.env.SNAPSHOT_STATES)
  : JSON.parse(fs.readFileSync("phase1.json", "utf8")).states;
const runOnB = [];
const second = new Worker("restore-proof", async (job) => {
  runOnB.push(job.id);
}, { connection: { url: urlB }, lockDuration: 3000, stalledInterval: 2000, maxStalledCount: 5 });
for (let i = 0; i < 240 && runOnB.length < 5; i++) await sleep(250);
await sleep(4000); // room for the stalled check to return the stale lock
await second.close();

const clientB = new Redis(urlB);
const delayedAt = Number(await clientB.zscore("bull:restore-proof:delayed", "JD")) || null;
const rows = IDS.map((id) => ({
  job: id,
  stateAtSnapshot: snapshotStates[id] ?? "unknown",
  executions: (id === "J0" ? 1 : 0) + (runOnB.includes(id) ? 1 : 0),
  ranOnTheRestoredWorker: runOnB.includes(id),
}));
// Expectation: J0 ran once, before the snapshot, and must not run again.
// J1 was active at the snapshot and finished on A after it: it runs again.
// J2 and J3 completed on A after the snapshot: they run again.
// J4 and J5 never ran on A: they run once, on B. JD stays delayed.
const expect = { J0: 1, J1: 2, J2: 2, J3: 2, J4: 1, J5: 1, JD: 0 };
const mismatches = rows.filter((r) => r.executions !== expect[r.job]);
const delayedOk = Boolean(delayedAt) && delayedAt > Date.now() - 120000 && delayedAt < Date.now() + 120000;
console.log(JSON.stringify({ phase: "restored", rows, finishedOnTheRestoredWorker: [...runOnB], delayed: { score: delayedAt ? new Date(delayedAt).toISOString() : null }, expectation: expect, mismatches, delayedScheduleIntact: delayedOk }, null, 1));
process.exit(mismatches.length === 0 && delayedOk ? 0 : 1);
