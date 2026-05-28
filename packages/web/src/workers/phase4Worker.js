// src/workers/phase4Worker.js
// BullMQ worker + scheduler for Phase 4.
// Jobs: ai-review, nightly-audit-export

import { createWorker, createQueue } from "../lib/queue.js";
import { getInstallationClient }     from "../lib/github.js";
import { wrapOctokit } from "../lib/githubWrapper.js";
import { reviewPR }      from "../services/aiReviewService.js";
import { exportNightly } from "../services/auditTrailService.js";
import { getConfigForRepo } from "../services/configService.js";
import { isPillarEnabled, isDryRun, shouldTrigger } from "@gitwire/rules";
import { checkAndMark } from "../services/idempotencyService.js";
import { emitWorkerEvent } from "../services/workerEvents.js";
import { isWaived } from "../services/waiverService.js";
import { QUEUES } from "@gitwire/core";
import { updateGitwireCheck } from "../lib/checkStatus.js";
import { redis } from "../lib/queue.js";

/**
 * Finalize the top-level "GitWire" check run created in the webhook route.
 * Reads the check run ID from Redis, updates to completed with appropriate conclusion.
 */
async function finalizeGitwireCheck({ octokit, owner, repo, repoId, prNumber, headSha, reviewResult }) {
  const checkKey = "gitwire:check:" + repoId + ":" + prNumber + ":" + headSha;
  const checkRunIdStr = await redis.get(checkKey);
  if (!checkRunIdStr) return; // No check run was created (may lack checks:write permission)
  const checkRunId = parseInt(checkRunIdStr, 10);
  if (!checkRunId) return;

  let conclusion, title, summary;
  if (!reviewResult) {
    // Review was skipped (no config, bot author, no files)
    conclusion = "neutral";
    title = "GitWire \u2014 no review needed";
    summary = "AI review is not configured for this repository, or the PR was skipped.";
  } else if (reviewResult.blocked) {
    conclusion = "failure";
    title = "GitWire \u2014 review blocked merge";
    summary = "AI review found " + reviewResult.findings.length + " finding(s). Verdict: " + reviewResult.verdict + ".";
  } else {
    conclusion = "success";
    title = "GitWire \u2014 review passed";
    summary = "AI review completed. Verdict: " + reviewResult.verdict + ", " + reviewResult.findings.length + " finding(s).";
  }

  await updateGitwireCheck({ octokit, owner, repo, checkRunId, conclusion, title, summary });
  // Clean up Redis key
  await redis.del(checkKey);
}
import { logger } from "../lib/logger.js";

export const phase4Queue = createQueue(QUEUES.PHASE4);

// ── Worker ────────────────────────────────────────────────────────────────────
export function startPhase4Worker() {
  return createWorker(QUEUES.PHASE4, async (job) => {
    switch (job.name) {

      case "ai-review": {
        const { pr, repository, installation } = job.data;
        if (!pr || !repository || !installation) return;
        // ── Check .gitwire.yml pillar config ──────────────────────────────
        const repoConfig = await getConfigForRepo(repository.full_name);
        if (!isPillarEnabled("ai_review", repoConfig)) {
          logger.debug({ repo: repository.full_name, pr: pr.number }, "AI review disabled — skipping");
          return;
        }
        // ── Trigger filter: branch/author/paths ────────────────────────────
        if (!shouldTrigger("ai_review", { branch: pr.base?.ref, author: pr.user?.login, paths: pr.changed_files }, repoConfig)) {
          logger.info({ pr: pr.number, branch: pr.base?.ref }, "Trigger filter: AI review skipped for branch/author/paths");
          return;
        }
        // ── Policy waiver check ─────────────────────────────────────────
        const waiver = await isWaived({ repoId: repository.id, pillar: "ai_review", scope: "pr", scopeValue: String(pr.number) });
        if (waiver) {
          logger.info({ pr: pr.number, waiverId: waiver.id }, "Policy waived — skipping AI review");
          return;
        }
        // ── Idempotency: skip duplicate reviews ───────────────────────────
        if (!(await checkAndMark("ai_review", "pr-" + pr.number + "-" + (pr.head?.sha || "unknown")))) {
          return;
        }
        if (isDryRun(repoConfig)) {
          logger.info({ repo: repository.full_name, pr: pr.number }, "DRY RUN: would run AI review");
          return;
        }
        const octokit = wrapOctokit(await getInstallationClient(installation.id));
        const reviewOpts = repoConfig.pillars?.ai_review || {};
        const result = await reviewPR({
          pr,
          repository: { ...repository, id: repository.id },
          octokit,
          commentFindings: reviewOpts.comment_findings !== false,
        });

        // Finalize the top-level "GitWire" check run (created in webhook route)
        await finalizeGitwireCheck({
          octokit, owner: repository.owner.login, repo: repository.name,
          repoId: repository.id, prNumber: pr.number, headSha: pr.head.sha,
          reviewResult: result,
        });

        // Emit worker event for merge queue to pick up
        await emitWorkerEvent("review_completed", {
          repo: repository.full_name,
          repoId: repository.id,
          prNumber: pr.number,
          installationId: installation.id,
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
