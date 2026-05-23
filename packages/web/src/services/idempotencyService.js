// src/services/idempotencyService.js
// Redis-backed idempotency checks for worker deduplication.
//
// Prevents duplicate processing when GitHub retries webhooks or when
// two workers pick up the same event simultaneously.
//
// Key pattern: gitwire:idem:{source}:{key}
// TTL: 1 hour by default (configurable per check)

import { redis } from "../lib/queue.js";
import { logger } from "../lib/logger.js";

const IDEM_PREFIX = "gitwire:idem:";
const DEFAULT_TTL_MS = 3600000; // 1 hour

/**
 * Check if an operation has already been processed.
 * Returns true if this is a duplicate (should skip).
 *
 * @param {string} source - worker/event source name
 * @param {string} key - unique identifier (e.g., 'run-12345', 'issue-42-triage')
 * @param {number} ttlMs - dedup window in ms (default: 1 hour)
 * @returns {Promise<boolean>} true = duplicate, false = fresh
 */
export async function isDuplicate(source, key, ttlMs = DEFAULT_TTL_MS) {
  const redisKey = IDEM_PREFIX + source + ":" + key;
  try {
    const exists = await redis.exists(redisKey);
    return exists === 1;
  } catch (err) {
    logger.warn({ err: err.message, source, key }, "Idempotency check failed — allowing operation");
    return false;
  }
}

/**
 * Mark an operation as processed.
 *
 * @param {string} source - worker/event source name
 * @param {string} key - unique identifier
 * @param {number} ttlMs - TTL in ms
 */
export async function markProcessed(source, key, ttlMs = DEFAULT_TTL_MS) {
  const redisKey = IDEM_PREFIX + source + ":" + key;
  try {
    await redis.set(redisKey, Date.now().toString(), "PX", ttlMs);
  } catch (err) {
    logger.warn({ err: err.message, source, key }, "Failed to mark idempotency key");
  }
}

/**
 * Combined check-and-mark. Returns true if this was a fresh operation.
 * If false, the operation was already processed — skip it.
 *
 * @param {string} source - worker/event source name
 * @param {string} key - unique identifier
 * @param {number} ttlMs - dedup window in ms
 * @returns {Promise<boolean>} true = fresh (proceed), false = duplicate (skip)
 */
export async function checkAndMark(source, key, ttlMs = DEFAULT_TTL_MS) {
  const isDup = await isDuplicate(source, key, ttlMs);
  if (isDup) {
    logger.info({ source, key }, "Idempotency: duplicate operation detected — skipping");
    return false;
  }
  await markProcessed(source, key, ttlMs);
  return true;
}

/**
 * Remove an idempotency key (e.g., to allow re-processing after manual /gitwire run).
 *
 * @param {string} source
 * @param {string} key
 */
export async function clearIdempotencyKey(source, key) {
  const redisKey = IDEM_PREFIX + source + ":" + key;
  try {
    await redis.del(redisKey);
  } catch (err) {
    logger.warn({ err: err.message, source, key }, "Failed to clear idempotency key");
  }
}
