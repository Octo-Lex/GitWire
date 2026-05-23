// src/services/workerEvents.js
// Redis-backed event bus for inter-worker communication.
//
// Workers emit events at the end of their processing. Other workers
// can subscribe to react to those events without going through
// webhook re-delivery.
//
// Storage: Redis sorted set with timestamp score, auto-expiring after 1 hour.
// Key: gitwire:events (pending events)
// Key: gitwire:events:processed (tracking set)

import { redis } from "../lib/db.js";
import { logger } from "../lib/logger.js";

const EVENTS_KEY = "gitwire:events";
const PROCESSED_KEY = "gitwire:events:processed";
const EVENT_TTL_MS = 3600000; // 1 hour

/**
 * Emit a worker event for other workers to consume.
 *
 * @param {string} event - event name (e.g., 'heal_pr_created', 'review_completed')
 * @param {object} data - event payload
 */
export async function emitWorkerEvent(event, data) {
  const payload = {
    event,
    data,
    emitted_at: Date.now(),
    id: event + ":" + (data.repoId || "") + ":" + Date.now(),
  };

  try {
    // Add to sorted set with current timestamp as score
    const score = Date.now();
    await redis.zadd(EVENTS_KEY, score, JSON.stringify(payload));

    // Clean up events older than 1 hour
    const cutoff = Date.now() - EVENT_TTL_MS;
    await redis.zremrangebyscore(EVENTS_KEY, "-inf", cutoff);

    logger.info({ event, repo: data.repo }, "Worker event emitted: " + event);
  } catch (err) {
    logger.warn({ err: err.message, event }, "Failed to emit worker event");
  }
}

/**
 * Process pending worker events for a subscriber.
 * Calls handler for each unprocessed event that matches the subscriber's interest.
 *
 * @param {string} subscriber - subscriber name (e.g., 'phase4Worker')
 * @param {string[]} eventNames - events this subscriber cares about
 * @param {function} handler - async function(eventPayload) => void
 */
export async function processWorkerEvents(subscriber, eventNames, handler) {
  if (!eventNames || eventNames.length === 0) return;

  try {
    // Get events from the last hour
    const cutoff = Date.now() - EVENT_TTL_MS;
    const raw = await redis.zrangebyscore(EVENTS_KEY, cutoff, "+inf");

    for (const item of raw) {
      let payload;
      try {
        payload = JSON.parse(item);
      } catch (_e) {
        continue;
      }

      // Skip events the subscriber doesn't care about
      if (!eventNames.includes(payload.event)) continue;

      // Skip already-processed events
      const processedKey = PROCESSED_KEY + ":" + subscriber;
      const isProcessed = await redis.sismember(processedKey, payload.id);
      if (isProcessed) continue;

      // Process the event
      try {
        await handler(payload);
        // Mark as processed
        await redis.sadd(processedKey, payload.id);
        // Expire tracking set daily
        await redis.expire(processedKey, 86400);
      } catch (err) {
        logger.warn(
          { err: err.message, subscriber, event: payload.event },
          "Worker event handler failed"
        );
      }
    }
  } catch (err) {
    logger.warn({ err: err.message, subscriber }, "Failed to process worker events");
  }
}
