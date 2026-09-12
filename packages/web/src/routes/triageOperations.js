// src/routes/triageOperations.js
// Operator API for triage failure visibility, disposition, and safe retry.
//
// Endpoints (all behind apiKeyAuth + authContext):
//   GET  /api/triage/status              — coarse health summary
//   GET  /api/triage/failures            — sanitized failed-job list (+ disposition filter)
//   POST /api/triage/failures/:jobId/disposition — set disposition state + reason
//   POST /api/triage/failures/:jobId/retry — requeue a failed job against its CURRENT target
//
// The worker remains the final race arbiter. This route does not attempt to
// make the retry itself race-free; it only preflight-checks the completion
// marker and requeues. The worker's beginOperation() does the authoritative
// complete-check-and-acquire atomically.
//
// TD-01: a retained failure is actionable only while its disposition is
// "unresolved". Retry operates on the target's CURRENT GitHub state — never
// a stale retained webhook payload.

import { Router } from "express";
import { triageQueue } from "../lib/queue.js";
import { logger } from "../lib/logger.js";
import { authorize } from "../services/auth/authorize.js";
import { logDecision } from "../services/decisionLogService.js";
import {
  DISPOSITION_STATES,
  applyTriageDisposition,
  getTriageStatusSummary,
  readTriageQueue,
  readDisposition,
  sanitizeFailedJob,
} from "../services/triageStatusService.js";
import { isOperationComplete, buildTriageOperationKey } from "../services/idempotencyService.js";
import { getInstallationClient } from "../lib/github.js";
import { wrapOctokit } from "../lib/githubWrapper.js";

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
    const dispositionFilter =
      typeof req.query.disposition === "string" && DISPOSITION_STATES.includes(req.query.disposition)
        ? req.query.disposition
        : null;

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
    // Apply disposition filter if provided (default: all)
    if (dispositionFilter) {
      jobs = jobs.filter((j) => readDisposition(j?.data).state === dispositionFilter);
    }
    // Sanitize + limit
    const sanitized = jobs.slice(0, limit).map(sanitizeFailedJob).filter(Boolean);

    res.json({
      data: sanitized,
      meta: {
        total: queueRead.failedCount,
        limit,
        filtered: repoFilter || dispositionFilter ? sanitized.length : null,
      },
    });
  } catch (err) {
    logger.warn({ err: err.message }, "/api/triage/failures: read failed");
    res.status(503).json({ error: "Queue status unavailable" });
  }
});

