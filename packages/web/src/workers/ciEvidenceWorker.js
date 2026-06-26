// src/workers/ciEvidenceWorker.js
// Background worker for trusted CI evidence collection.
//
// Processes jobs from the ci-evidence queue. Each job represents a failed
// GitHub Actions workflow run that needs bounded evidence collection.
//
// The worker reconstructs the webhook payload context, gets an authenticated
// GitHub API client, and runs the collection pipeline.

import { createWorker } from "../lib/queue.js";
import { getInstallationClient } from "../lib/github.js";
import { wrapOctokit } from "../lib/githubWrapper.js";
import { collectForFailedRun } from "../services/ciEvidenceCollectorService.js";
import { logger } from "../lib/logger.js";

import { diagnosisQueue } from "../lib/queue.js";

export function startCIEvidenceWorker() {
  const worker = createWorker(
    "ci-evidence",
    async (job) => {
      const { installationId, repoFullName, runId, headSha, workflowPath, action, conclusion, deliveryId } = job.data;

      logger.info({ jobId: job.id, runId, repoFullName, deliveryId }, "Processing CI evidence collection job");

      // Reconstruct the payload context for the collector
      const payload = {
        action: action || "completed",
        workflow_run: {
          id: runId,
          conclusion: conclusion || "failure",
          head_sha: headSha,
          path: workflowPath,
        },
        repository: {
          full_name: repoFullName,
        },
        installation: {
          id: installationId,
        },
        workflow: workflowPath ? { path: workflowPath } : undefined,
      };

      // Get authenticated GitHub API client
      const rawOctokit = await getInstallationClient(installationId);
      const octokit = wrapOctokit(rawOctokit);

      // Run the full collection pipeline
      const proposal = await collectForFailedRun(octokit, payload, deliveryId);

      logger.info(
        { jobId: job.id, proposalId: proposal.id, runId },
        "CI evidence collection completed"
      );

      // ── Enqueue diagnosis job for the collected proposal ─────────────────
      // Only enqueue when evidence collection actually moved the proposal
      // to evidence_collected. The diagnosis worker is idempotent (skips
      // proposals that already have a diagnosis), so duplicate deliveries
      // are safe.
      if (proposal.status === "evidence_collected") {
        const diagnosisCorrelationId = `diagnosis-${proposal.id}-${Date.now()}`;
        await diagnosisQueue.add(
          "diagnose-proposal",
          {
            proposalId: proposal.id,
            correlationId: diagnosisCorrelationId,
          },
          {
            priority: 3,
            jobId: `diagnosis-${proposal.id}`,
          }
        );
        logger.info(
          { jobId: job.id, proposalId: proposal.id },
          "Diagnosis job enqueued"
        );
      }

      return { proposalId: proposal.id };
    },
    { concurrency: 2 }
  );

  worker.on("failed", (job, err) => {
    logger.error(
      { jobId: job?.id, runId: job?.data?.runId, err: err.message },
      "CI evidence collection job failed"
    );
  });

  return worker;
}
