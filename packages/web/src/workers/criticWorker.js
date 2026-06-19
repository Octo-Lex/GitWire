// src/workers/criticWorker.js
// Background worker for trusted CI repair proposal critic review.
//
// Processes jobs from the critic queue. Each job represents a proposal
// in verified status that needs critic assessment.
//
// The worker builds a bounded immutable review bundle from locked proposal
// state, runs a deterministic critic assessment, and records the result
// through the canonical recordCriticReview path with actor_kind: critic_worker.
//
// No GitHub API calls for mutation — operates solely on stored evidence.
// No branch creation, PR creation, or repository writes.

import { createWorker } from "../lib/queue.js";
import { reviewProposal } from "../services/criticWorkerService.js";
import { logger } from "../lib/logger.js";

export function startCriticWorker() {
  const worker = createWorker(
    "critic",
    async (job) => {
      const { proposalId, correlationId } = job.data;

      logger.info({ jobId: job.id, proposalId, correlationId }, "Processing critic review job");

      const proposal = await reviewProposal(proposalId, {
        correlation_id: correlationId,
      });

      logger.info(
        { jobId: job.id, proposalId, status: proposal.status },
        "Critic review completed"
      );

      return { proposalId, reviewRecorded: proposal.status === "review_ready" || proposal.status === "failed" };
    },
    { concurrency: 1 }
  );

  worker.on("failed", (job, err) => {
    logger.error(
      { jobId: job?.id, proposalId: job?.data?.proposalId, err: err.message },
      "Critic review job failed"
    );
  });

  return worker;
}
