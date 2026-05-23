// @gitwire/runtime/src/create-queue.js
// Factory for creating Redis connections, BullMQ queues, and workers.
// Accepts connection config — no config import needed.

import { Queue, Worker } from "bullmq";
import IORedis from "ioredis";

/**
 * Create a shared Redis connection for BullMQ.
 * BullMQ requires maxRetriesPerRequest: null for blocking commands.
 * @param {string} url - Redis URL
 * @param {{ logger?: object }} opts
 * @returns {IORedis}
 */
export function createRedisConnection(url, opts = {}) {
  const logger = opts.logger || console;

  const redis = new IORedis(url, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  });

  redis.on("error", (err) => logger.error({ err }, "Redis connection error"));
  redis.on("connect", () => logger.info("Redis connected"));

  return redis;
}

/**
 * Create a BullMQ Queue bound to the given Redis connection.
 * @param {IORedis} redis
 * @param {string} name - Queue name
 * @returns {Queue}
 */
export function createQueue(redis, name) {
  return new Queue(name, {
    connection: redis,
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: "exponential", delay: 2_000 },
      removeOnComplete: { count: 500 },
      removeOnFail:    { count: 1_000 },
    },
  });
}

/**
 * Create a BullMQ Worker for a named queue.
 * @param {IORedis}   redis     - Redis connection
 * @param {string}    name      - Queue name
 * @param {Function}  processor - async (job) => void
 * @param {{ logger?: object, concurrency?: number, ...opts }} opts
 * @returns {Worker}
 */
export function createWorker(redis, name, processor, opts = {}) {
  const logger = opts.logger || console;
  const concurrency = opts.concurrency || 5;
  // Don't pass our custom opts into BullMQ Worker
  const workerOpts = { connection: redis, concurrency };
  if (opts.limiter) workerOpts.limiter = opts.limiter;

  const worker = new Worker(name, processor, workerOpts);

  worker.on("completed", (job) =>
    logger.info({ queue: name, jobId: job.id }, "Job completed")
  );
  worker.on("failed", (job, err) =>
    logger.error({ queue: name, jobId: job?.id, err }, "Job failed")
  );

  return worker;
}
