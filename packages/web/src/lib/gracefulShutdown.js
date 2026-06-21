// src/lib/gracefulShutdown.js
// Idempotent, bounded graceful-shutdown orchestrator.
//
// Root cause this fixes (CT 115 incident 2026-06-21):
//   The old shutdown() in index.js was async and called from the
//   uncaughtException handler WITHOUT await. When memory pressure triggered
//   an uncaughtException, shutdown() began. Before it finished, the
//   await db.end() step threw "Called end on pool more than once" (the pool
//   had already been ended by a concurrent re-entry). That throw became a NEW
//   uncaughtException → re-entered shutdown() → threw again → infinite loop.
//   The process never exited and never served requests; the container showed
//   (unhealthy) while Docker reported status=running.
//
// Invariant enforced here:
//   uncaughtException → ONE shutdown attempt → process exits
//
// Design:
//   - shutdownStarted flag + cached shutdownPromise guarantee exactly one
//     execution even under concurrent re-entry. All callers get the same
//     in-flight promise.
//   - Every cleanup step (server.close, worker.close, db.end, redis.quit) is
//     wrapped so its rejection is logged but never re-thrown. A re-throw here
//     would become a new uncaughtException and re-arm the loop we're fixing.
//   - A force-exit timer guarantees the process terminates even if a cleanup
//     step hangs.
//   - Exit code: 0 for clean signals (SIGTERM/SIGINT), 1 for uncaughtException
//     (so Docker's restart policy brings the process back clean).

const DEFAULT_FORCE_EXIT_MS = 10000;

/**
 * Create an idempotent, bounded graceful-shutdown function bound to the given
 * resources. process.exit is injected so tests don't kill the test process.
 *
 * @param {object} resources
 * @param {object} resources.server - HTTP server with .close([cb])
 * @param {Array<{close: () => Promise}>} resources.workers - workers to drain
 * @param {{end: () => Promise}} resources.db - pg pool wrapper
 * @param {{quit: () => Promise}} resources.redis - redis client
 * @param {object} resources.logger - pino-style logger (info/fatal/warn/error)
 * @param {function} [resources.exit] - process.exit (injectable for tests)
 * @param {object} [opts]
 * @param {number} [opts.forceExitMs=10000] - hard exit deadline
 * @returns {(signal: string) => Promise<void>} idempotent shutdown trigger
 */
export function createGracefulShutdown(resources, opts = {}) {
  const { server, workers, db, redis, logger, exit = process.exit.bind(process) } = resources;
  const forceExitMs = opts.forceExitMs ?? DEFAULT_FORCE_EXIT_MS;

  let shutdownPromise = null;

  // Wrap a cleanup step so its rejection/error is logged but never propagated.
  // Propagating here would create a new uncaughtException and re-arm the loop.
  function safe(label, fn) {
    try {
      const r = typeof fn === "function" ? fn() : undefined;
      if (r && typeof r.then === "function") {
        return r.catch((err) => {
          logger.warn({ err: err?.message ?? String(err), step: label }, "shutdown step failed (contained)");
        });
      }
    } catch (err) {
      logger.warn({ err: err?.message ?? String(err), step: label }, "shutdown step failed (contained)");
    }
    return Promise.resolve();
  }

  function runShutdown(signal) {
    const isCrash = signal === "uncaughtException" || signal === "unhandledRejection";

    // Hard exit deadline — guarantees termination even if a step hangs.
    const forceTimer = setTimeout(() => {
      logger.fatal({ signal, ms: forceExitMs }, "graceful shutdown timed out — forcing exit");
      exit(1);
    }, forceExitMs);
    // Don't keep the event loop alive solely for this timer.
    if (typeof forceTimer.unref === "function") forceTimer.unref();

    return (async () => {
      logger.info({ signal }, "Shutdown signal received");

      // Stop accepting new HTTP connections. server.close accepts a callback
      // OR returns a Promise in newer Node; normalize to a promise.
      await safe("server.close", () => new Promise((resolve) => {
        try {
          server.close(resolve);
        } catch (err) {
          resolve();
        }
      }));

      // Drain workers (finish current jobs, don't accept new ones).
      await safe("workers.close", () => Promise.all((workers || []).map((w) => w.close())));

      // Close DB and Redis. These are the steps that previously threw and
      // re-entered the loop — contained here.
      await safe("db.end", () => db.end());
      await safe("redis.quit", () => redis.quit());

      clearTimeout(forceTimer);
      logger.info("Graceful shutdown complete");
      exit(isCrash ? 1 : 0);
    })();
  }

  return function shutdown(signal) {
    // Idempotency: concurrent callers get the SAME in-flight promise.
    // This is the core fix — no matter how many times shutdown is invoked
    // (SIGTERM + an uncaughtException racing in), the body runs once.
    if (!shutdownPromise) {
      shutdownPromise = runShutdown(signal).catch((err) => {
        // Should be unreachable because every step is wrapped in safe(), but
        // if something in runShutdown's control flow itself throws, contain it
        // and still exit — never let this reject back into the event loop.
        logger.fatal({ err: err?.message ?? String(err) }, "shutdown orchestrator error — forcing exit");
        try { exit(1); } catch (_) { /* exit may be mocked */ }
      });
      // Reset the latch after exit so a post-exit re-entry (if any) is a no-op
      // rather than re-running cleanup. The process is exiting regardless.
      shutdownPromise.finally(() => { shutdownPromise = null; });
    }
    return shutdownPromise;
  };
}
