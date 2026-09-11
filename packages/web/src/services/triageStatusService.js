// src/services/triageStatusService.js
// Shared, time-bounded BullMQ inspection for the triage workflow.
//
// Used by both the operator API (routes/triageOperations.js) and the anonymous
// /health endpoint so the queue-inspection logic is not duplicated.
//
// All reads are time-bounded (default 2s) so a Redis stall degrades the status
// to "unknown" rather than hanging /health or the API.
//
// TD-01: failed jobs carry an optional gitwireDisposition block
// ({ state, reason, principalId, at }) written through the operator API.
// Absent or malformed metadata means "unresolved" — the fail-safe default,
// so the historical backlog degrades health until it is explicitly disposed.

import { triageQueue } from "../lib/queue.js";
import { logger } from "../lib/logger.js";
import { logDecision } from "./decisionLogService.js";

const DEFAULT_TIMEOUT_MS = 2000;
const MAX_FAILURES_TO_INSPECT = 500;

export const DISPOSITION_STATES = ["unresolved", "recovered", "superseded", "dismissed"];
const DISPOSITION_STATE_SET = new Set(DISPOSITION_STATES);

/**
 * Read a failed job's disposition. Absent or malformed metadata resolves to
 * the fail-safe default { state: "unresolved" }.
 *
 * @param {object} jobData - the BullMQ job's data object
 * @returns {{ state: string, reason: string|null, principalId: string|null, at: string|null }}
 */
export function readDisposition(jobData) {
  const d = jobData?.gitwireDisposition;
  if (!d || typeof d !== "object" || !DISPOSITION_STATE_SET.has(d.state)) {
    return { state: "unresolved", reason: null, principalId: null, at: null };
  }
  return {
    state: d.state,
    reason: typeof d.reason === "string" ? d.reason : null,
    principalId: typeof d.principalId === "string" ? d.principalId : null,
    at: typeof d.at === "string" ? d.at : null,
  };
}

/**
 * Whether a failed job still requires operator attention (health-degrading).
 */
export function isActionable(jobData) {
  return readDisposition(jobData).state === "unresolved";
}

/**
 * Write a disposition onto a failed job's retained data and record the
 * operator evidence through the immutable decision log. Shared by the
 * operator API and the backlog census — never bypass this shape.
 *
 * @param {object} job - a BullMQ Job from the triage queue's failed set
 * @param {{ state: string, reason: string, principalId: string, target?: object }} input
 *   target (optional) carries { repoId, targetType, targetNumber, repoFullName }
 *   for decision-log attribution.
 * @returns {Promise<{ state: string, reason: string, principalId: string, at: string }>}
 */
export async function applyTriageDisposition(job, input) {
  if (!DISPOSITION_STATE_SET.has(input.state)) {
    throw new Error(`Invalid disposition state: ${input.state}`);
  }
  if (typeof input.reason !== "string" || input.reason.trim().length < 3) {
    throw new Error("A meaningful reason (>= 3 chars) is required");
  }
  const disposition = {
    state: input.state,
    reason: input.reason.trim(),
    principalId: typeof input.principalId === "string" ? input.principalId : "unknown",
    at: new Date().toISOString(),
  };
  const priorState = readDisposition(job.data).state;
  await job.updateData({ ...job.data, gitwireDisposition: disposition });

  const t = input.target ?? {};
  try {
    await logDecision({
      repoId: t.repoId ?? null,
      source: "triage-disposition",
      triggerEvent: "manual-disposition",
      targetType: t.targetType ?? null,
      targetNumber: t.targetNumber ?? null,
      pillar: "triage",
      decision: `disposition-${disposition.state}`,
      reason: disposition.reason,
      conditions: [
        { check: "job_failed", result: true },
        { check: "prior_state", result: priorState },
      ],
      principalId: disposition.principalId,
      actor: disposition.principalId,
    });
  } catch (logErr) {
    // The disposition itself persisted; the audit entry is best-effort but
    // failures are logged loudly, never silently swallowed.
    logger.warn({ err: logErr.message || logErr }, "Failed to record triage disposition decision");
  }
  return disposition;
}

/**
 * Aggregate actionable/disposed counts over a queue read.
 *
 * The per-job inspection window is bounded (MAX_FAILURES_TO_INSPECT); the
 * total failed count is not. Failures beyond the inspected window count as
 * actionable — absence of inspected metadata must never read as healthy.
 *
 * @returns {{ actionable: number, disposed: number, inspected: number, uninspected: number, oldestActionableAt: string|null }}
 */
