// src/services/triageStatusService.js
// Shared, time-bounded BullMQ inspection for the triage workflow.
//
// Used by both the operator API (routes/triageOperations.js) and the anonymous
// /health endpoint so the queue-inspection logic is not duplicated.
//
// All reads are time-bounded (default 2s) so a Redis stall degrades the status
// to "unknown" rather than hanging /health or the API.

import { triageQueue } from "../lib/queue.js";
import { logger } from "../lib/logger.js";

const DEFAULT_TIMEOUT_MS = 2000;
const MAX_FAILURES_TO_INSPECT = 500;

/**
 * Read triage queue counts with a bounded timeout.
 *
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs=2000]
 * @returns {Promise<{
 *   ok: boolean,
 *   timedOut: boolean,
 *   failedCount: number,
 *   activeCount: number,
 *   waitingCount: number,
 *   failedJobs?: object[],
 * }>}
 */
export async function readTriageQueue(opts = {}) {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timedOut = Symbol("timedOut");

  const probe = (async () => {
    const [failed, active, waiting] = await Promise.all([
      triageQueue.getFailed(0, MAX_FAILURES_TO_INSPECT),
      triageQueue.getActive(0, 100),
      triageQueue.getWaiting(0, 100),
    ]);
    return { failed, active, waiting };
  })();

  const result = await Promise.race([
    probe,
    new Promise((resolve) => setTimeout(() => resolve(timedOut), timeoutMs)),
  ]);

  if (result === timedOut) {
    return { ok: false, timedOut: true, failedCount: 0, activeCount: 0, waitingCount: 0 };
  }

  return {
    ok: true,
    timedOut: false,
    failedCount: result.failed.length,
    activeCount: result.active.length,
    waitingCount: result.waiting.length,
    failedJobs: result.failed,
  };
}

/**
 * Derive a coarse status from queue counts.
 *
 * @returns {"healthy"|"degraded"|"unknown"}
 */
export function classifyTriageStatus(queueRead) {
  if (!queueRead.ok) return "unknown";
  return queueRead.failedCount > 0 ? "degraded" : "healthy";
}

/**
 * Build the sanitized operator-facing status summary.
 */
export async function getTriageStatusSummary(opts = {}) {
  const queueRead = await readTriageQueue(opts);
  const status = classifyTriageStatus(queueRead);

  // Derive oldest failure timestamp from retained job data
  let oldestFailureAt = null;
  if (queueRead.ok && queueRead.failedJobs && queueRead.failedJobs.length > 0) {
    const timestamps = queueRead.failedJobs
      .map((j) => j?.data?.gitwireFailure?.firstFailedAt ?? j?.finishedOn ?? j?.timestamp)
      .map(toMillis)
      .filter((t) => t !== null && Number.isFinite(t));
    if (timestamps.length > 0) {
      oldestFailureAt = new Date(Math.min(...timestamps)).toISOString();
    }
  }

  return {
    status,
    failed_count: queueRead.ok ? queueRead.failedCount : 0,
    active_count: queueRead.ok ? queueRead.activeCount : 0,
    waiting_count: queueRead.ok ? queueRead.waitingCount : 0,
    oldest_failure_at: oldestFailureAt,
    last_success_at: null, // BullMQ doesn't retain completed-job timestamps cheaply
  };
}

/**
 * Build the coarse, anonymous-safe workflow block for /health.
 * Returns only counts + status — never repository names, issue numbers, or errors.
 */
export async function getTriageHealthBlock(opts = {}) {
  const queueRead = await readTriageQueue(opts);
  const status = classifyTriageStatus(queueRead);

  let oldestFailureAt = null;
  if (queueRead.ok && queueRead.failedCount > 0 && queueRead.failedJobs) {
    const timestamps = queueRead.failedJobs
      .map((j) => j?.data?.gitwireFailure?.firstFailedAt ?? j?.finishedOn ?? j?.timestamp)
      .map(toMillis)
      .filter((t) => t !== null && Number.isFinite(t));
    if (timestamps.length > 0) {
      oldestFailureAt = new Date(Math.min(...timestamps)).toISOString();
    }
  }

  return {
    status,
    failed_count: queueRead.ok ? queueRead.failedCount : 0,
    oldest_failure_at: oldestFailureAt,
  };
}

// Convert a value (ISO string, epoch millis, or Date) to epoch millis.
function toMillis(v) {
  if (v == null) return null;
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const parsed = Date.parse(v);
    return Number.isNaN(parsed) ? null : parsed;
  }
  if (v instanceof Date) return v.getTime();
  return null;
}

/**
 * Sanitize a single failed BullMQ job for the operator-facing failure list.
 * Returns ONLY the safe fields — never raw payloads, headers, or stack traces.
 */
export function sanitizeFailedJob(job) {
  if (!job) return null;
  const f = job.data?.gitwireFailure ?? {};
  const payload = job.data?.payload ?? {};
  const repo = payload.repository?.full_name ?? null;
  const targetType = payload.pull_request ? "pr" : "issue";
  const targetNumber = payload.pull_request?.number ?? payload.issue?.number ?? null;

  return {
    job_id: String(job.id),
    job_name: job.name ?? null,
    repository: repo,
    target_type: targetType,
    target_number: targetNumber,
    failure_class: f.failureClass ?? "unknown",
    safe_message: f.safeMessage ?? "failure metadata unavailable",
    failed_at: f.firstFailedAt ?? (job.finishedOn ? new Date(job.finishedOn).toISOString() : null),
    attempts: f.attempts ?? job.attempts ?? 1,
    retryable_now: f.retryable !== false,
  };
}
