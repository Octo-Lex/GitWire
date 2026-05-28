// src/workers/phase2Worker.js
// BullMQ workers for Phase 2: merge queue + recovery.
// Adapted for GitWire: uses GitWire queue names and patterns.

import { createWorker, QUEUES } from "../lib/queue.js";
import { getInstallationClient } from "../lib/github.js";
import { wrapOctokit } from "../lib/githubWrapper.js";
import { admitToQueue, onChecksUpdated, processQueue, removeFromQueue } from "../services/mergeQueueService.js";
import { evaluateRollback } from "../services/errorRecoveryService.js";
import { getConfigForRepo } from "../services/configService.js";
import { isPillarEnabled, isDryRun } from "@gitwire/rules";
import { logger } from "../lib/logger.js";

// ── Merge queue worker ────────────────────────────────────────────────────────
export function startMergeQueueWorker() {
  return createWorker(QUEUES.PHASE2, async (job) => {
    const { payload, eventName } = job.data;
    const repository  = payload.repository;
    const installation = payload.installation;
    if (!repository || !installation) return;

    const octokit = wrapOctokit(await getInstallationClient(installation.id));

    // ── Check .gitwire.yml pillar config ──────────────────────────────────
    const repoConfig = await getConfigForRepo(repository.full_name);
    if (!isPillarEnabled("merge_queue", repoConfig)) {
      logger.debug({ repo: repository.full_name }, "Merge queue disabled for repo — skipping");
      return;
    }
    if (isDryRun(repoConfig)) {
      logger.info({ repo: repository.full_name, jobName: job.name }, "DRY RUN: would process merge queue event");
      return;
    }

    switch (job.name) {
      case "checks-updated": {
        const suite = payload.check_suite ?? payload.workflow_run;
        if (suite) {
          await onChecksUpdated({ checkSuite: suite, repository, octokit });
        }
        break;
      }

      case "review-submitted": {
        const pr = payload.pull_request;
        if (pr) await admitToQueue({ pr, repository, octokit });
        break;
      }

      case "pr-labeled-auto-merge": {
        const pr = payload.pull_request;
        if (pr) await admitToQueue({ pr, repository, octokit });
        break;
      }

      case "pr-closed-or-unlabeled": {
        const pr = payload.pull_request;
        if (pr) {
          const labelRemoved =
            payload.action === "unlabeled" &&
            payload.label?.name === "auto-merge";

          if (pr.state === "closed" || labelRemoved) {
            await removeFromQueue({
              repoId:   repository.id,
              prNumber: pr.number,
              reason:   "removed",
            });
          }
        }
        break;
      }

      case "eval-rollback": {
        const run = payload.workflow_run;
        if (run) {
          await evaluateRollback({ run, repository, installation });
        }
        break;
      }

      default:
        logger.debug({ jobName: job.name }, "Phase2 worker: unknown job");
    }
  }, { concurrency: 2 });
}