// ── POST /api/triage/failures/:jobId/disposition ────────────────────────────
triageOperationsRouter.post("/failures/:jobId/disposition", async (req, res, next) => {
  try {
    const { jobId } = req.params;
    const state = typeof req.body?.state === "string" ? req.body.state : "";
    const reason = typeof req.body?.reason === "string" ? req.body.reason.trim() : "";

    if (!DISPOSITION_STATES.includes(state)) {
      return res.status(400).json({
        error: `state must be one of: ${DISPOSITION_STATES.join(", ")}`,
      });
    }
    if (!reason || reason.length < 3) {
      return res.status(400).json({ error: "A meaningful reason (>= 3 chars) is required" });
    }

    // Actor comes from the server-derived principal, never from the request body.
    const principalId = req.auth?.principalId ?? "unknown";

    // Load the failed job (same gate as retry)
    const job = await triageQueue.getJob(jobId);
    if (!job) {
      return res.status(404).json({ error: "Job not found" });
    }
    if (job.queueName !== "triage" && job.queueName !== undefined) {
      return res.status(404).json({ error: "Job not found" });
    }
    if (job.failedReason === undefined && job.finishedOn === null) {
      return res.status(409).json({ error: "Job is not in failed state" });
    }

    const payload = job.data?.payload;
    const repository = payload?.repository;
    const isPR = !!payload?.pull_request;
    const target = isPR ? payload?.pull_request : payload?.issue;
    if (!repository || !target) {
      return res.status(422).json({ error: "Unusable historical payload — missing repository or target" });
    }

    // Repository-scoped authorization (same gate as retry)
    if (!repository.id || !payload.installation?.id) {
      return res.status(422).json({ error: "Unusable historical payload — missing authoritative installation or repository IDs for authorization" });
    }
    const decision = await authorize({
      principal: req.auth,
      permission: "repository:update",
      resource: {
        type: "repository",
        installationId: payload.installation.id,
        repositoryId: repository.id,
      },
    });
    if (!decision.allowed) {
      return res.status(403).json({
        error: "Forbidden",
        code: decision.code,
      });
    }

    // Persist the disposition on the retained job data; the BullMQ failure
    // is never deleted. Every mutation is audited via applyTriageDisposition.
    const disposition = await applyTriageDisposition(job, {
      state,
      reason,
      principalId,
      target: {
        repoId: repository.id,
        targetType: isPR ? "pr" : "issue",
        targetNumber: target.number ?? null,
        repoFullName: repository.full_name ?? null,
      },
    });

    logger.info({ jobId, principalId, state, reason, repo: repository.full_name, target: target.number }, "Triage failure dispositioned");
    res.json({ jobId, disposition });
  } catch (err) {
    if (err?.message?.startsWith("Invalid disposition state") || err?.message?.includes("meaningful reason")) {
      return res.status(400).json({ error: err.message });
    }
    logger.error({ err: err.message, path: req.path }, "triage disposition: unhandled error");
    res.status(500).json({ error: "Internal server error" });
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

    // Derive the operation identity from the retained payload
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

    // TD-01: only unresolved failures may be retried. recovered, superseded,
    // and dismissed are closed; reopen explicitly via the disposition endpoint.
    const priorDisposition = readDisposition(job.data);
    if (priorDisposition.state !== "unresolved") {
      return res.status(409).json({
        error: `Failure is disposed as ${priorDisposition.state} — reopen it via the disposition endpoint before retrying`,
      });
    }

    // Enforce repository-scoped authorization before allowing the retry.
    // authContext is observe-only (Wave 2); the central authorize() service
    // is the gate. Requires server-owned installationId + repositoryId.
    // OA-01: canonical repository:update — the bootstrap admin and legacy-key
    // roles grant it; issue:update is granted by no canonical role.
    if (!repository.id || !payload.installation?.id) {
      return res.status(422).json({ error: "Unusable historical payload — missing authoritative installation or repository IDs for authorization" });
    }
    const decision = await authorize({
      principal: req.auth,
      permission: "repository:update",
      resource: {
        type: "repository",
        installationId: payload.installation.id,
        repositoryId: repository.id,
      },
    });
    if (!decision.allowed) {
      return res.status(403).json({
        error: "Forbidden",
        code: decision.code,
      });
    }

    // ── TD-01: operate on the target's CURRENT GitHub state ────────────────
    // Retained payloads grow stale; a weeks-old issue/PR snapshot must not
    // drive mutations. Re-read the live target before requeueing.
    const owner = repository.owner?.login ?? repository.full_name?.split("/")[0];
    const repoName = repository.name ?? repository.full_name?.split("/")[1];
    if (!owner || !repoName || !target.number) {
      return res.status(422).json({ error: "Unusable historical payload — cannot address target on GitHub" });
    }

    let octokit;
    try {
      octokit = wrapOctokit(await getInstallationClient(payload.installation.id));
    } catch (err) {
      logger.warn({ err: err.message, installationId: payload.installation.id }, "Triage retry: installation client unavailable");
      return res.status(503).json({ error: "GitHub installation client unavailable — disposition left unresolved" });
    }

    let currentTarget;
    try {
      if (isPR) {
        const { data } = await octokit.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
          owner, repo: repoName, pull_number: target.number,
        });
        currentTarget = data;
      } else {
        const { data } = await octokit.request("GET /repos/{owner}/{repo}/issues/{issue_number}", {
          owner, repo: repoName, issue_number: target.number,
        });
        currentTarget = data;
      }
    } catch (err) {
      if (err?.status === 404) {
        // Deterministically established: the target no longer exists, so the
        // historical operation is obsolete.
        const disposition = await applyTriageDisposition(job, {
          state: "superseded",
          reason: `Target no longer exists on GitHub at retry time (${repository.full_name} #${target.number})`,
          principalId,
          target: {
            repoId: repository.id,
            targetType: isPR ? "pr" : "issue",
            targetNumber: target.number,
            repoFullName: repository.full_name ?? null,
          },
        });
        logger.info({ jobId, repo: repository.full_name, target: target.number }, "Triage retry: target deleted — superseded");
        return res.json({ queued: false, superseded: true, disposition });
      }
      // Any other read failure is operational: the disposition stays
      // unresolved and the operator sees an error.
      logger.warn({ err: err.message, jobId }, "Triage retry: current-target read failed");
      return res.status(503).json({ error: "GitHub target read failed — disposition left unresolved" });
    }

    // Closed or merged targets make the historical operation obsolete.
    const closedOrMerged = isPR
      ? (currentTarget.state !== "open" || currentTarget.merged === true)
      : currentTarget.state !== "open";
    if (closedOrMerged) {
      const why = isPR && currentTarget.merged === true ? "merged" : "closed";
      const disposition = await applyTriageDisposition(job, {
        state: "superseded",
        reason: `Target ${why} on GitHub at retry time (${repository.full_name} #${target.number})`,
        principalId,
        target: {
          repoId: repository.id,
          targetType: isPR ? "pr" : "issue",
          targetNumber: target.number,
          repoFullName: repository.full_name ?? null,
        },
      });
      logger.info({ jobId, repo: repository.full_name, target: target.number, why }, "Triage retry: target not actionable — superseded");
      return res.json({ queued: false, superseded: true, disposition });
    }

    // Target still actionable: replace the retained target object with the
    // freshly read GitHub object before requeueing, so the worker consumes
    // current state (title, body, labels, state, PR diff stats).
    const freshPayload = {
      ...payload,
      [isPR ? "pull_request" : "issue"]: currentTarget,
    };
    try {
      await job.updateData({ ...job.data, payload: freshPayload });
    } catch (updateErr) {
      logger.warn({ err: updateErr.message || updateErr, jobId }, "Triage retry: payload refresh failed");
      return res.status(503).json({ error: "Queue unavailable — could not refresh target payload" });
    }

    const operationKey = buildTriageOperationKey({
      targetType: isPR ? "pr" : "issue",
      repoId: repository.id ?? repository.full_name,
      targetId: currentTarget.id ?? currentTarget.number,
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
          { check: "current_target_reread", result: "open" },
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

    logger.info({ jobId, principalId, repo: repoFullName, target: targetNumber, reason }, "Triage job manually retried against current target");
    res.status(202).json({
      queued: true,
      jobId,
      message: "Retry queued against the target's current GitHub state — the worker will re-check the completion marker before processing",
    });
  } catch (err) {
    logger.error({ err: err.message, path: req.path }, "triage retry: unhandled error");
    res.status(500).json({ error: "Internal server error" });
  }
});
