// src/services/reviewHeartbeat.js
// Heartbeat wrapper for long-running AI review calls.
//
// Adapted from prior autoreview work autoreview heartbeat pattern:
//   Periodic logging so the system knows a review is still running,
//   instead of appearing to hang silently.

import { logger } from "../lib/logger.js";

const DEFAULT_INTERVAL_MS = 30000;  // Log every 30s
const DEFAULT_TIMEOUT_MS = 300000;  // Hard timeout at 5 minutes

/**
 * Wrap an async operation with heartbeat logging.
 *
 * @param {Function} fn - Async function to run
 * @param {object} opts
 * @param {string} opts.label - Description for log messages (e.g. "claude review")
 * @param {number} [opts.intervalMs] - Heartbeat interval (default 30s)
 * @param {number} [opts.timeoutMs] - Hard timeout (default 5min)
 * @returns {Promise<*>} Result of fn
 */
export async function withHeartbeat(fn, opts) {
  const label = opts.label || "operation";
  const intervalMs = opts.intervalMs || DEFAULT_INTERVAL_MS;
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;

  const startTime = Date.now();
  let completed = false;
  let heartbeatTimer = null;

  // Start heartbeat
  heartbeatTimer = setInterval(function () {
    if (completed) return;
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    logger.info({ label, elapsed: elapsed + "s" }, "review still running: " + label + " elapsed=" + elapsed + "s");
  }, intervalMs);

  // Ensure cleanup
  const cleanup = function () {
    completed = true;
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  };

  try {
    // Race between the operation and the timeout
    const result = await Promise.race([
      fn(),
      new Promise(function (_, reject) {
        setTimeout(function () {
          reject(new Error("Review timed out after " + (timeoutMs / 1000) + "s: " + label));
        }, timeoutMs);
      }),
    ]);

    cleanup();

    const durationMs = Date.now() - startTime;
    logger.info({ label, durationMs }, "review completed: " + label + " (" + durationMs + "ms)");

    return result;
  } catch (err) {
    cleanup();

    const durationMs = Date.now() - startTime;
    logger.error({ label, durationMs, err: err.message }, "review failed: " + label + " (" + durationMs + "ms)");

    throw err;
  }
}
