// src/routes/triageOperations.js
// Operator API for triage failure visibility and safe retry.
//
// Endpoints (all behind apiKeyAuth + authContext):
//   GET  /api/triage/status              — coarse health summary
//   GET  /api/triage/failures            — sanitized failed-job list
//   POST /api/triage/failures/:jobId/retry — requeue a failed job
//
// The worker remains the final race arbiter. This route does not attempt to
// make the retry itself race-free; it only preflight-checks the completion
// marker and requeues. The worker's beginOperation() does the authoritative
// complete-check-and-acquire atomically.

import { Router } from "express";
import { triageQueue } from "../lib/queue.js";
import { logger } from "../lib/logger.js";
import { logDecision } from "../services/decisionLogService.js";
import {
  getTriageStatusSummary,
  readTriageQueue,
  sanitizeFailedJob,
} from "../services/triageStatusService.js";
import { isOperationComplete, buildTriageOperationKey } from "../services/idempotencyService.js";

export const triageOperationsRouter = Router();

// ── GET /api/triage/status ───────────────────────────────────────────────────
triageOperationsRouter.get("/status", async (_req, res, next) => {
  try {
    const summary = await getTriageStatusSummary({ timeoutMs: 2000 });
    res.json(summary);
  } catch (err) {
    logger.warn({ err: err.message }, "/api/triage/status: queue read failed");
    res.status(503).json({ status: "unknown", error: "Queue status unavailable" });
  }
});

// ── GET /api/triage/failures ─────────────────────────────────────────────────
triageOperationsRouter.get("/failures", async (req, res, next) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 500);
    const repoFilter = typeof req.query.repo === "string" ? req.query.repo : null;

    const queueRead = await readTriageQueue({ timeoutMs: 2000 });
    if (!queueRead.ok) {
      return res.status(503).json({ error: "Queue status unavailable" });
    }

    let jobs = queueRead.failedJobs ?? [];
    // Apply repo filter if provided
    if (repoFilter) {
      jobs = jobs.filter((j) => {
        const fr = j?.data?.payload?.repository?.full_name;
        return fr === repoFilter;
      });
    }
    // Sanitize + limit
    const sanitized = jobs.slice(0, limit).map(sanitizeFailedJob).filter(Boolean);

    res.json({
      data: sanitized,
      meta: { total: queueRead.failedCount, limit, filtered: repoFilter ? sanitized.length : null },
    });
  } catch (err) {
    logger.warn({ err: err.message }, "/api/triage/failures: read failed");
    res.status(503).json({ error: "Queue status unavailable" });
  }
});

// ── POST /api/triage/failures/:jobId/retry ──────────────────────────────────
triageOperationsRouter.post("/failures/:jobId/retry", async (req, res, next) => {
  try {
    const { jobId } = req.params;
    const reason = typeof req.body?.reason === "string" ? req.body.reason.trim() : "";

    if (!reason || reason.length < 3) {
      return res.status(400).json({ error: "A meaningful reason (>= 3 chars) is required" });
    }

    // Actor comes from the server-derived principal, never from the request body.
    const principalId = req.auth?.principalId ?? "unknown";

    // Load the failed job
    const job = await triageQueue.getJob(jobId);
    if (!job) {
      return res.status(404).json({ error: "Job not found" });
    }

    // Confirm the job belongs to the triage queue
    if (job.queueName !== "triage" && job.queueName !== undefined) {
      return res.status(404).json({ error: "Job not found" });
    }

    // Confirm the job is in failed state
    if (job.failedReason === undefined && job.finishedOn === null) {
      // Not a failed job — could be active/waiting/completed
      return res.status(409).json({ error: "Job is not in failed state" });
    }

    // Derive the operation key from the retained payload
    const payload = job.data?.payload;
    if (!payload) {
      return res.status(422).json({ error: "Unusable historical payload — no webhook data retained" });
    }
    const repository = payload.repository;
    const isPR = !!payload.pull_request;
    const target = isPR ? payload.pull_request : payload.issue;
    if (!repository || !target) {
      return res.status(422).json({ error: "Unusable historical payload — missing repository or target" });
    }

    const operationKey = buildTriageOperationKey({
      targetType: isPR ? "pr" : "issue",
      repoId: repository.id ?? repository.full_name,
      targetId: target.id ?? target.number,
      action: payload.action || "opened",
    });

    // Preflight: check completion marker. If already complete, 409.
    let alreadyComplete = false;
    try {
      alreadyComplete = await isOperationComplete("triage", operationKey);
    } catch (err) {
      // Idempotency store unavailable — surface as 503
      return res.status(503).json({ error: "Idempotency store unavailable — cannot verify completion" });
    }
    if (alreadyComplete) {
      return res.status(409).json({ error: "Operation already complete" });
    }

    // Record the retry actor + reason through the existing decision/audit log.
    const repoFullName = repository.full_name ?? null;
    const targetNumber = target.number ?? null;
    const failureClass = job.data?.gitwireFailure?.failureClass ?? "unknown";
    try {
      await logDecision({
        repoId: repository.id,
        source: "triage-retry",
        triggerEvent: "manual-retry",
        targetType: isPR ? "pr" : "issue",
        targetNumber,
        pillar: "triage",
        decision: "retry-queued",
        reason: `Manual retry: ${reason} (prior failure: ${failureClass})`,
        conditions: [
          { check: "job_failed", result: true },
          { check: "completion_marker", result: alreadyComplete },
        ],
        principalId,
        actor: principalId,
      });
    } catch (logErr) {
      logger.warn({ err: logErr.message || logErr }, "Failed to record triage retry decision");
    }

    // Requeue the BullMQ job. The worker remains the final race arbiter —
    // its beginOperation() will atomically re-check the completion marker.
    try {
      await job.retry();
    } catch (retryErr) {
      logger.error({ err: retryErr.message || retryErr, jobId }, "Failed to retry triage job");
      return res.status(503).json({ error: "Queue unavailable — could not requeue job" });
    }

    logger.info({ jobId, principalId, repo: repoFullName, target: targetNumber, reason }, "Triage job manually retried");
    res.status(202).json({
      queued: true,
      jobId,
      message: "Retry queued — the worker will re-check the completion marker before processing",
    });
  } catch (err) {
    logger.error({ err: err.message, path: req.path }, "triage retry: unhandled error");
    res.status(500).json({ error: "Internal server error" });
  }
});
