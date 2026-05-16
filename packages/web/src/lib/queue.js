// src/lib/queue.js
// Redis client + BullMQ queue/worker factory.
// All background jobs flow through a single Redis connection.

import { Queue, Worker } from "bullmq";
import IORedis from "ioredis";
import { config } from "../../config/index.js";
import { logger } from "./logger.js";

// ── Shared Redis connection ──────────────────────────────────────────────────
// BullMQ requires maxRetriesPerRequest: null for blocking commands.
export const redis = new IORedis(config.redis.url, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
});

redis.on("error", (err) => logger.error({ err }, "Redis connection error"));
redis.on("connect", () => logger.info("Redis connected"));

// ── Queue names (single source of truth: @gitwire/core) ─────────────────────
import { QUEUES } from "@gitwire/core";
export { QUEUES };

// ── Factory helpers ──────────────────────────────────────────────────────────

/**
 * Create (or retrieve) a named BullMQ Queue.
 * @param {string} name - One of the QUEUES constants
 */
export function createQueue(name) {
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
 * @param {string}   name      - Queue name
 * @param {Function} processor - async (job) => void
 * @param {object}   opts      - Extra Worker options
 */
export function createWorker(name, processor, opts = {}) {
  const worker = new Worker(name, processor, {
    connection: redis,
    concurrency: 5,
    ...opts,
  });

  worker.on("completed", (job) =>
    logger.info({ queue: name, jobId: job.id }, "Job completed")
  );
  worker.on("failed", (job, err) =>
    logger.error({ queue: name, jobId: job?.id, err }, "Job failed")
  );

  return worker;
}

// ── Singleton queues (import these in route handlers) ───────────────────────
export const webhookQueue   = createQueue(QUEUES.WEBHOOK_EVENTS);
export const triageQueue    = createQueue(QUEUES.TRIAGE);
export const ciHealQueue    = createQueue(QUEUES.CI_HEALING);
export const syncQueue      = createQueue(QUEUES.SYNC);
export const maintainerQueue = createQueue(QUEUES.MAINTAINER);
export const issueFixQueue   = createQueue(QUEUES.ISSUE_FIX);
