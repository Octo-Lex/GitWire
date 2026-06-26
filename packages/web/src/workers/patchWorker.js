// src/workers/patchWorker.js
// Background worker for trusted CI repair patch generation.
//
// Processes jobs from the patch queue. Each job represents a proposal
// in evidence_collected status with a diagnosis that needs a patch proposal.
//
// The worker reads the proposal's immutable evidence + diagnosis, generates
// a candidate patch through the deterministic engine, and records it through
// the canonical recordPatchProposal path with actor_kind: patch_worker.
//
// After a patch is proposed, the worker enqueues a verification job.
//
// No GitHub API calls for mutation — operates solely on stored evidence.
// No branch creation, PR creation, or repository writes.

import { createWorker } from "../lib/queue.js";
import { verificationQueue } from "../lib/queue.js";
import { generatePatchForProposal } from "../services/patchWorkerService.js";
import { logger } from "../lib/logger.js";

export function startPatchWorker() {
  const worker = createWorker(
    "patch",
    async (job) => {
      const { proposalId, correlationId } = job.data;

      logger.info({ jobId: job.id, proposalId, correlationId }, "Processing patch generation job");

      const proposal = await generatePatchForProposal(proposalId, {
        correlation_id: correlationId,
      });

      logger.info(
        { jobId: job.id, proposalId, status: proposal.status },
        "Patch generation completed"
      );

      // ── Enqueue verification after patch is proposed ─────────────────────
      if (proposal.status === "proposed") {
        const verificationCorrelationId = `verify-${proposalId}-${Date.now()}`;
        await verificationQueue.add(
          "verify-proposal",
          {
            proposalId,
            correlationId: verificationCorrelationId,
          },
          {
            priority: 5,
            jobId: `verify-${proposalId}`,
          }
        );
        logger.info(
          { jobId: job.id, proposalId },
          "Verification enqueued after patch proposed"
        );
      }

      return { proposalId, patchRecorded: proposal.status === "proposed" };
    },
    { concurrency: 1 }
  );

  worker.on("failed", (job, err) => {
    logger.error(
      { jobId: job?.id, proposalId: job?.data?.proposalId, err: err.message },
      "Patch generation job failed"
    );
  });

  return worker;
}
