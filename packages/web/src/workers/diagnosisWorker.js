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
import { getConfigForRepo } from "../services/configService.js";
import { getProposal } from "../services/repairProposalService.js";
import { patchQueue } from "../lib/queue.js";
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

      // ── Policy-gated patch generation enqueue ─────────────────────────────
      // Patch generation is NOT automatic — it requires:
      // 1. ci_healing.auto_patch policy enabled for the repo
      // 2. Diagnosis confidence meeting min_confidence_to_patch threshold
      // 3. Proposal still in evidence_collected (not cancelled/failed)
      try {
        const refreshedProposal = await getProposal(proposalId);
        if (refreshedProposal && refreshedProposal.status === "evidence_collected") {
          const config = await getConfigForRepo(refreshedProposal.repo_full_name);
          const healingConfig = config?.pillars?.ci_healing ?? config?.ci_healing;

          if (healingConfig?.auto_patch === true) {
            const minConfidence = healingConfig.min_confidence_to_patch || "medium";
            const confidenceLevels = { low: 0, medium: 1, high: 2 };
            const diagnosisConfidence = confidenceLevels[proposal.diagnosis?.confidence] ?? 0;
            const requiredConfidence = confidenceLevels[minConfidence] ?? 1;

            if (diagnosisConfidence >= requiredConfidence) {
              const patchCorrelationId = `patch-${proposalId}-${Date.now()}`;
              await patchQueue.add(
                "generate-patch",
                {
                  proposalId,
                  correlationId: patchCorrelationId,
                },
                {
                  priority: 4,
                  jobId: `patch-${proposalId}`,
                }
              );
              logger.info(
                { jobId: job.id, proposalId },
                "Patch generation enqueued (policy-gated)"
              );
            } else {
              logger.info(
                { jobId: job.id, proposalId, confidence: proposal.diagnosis?.confidence, minConfidence },
                "Patch generation skipped — diagnosis confidence below threshold"
              );
            }
          } else {
            logger.info(
              { jobId: job.id, proposalId },
              "Patch generation skipped — auto_patch policy disabled"
            );
          }
        }
      } catch (policyErr) {
        // Policy check failure should not block diagnosis completion
        logger.warn(
          { jobId: job.id, proposalId, err: policyErr.message },
          "Patch enqueue policy check failed — patch generation skipped"
        );
      }

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
