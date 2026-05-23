// @gitwire/runtime/compat/queue.js
// Lazy singleton — delegates to the runtime-initialized Redis + queues.
// Auto-initializes from config if needed.
// All existing imports continue to work:
//   import { redis, createQueue, createWorker, webhookQueue, ... } from "../lib/queue.js";

import { Queue, Worker } from "bullmq";
import { getRuntime } from "../src/index.js";
import { ensureRuntime } from "./_init.js";
import { QUEUES } from "@gitwire/core";

export { QUEUES };

// Redis connection — lazy proxy
export const redis = new Proxy(
  {},
  {
    get(_target, prop) {
      ensureRuntime();
      const rt = getRuntime();
      const val = rt.redis[prop];
      return typeof val === "function" ? val.bind(rt.redis) : val;
    },
  }
);

// Factory helpers — lazily use runtime's redis connection
export function createQueue(name) {
  ensureRuntime();
  const rt = getRuntime();
  return new Queue(name, {
    connection: rt.redis,
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: "exponential", delay: 2_000 },
      removeOnComplete: { count: 500 },
      removeOnFail:    { count: 1_000 },
    },
  });
}

export function createWorker(name, processor, opts = {}) {
  ensureRuntime();
  const rt = getRuntime();
  const worker = new Worker(name, processor, {
    connection: rt.redis,
    concurrency: opts.concurrency || 5,
    ...opts,
  });

  worker.on("completed", (job) =>
    rt.logger.info({ queue: name, jobId: job.id }, "Job completed")
  );
  worker.on("failed", (job, err) =>
    rt.logger.error({ queue: name, jobId: job?.id, err }, "Job failed")
  );

  return worker;
}

// Singleton queues — lazily created on first access via Proxy
const QUEUE_NAMES = {
  webhookQueue:    QUEUES.WEBHOOK_EVENTS,
  triageQueue:     QUEUES.TRIAGE,
  ciHealQueue:     QUEUES.CI_HEALING,
  syncQueue:       QUEUES.SYNC,
  maintainerQueue: QUEUES.MAINTAINER,
  issueFixQueue:   QUEUES.ISSUE_FIX,
  phase2Queue:     QUEUES.PHASE2,
  phase3Queue:     QUEUES.PHASE3,
  phase4Queue:     QUEUES.PHASE4,
};

const _queueCache = {};

function getQueueSingleton(prop) {
  if (!_queueCache[prop]) {
    ensureRuntime();
    const rt = getRuntime();
    _queueCache[prop] = new Queue(QUEUE_NAMES[prop], {
      connection: rt.redis,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: "exponential", delay: 2_000 },
        removeOnComplete: { count: 500 },
        removeOnFail:    { count: 1_000 },
      },
    });
  }
  return _queueCache[prop];
}

// Export named singleton queues as lazy proxies
export const webhookQueue    = new Proxy({}, { get: (_, p) => getQueueSingleton("webhookQueue")[p] });
export const triageQueue     = new Proxy({}, { get: (_, p) => getQueueSingleton("triageQueue")[p] });
export const ciHealQueue     = new Proxy({}, { get: (_, p) => getQueueSingleton("ciHealQueue")[p] });
export const syncQueue       = new Proxy({}, { get: (_, p) => getQueueSingleton("syncQueue")[p] });
export const maintainerQueue = new Proxy({}, { get: (_, p) => getQueueSingleton("maintainerQueue")[p] });
export const issueFixQueue   = new Proxy({}, { get: (_, p) => getQueueSingleton("issueFixQueue")[p] });
export const phase2Queue     = new Proxy({}, { get: (_, p) => getQueueSingleton("phase2Queue")[p] });
export const phase3Queue     = new Proxy({}, { get: (_, p) => getQueueSingleton("phase3Queue")[p] });
export const phase4Queue     = new Proxy({}, { get: (_, p) => getQueueSingleton("phase4Queue")[p] });
