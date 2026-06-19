// src/workers/verificationWorker.js
// Background worker for trusted CI repair patch verification.
//
// Processes jobs from the verification queue. Each job represents a proposal
// in proposed status with a patch_proposal that needs sandbox verification.
//
// The worker resolves the durable patch artifact, builds a validation plan
// from the task envelope, runs bounded validations in a sandbox, and records
// the result through the canonical recordVerificationResult path with
// actor_kind: verification_worker.
//
// No GitHub API calls for mutation — operates solely on stored evidence.
// No branch creation, PR creation, or repository writes.
// No network access from the sandbox.

import { createWorker } from "../lib/queue.js";
import { verifyProposal } from "../services/verificationWorkerService.js";
import { logger } from "../lib/logger.js";

export function startVerificationWorker() {
  const worker = createWorker(
    "verification",
    async (job) => {
      const { proposalId, correlationId } = job.data;

      logger.info({ jobId: job.id, proposalId, correlationId }, "Processing verification job");

      const proposal = await verifyProposal(proposalId, {
        correlation_id: correlationId,
      });

      logger.info(
        { jobId: job.id, proposalId, status: proposal.status },
        "Verification completed"
      );

      return { proposalId, verificationRecorded: proposal.status === "verified" || proposal.status === "failed" };
    },
    { concurrency: 1 }
  );

  worker.on("failed", (job, err) => {
    logger.error(
      { jobId: job?.id, proposalId: job?.data?.proposalId, err: err.message },
      "Verification job failed"
    );
  });

  return worker;
}
