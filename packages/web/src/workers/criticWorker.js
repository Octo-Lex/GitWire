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
import { adoptWorker, workerPrincipalId } from "../services/auth/workerAdoption.js";

export function startCriticWorker() {
  const worker = createWorker(
    "critic",
    async (job) => {
      const { proposalId, correlationId } = job.data;

      // Wave 2: resolve trusted system principal for the critic worker.
      // This is a pure system worker — no installation context, no GitHub
      // mutation. The principal is resolved from the server-side constant
      // 'system:critic-worker', not from job payload.
      const adoption = await adoptWorker({
        workerId: "worker:critic",
        permission: "ai_review:create",
        resourceType: "repository",
        systemPrincipalName: "system:critic-worker",
        jobData: job.data,
      });
      const principalId = workerPrincipalId(adoption.context);

      logger.info({ jobId: job.id, proposalId, correlationId }, "Processing critic review job");

      const proposal = await reviewProposal(proposalId, {
        correlation_id: correlationId,
        principalId,
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