export function aggregateDispositions(queueRead) {
  const jobs = queueRead.ok ? (queueRead.failedJobs ?? []) : [];
  const total = queueRead.ok ? queueRead.failedCount : 0;
  let actionableInWindow = 0;
  let oldestActionableMs = null;
  for (const j of jobs) {
    if (!isActionable(j?.data)) continue;
    actionableInWindow++;
    const ts = toMillis(j?.data?.gitwireFailure?.firstFailedAt ?? j?.finishedOn ?? j?.timestamp);
    if (ts !== null && Number.isFinite(ts) && (oldestActionableMs === null || ts < oldestActionableMs)) {
      oldestActionableMs = ts;
    }
  }
  const uninspected = Math.max(0, total - jobs.length);
  return {
    actionable: actionableInWindow + uninspected,
    disposed: Math.max(0, total - actionableInWindow - uninspected),
    inspected: jobs.length,
    uninspected,
    oldestActionableAt: oldestActionableMs !== null ? new Date(oldestActionableMs).toISOString() : null,
  };
}

/**
 * Read triage queue counts with a bounded timeout.
 *
 * The true failed total comes from getJobCounts() when available; the per-job
 * window (failedJobs) remains bounded by MAX_FAILURES_TO_INSPECT.
 */
export async function readTriageQueue(opts = {}) {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timedOut = Symbol("timedOut");

  const probe = (async () => {
    const [failed, active, waiting, counts] = await Promise.all([
      triageQueue.getFailed(0, MAX_FAILURES_TO_INSPECT),
      triageQueue.getActive(0, 100),
      triageQueue.getWaiting(0, 100),
      Promise.resolve(
        typeof triageQueue.getJobCounts === "function"
          ? triageQueue.getJobCounts("failed", "active", "waiting")
          : null,
      ).catch(() => null),
    ]);
    return { failed, active, waiting, counts };
  })();

  const result = await Promise.race([
    probe,
    new Promise((resolve) => setTimeout(() => resolve(timedOut), timeoutMs)),
  ]);

  if (result === timedOut) {
    return { ok: false, timedOut: true, failedCount: 0, activeCount: 0, waitingCount: 0 };
  }

  const { failed, active, waiting, counts } = result;
  return {
    ok: true,
    timedOut: false,
    // True retained total when the counter is available; the bounded window
    // length is the fallback.
    failedCount: Number.isFinite(counts?.failed) ? counts.failed : failed.length,
    activeCount: Number.isFinite(counts?.active) ? counts.active : active.length,
    waitingCount: Number.isFinite(counts?.waiting) ? counts.waiting : waiting.length,
    failedJobs: failed,
  };
}

/**
 * Derive a coarse status from queue counts: degraded only when failures are
 * actionable (unresolved), including the fail-safe count for failures beyond
 * the inspected window.
 *
 * @returns {"healthy"|"degraded"|"unknown"}
 */
export function classifyTriageStatus(queueRead) {
  if (!queueRead.ok) return "unknown";
  return aggregateDispositions(queueRead).actionable > 0 ? "degraded" : "healthy";
}

/**
 * Build the sanitized operator-facing status summary.
 */
export async function getTriageStatusSummary(opts = {}) {
  const queueRead = await readTriageQueue(opts);
  const status = classifyTriageStatus(queueRead);
  const agg = aggregateDispositions(queueRead);

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
    actionable_failed_count: queueRead.ok ? agg.actionable : 0,
    disposed_failed_count: queueRead.ok ? agg.disposed : 0,
    active_count: queueRead.ok ? queueRead.activeCount : 0,
    waiting_count: queueRead.ok ? queueRead.waitingCount : 0,
    oldest_failure_at: oldestFailureAt,
    oldest_actionable_failure_at: agg.oldestActionableAt,
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
  const agg = aggregateDispositions(queueRead);

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
    actionable_failed_count: queueRead.ok ? agg.actionable : 0,
    disposed_failed_count: queueRead.ok ? agg.disposed : 0,
    oldest_failure_at: oldestFailureAt,
    oldest_actionable_failure_at: agg.oldestActionableAt,
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
  const d = readDisposition(job.data);

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
    retryable_now: f.retryable !== false && d.state === "unresolved",
    disposition: { state: d.state, reason: d.reason, at: d.at },
  };
}
