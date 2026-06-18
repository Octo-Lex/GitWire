// src/workers/diagnosisWorker.js
// Background worker for trusted CI repair diagnosis.
//
// Processes jobs from the diagnosis queue. Each job represents a proposal
// in `evidence_collected` status that needs a structured diagnosis.
//
// The worker reads the proposal's immutable evidence_refs, produces a
// diagnosis through the deterministic engine, and attaches it through
// the authorized service path with actor_kind: diagnosis_worker.
//
// No GitHub API calls — operates solely on stored evidence.

import { createWorker } from "../lib/queue.js";
import { diagnoseProposal } from "../services/diagnosisWorkerService.js";
import { logger } from "../lib/logger.js";

export function startDiagnosisWorker() {
  const worker = createWorker(
    "diagnosis",
    async (job) => {
      const { proposalId, correlationId } = job.data;

      logger.info({ jobId: job.id, proposalId, correlationId }, "Processing diagnosis job");

      const proposal = await diagnoseProposal(proposalId, {
        correlation_id: correlationId,
      });

      logger.info(
        { jobId: job.id, proposalId, category: proposal.diagnosis?.failure_category },
        "Diagnosis completed"
      );

      return { proposalId, diagnosisAttached: true };
    },
    { concurrency: 1 }
  );

  worker.on("failed", (job, err) => {
    logger.error(
      { jobId: job?.id, proposalId: job?.data?.proposalId, err: err.message },
      "Diagnosis job failed"
    );
  });

  return worker;
}
