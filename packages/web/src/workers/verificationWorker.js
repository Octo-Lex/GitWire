// src/workers/verificationWorker.js
// Background worker for trusted CI repair patch verification.
//
// Processes jobs from the verification queue. Each job represents a proposal
// in proposed status with a patch_proposal that needs sandbox verification.
//
// The worker:
// 1. Looks up the repository installation ID for source snapshot acquisition
// 2. Acquires a read-only GitHub client (outside the sandbox)
// 3. Resolves the durable patch artifact
// 4. Applies the patch to the source snapshot
// 5. Runs bounded validations in an isolated sandbox
// 6. Stores the durable execution receipt
// 7. Records the result through the canonical recordVerificationResult path
//
// The sandbox itself receives NO GitHub credentials and NO network access.
// Source acquisition happens OUTSIDE the sandbox.
// No branch creation, PR creation, or repository writes.

import { createWorker } from "../lib/queue.js";
import { verifyProposal } from "../services/verificationWorkerService.js";
import { getInstallationClient } from "../lib/github.js";
import { wrapOctokit } from "../lib/githubWrapper.js";
import { db } from "../lib/db.js";
import { logger } from "../lib/logger.js";

export function startVerificationWorker() {
  const worker = createWorker(
    "verification",
    async (job) => {
      const { proposalId, correlationId } = job.data;

      logger.info({ jobId: job.id, proposalId, correlationId }, "Processing verification job");

      // Look up installation ID for source snapshot acquisition
      let octokit = null;
      try {
        const { rows: [repoRow] } = await db.query(
          `SELECT r.installation_id
           FROM repair_proposals p
           JOIN repositories r ON p.repo_id = r.github_id
           WHERE p.id = $1`,
          [proposalId]
        );

        if (repoRow?.installation_id) {
          const rawOctokit = await getInstallationClient(repoRow.installation_id);
          octokit = wrapOctokit(rawOctokit);
        } else {
          logger.warn(
            { proposalId },
            "No installation_id found — source snapshot acquisition may fail"
          );
        }
      } catch (clientErr) {
        logger.warn(
          { proposalId, err: clientErr.message },
          "Failed to acquire GitHub client for source snapshot"
        );
      }

      const proposal = await verifyProposal(proposalId, {
        correlation_id: correlationId,
        octokit,
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
