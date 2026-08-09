// src/workers/phase4Worker.js
// BullMQ worker + scheduler for Phase 4.
// Jobs: ai-review, nightly-audit-export

import { createWorker, createQueue } from "../lib/queue.js";
import { getInstallationClient }     from "../lib/github.js";
import { wrapOctokit } from "../lib/githubWrapper.js";
import { reviewPR }      from "../services/aiReviewService.js";
import { adoptWorker, workerPrincipalId } from "../services/auth/workerAdoption.js";
import { exportNightly } from "../services/auditTrailService.js";
import { getConfigForRepo } from "../services/configService.js";
import { isPillarEnabled, isDryRun, shouldTrigger } from "@gitwire/rules";
import { checkAndMark } from "../services/idempotencyService.js";
import { emitWorkerEvent } from "../services/workerEvents.js";
import { isWaived } from "../services/waiverService.js";
import { QUEUES } from "@gitwire/core";
import { finalizeGitwireCheck } from "../services/checkRunFinalizer.js";
import { logger } from "../lib/logger.js";

export const phase4Queue = createQueue(QUEUES.PHASE4);

// ── Worker ────────────────────────────────────────────────────────────────────
export function startPhase4Worker() {
  return createWorker(QUEUES.PHASE4, async (job) => {
    switch (job.name) {

      case "ai-review": {
        const { pr, repository, installation, checkRunId } = job.data;
        if (!pr || !repository || !installation) return;

        // The checkRunId is owned by THIS job. It was created by the webhook
        // route and threaded through the dispatch chain. Every exit path must
        // finalize this specific check so it never stays queued.
        const ownedCheckRunId = checkRunId || null;

        // Helper to finalize this job's own check on any exit path
        const octokitLazy = () => wrapOctokit(getInstallationClient(installation.id));

        async function finalizeOwn(reviewResult) {
          const octokit = await octokitLazy();
          await finalizeGitwireCheck({
            octokit, owner: repository.owner.login, repo: repository.name,
            repoId: repository.id, prNumber: pr.number, headSha: pr.head.sha,
            reviewResult,
            checkRunId: ownedCheckRunId,
          });
        }

        try {
          // ── Check .gitwire.yml pillar config ──────────────────────────────
          const repoConfig = await getConfigForRepo(repository.full_name);
          if (!isPillarEnabled("ai_review", repoConfig)) {
            logger.debug({ repo: repository.full_name, pr: pr.number }, "AI review disabled — skipping");
            await finalizeOwn(null);
            return;
          }
          // ── Trigger filter: branch/author/paths ────────────────────────────
          if (!shouldTrigger("ai_review", { branch: pr.base?.ref, author: pr.user?.login, paths: pr.changed_files }, repoConfig)) {
            logger.info({ pr: pr.number, branch: pr.base?.ref }, "Trigger filter: AI review skipped for branch/author/paths");
            await finalizeOwn(null);
            return;
          }
          // ── Policy waiver check ─────────────────────────────────────────
          const waiver = await isWaived({ repoId: repository.id, pillar: "ai_review", scope: "pr", scopeValue: String(pr.number) });
          if (waiver) {
            logger.info({ pr: pr.number, waiverId: waiver.id }, "Policy waived — skipping AI review");
            await finalizeOwn(null);
            return;
          }
          // ── Idempotency: skip duplicate reviews ───────────────────────────
          // When a duplicate is detected, finalize THIS job's own check as
          // neutral (duplicate suppressed), without touching the original
          // invocation's check. The original job has its own checkRunId and
          // will finalize it with the actual review result.
          if (!(await checkAndMark("ai_review", "pr-" + pr.number + "-" + (pr.head?.sha || "unknown")))) {
            logger.info({ pr: pr.number }, "AI review duplicate — finalizing this job's check as suppressed");
            await finalizeOwn(null);
            return;
          }
          if (isDryRun(repoConfig)) {
            logger.info({ repo: repository.full_name, pr: pr.number }, "DRY RUN: would run AI review");
            await finalizeOwn(null);
            return;
          }
          const octokit = wrapOctokit(await getInstallationClient(installation.id));
          const reviewOpts = repoConfig.pillars?.ai_review || {};

          // Wave 2: resolve trusted installation principal.
          const ph4Adoption = await adoptWorker({
            workerId: "worker:phase4",
            permission: "ai_review:create",
            resourceType: "repository",
            installationId: installation.id,
            jobData: { payload: job.data },
            legacyActor: pr.user?.login,
          });
          const ph4PrincipalId = workerPrincipalId(ph4Adoption.context);

          const result = await reviewPR({
            pr,
            repository: { ...repository, id: repository.id },
            octokit,
            commentFindings: reviewOpts.comment_findings !== false,
            principalId: ph4PrincipalId,
            surfaceId: "audit_trail:ai_decision",
          });

          // Finalize the top-level "GitWire" check run (created in webhook route)
          await finalizeOwn(result);

          // Emit worker event for merge queue to pick up
          await emitWorkerEvent("review_completed", {
            repo: repository.full_name,
            repoId: repository.id,
            prNumber: pr.number,
            installationId: installation.id,
          });
        } catch (err) {
          // Attempt to finalize this job's own check as failure before
          // rethrowing to BullMQ for retry visibility. If GitHub is
          // unreachable, the check remains queued but the pointer is
          // preserved by finalizeGitwireCheck's PATCH-failure handling.
          try {
            await finalizeOwn(null);
          } catch (finalizeErr) {
            logger.warn({ err: finalizeErr.message || finalizeErr, pr: pr.number }, "Failed to finalize check on error path");
          }
          throw err;
        }
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
  // Wave 2: the scheduler producer resolves a server-owned principal before
  // enqueuing. The system:phase4-worker principal is the trusted identity
  // for the scheduling decision.
  await adoptWorker({
    workerId: "scheduled:phase4",
    permission: "ai_review:create",
    resourceType: "fleet",
    systemPrincipalName: "system:phase4-worker",
  });

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
