// src/workers/phase4Worker.js
// BullMQ worker + scheduler for Phase 4.
// Jobs: ai-review, nightly-audit-export

import { createWorker, createQueue } from "../lib/queue.js";
import { getInstallationClient }     from "../lib/github.js";
import { reviewPR }      from "../services/aiReviewService.js";
import { exportNightly } from "../services/auditTrailService.js";
import { QUEUES } from "@gitwire/core";
import { logger } from "../lib/logger.js";

export const phase4Queue = createQueue(QUEUES.PHASE4);

// ── Worker ────────────────────────────────────────────────────────────────────
export function startPhase4Worker() {
  return createWorker(QUEUES.PHASE4, async (job) => {
    switch (job.name) {

      case "ai-review": {
        const { pr, repository, installation } = job.data;
        if (!pr || !repository || !installation) return;
        const octokit = await getInstallationClient(installation.id);
        await reviewPR({
          pr,
          repository: { ...repository, id: repository.id },
          octokit,
        });
        break;
      }

      case "nightly-audit-export": {
        const yesterday = new Date();
        yesterday.setUTCDate(yesterday.getUTCDate() - 1);
        await exportNightly(yesterday);
        break;
      }

      default:
        logger.debug({ jobName: job.name }, "Phase4 worker: unknown job");
    }
  }, { concurrency: 2 });
}

// ── Scheduler ─────────────────────────────────────────────────────────────────
export async function schedulePhase4Jobs() {
  // Nightly audit export at 01:00 UTC
  await phase4Queue.add(
    "nightly-audit-export",
    {},
    {
      repeat: { cron: "0 1 * * *" },
      jobId:  "nightly-audit-export-cron",
    }
  );

  logger.info("Phase4: nightly audit export scheduled (01:00 UTC)");
}
