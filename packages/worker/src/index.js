// @gitwire/worker — job claim→heartbeat→complete loop
//
// Future home of the generic worker abstraction:
//   - claimJob(queue)
//   - withHeartbeat(interval, fn)
//   - withTimeout(ms, fn)
//   - graceful shutdown (SIGTERM → drain)
//
// Currently, workers are in @gitwire/web/src/workers/ using BullMQ directly.
// This package will extract the pattern once it stabilizes.

export const WORKER_CONCURRENCY = 5;
export const DEFAULT_JOB_ATTEMPTS = 3;
export const DEFAULT_BACKOFF_MS = 2000;
export const HEARTBEAT_INTERVAL_MS = 10_000;
export const SHUTDOWN_DRAIN_MS = 30_000;
