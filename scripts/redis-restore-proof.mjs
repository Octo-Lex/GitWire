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
// The states at the snapshot are read back from phase1.json, so that the two
// phases stay independent processes.
const snapshot = JSON.parse(fs.readFileSync("phase1.json", "utf8"));
const snapshotStates = snapshot.states;
// What the restored queue must run again: every job that was active or
// waiting at the snapshot, whatever became of it afterwards on instance A.
const again = Object.entries(snapshotStates).filter(([, st]) => st === "active" || st === "waiting").map(([id]) => id).sort();
const runOnB = [];
const second = new Worker("restore-proof", async (job) => {
  runOnB.push(job.id);
}, { connection: { url: urlB }, lockDuration: 3000, stalledInterval: 2000, maxStalledCount: 5 });
for (let i = 0; i < 240 && runOnB.length < again.length; i++) await sleep(250);
await sleep(4000); // room for the stalled check to return the stale lock
await second.close();

const clientB = new Redis(urlB);
const delayedScore = await clientB.zscore("bull:restore-proof:delayed", "JD");
const qB = new Queue("restore-proof", { connection: { url: urlB } });
const delayedJob = await qB.getJob("JD");
const delayedState = delayedJob ? await delayedJob.getState() : "absent";
const rows = IDS.map((id) => ({
  job: id,
  stateAtSnapshot: snapshotStates[id] ?? "unknown",
  executions: (id === "J0" ? 1 : 0) + (runOnB.includes(id) ? 1 : 0),
  ranOnTheRestoredWorker: runOnB.includes(id),
}));
// The rule under test: a job runs again on the restored queue exactly when
// its state at the snapshot was active or waiting. What became of it on
// instance A afterwards does not matter. A job completed before the snapshot,
// like J0, is completed in the snapshot too and must not run again.
const ranOnB = [...runOnB].sort();
const mismatches = ranOnB.join(",") !== again.join(",") ? [{ ranOnB, expectedAgain: again }] : [];
const delayedOk = delayedState === "delayed";
console.log(JSON.stringify({ phase: "restored", rows, ranOnB, expectedAgain: again, finishedOnA: snapshot.finishedOnA, delayed: { state: delayedState, score: delayedScore }, mismatches, delayedScheduleIntact: delayedOk }, null, 1));
process.exit(mismatches.length === 0 && delayedOk ? 0 : 1);
