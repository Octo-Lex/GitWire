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
import { finalizeGitwireCheck, getRetryOutcome, clearRetryOutcome, replayCheckConclusion } from "../services/checkRunFinalizer.js";
import { logger } from "../lib/logger.js";

export const phase4Queue = createQueue(QUEUES.PHASE4);

// ── Worker ────────────────────────────────────────────────────────────────────
export function startPhase4Worker() {
  return createWorker(QUEUES.PHASE4, async (job) => {
    switch (job.name) {

      case "ai-review": {
        const { pr, repository, installation, checkRunId } = job.data;
        if (!pr || !repository || !installation) return;

        const ownedCheckRunId = checkRunId || null;
        const octokitLazy = () => wrapOctokit(getInstallationClient(installation.id));

        // Track whether the check has already been finalized with a real
        // result. Once finalized, downstream errors must not overwrite it.
        let checkFinalized = false;

        // Sentinel: when finalizeOwn throws because its PATCH failed, we must
        // NOT call finalizeOwnFailure (that would overwrite the correct stored
        // outcome with an error result). This flag distinguishes a transport
        // failure (retry the PATCH) from a genuine review error (finalize as
        // failure).
        let patchRetryPending = false;

        async function finalizeOwn(reviewResult, opts = {}) {
          if (checkFinalized && !opts.force) return;
          const octokit = await octokitLazy();
          const ok = await finalizeGitwireCheck({
            octokit, owner: repository.owner.login, repo: repository.name,
            repoId: repository.id, prNumber: pr.number, headSha: pr.head.sha,
            reviewResult,
            checkRunId: ownedCheckRunId,
          });
          if (!ok) {
            // GitHub PATCH failed. The finalizer stored the intended outcome
            // for replay. Set the sentinel so the catch path skips
            // finalizeOwnFailure, then throw for BullMQ retry.
            patchRetryPending = true;
            throw new Error("GitWire check finalization PATCH failed — will retry");
          }
          checkFinalized = true;
        }

        async function finalizeOwnFailure(err) {
          if (checkFinalized) return;
          if (patchRetryPending) return; // transport failure, not a review error
          const octokit = await octokitLazy();
          const ok = await finalizeGitwireCheck({
            octokit, owner: repository.owner.login, repo: repository.name,
            repoId: repository.id, prNumber: pr.number, headSha: pr.head.sha,
            reviewResult: { blocked: false, verdict: "error", findings: [] },
            checkRunId: ownedCheckRunId,
            errorContext: err?.message || "unknown error",
          });
          checkFinalized = true;
          if (!ok) {
            // Even the failure-finalization PATCH failed. Store it for retry.
            patchRetryPending = true;
          }
        }

        try {
          // ── BullMQ retry replay: if a prior attempt stored a terminal
          // outcome because its GitHub PATCH failed, replay it now VERBATIM
          // (same conclusion, title, summary) without rerunning reviewPR.
          if (ownedCheckRunId) {
            const storedOutcome = await getRetryOutcome(repository.id, pr.number, pr.head.sha, ownedCheckRunId);
            if (storedOutcome) {
              logger.info({ pr: pr.number, checkRunId: ownedCheckRunId }, "Replaying stored check finalization from prior attempt");
              const octokit = await octokitLazy();
              const patched = await replayCheckConclusion({
                octokit, owner: repository.owner.login, repo: repository.name,
                repoId: repository.id, prNumber: pr.number, headSha: pr.head.sha,
                checkRunId: ownedCheckRunId,
                conclusion: storedOutcome.conclusion,
                title: storedOutcome.title,
                summary: storedOutcome.summary,
              });
              if (patched) {
                await clearRetryOutcome(repository.id, pr.number, pr.head.sha, ownedCheckRunId);
                checkFinalized = true;
                logger.info({ pr: pr.number }, "Stored check finalization replayed successfully");
                return;
              }
              // PATCH failed again — BullMQ will retry again
              throw new Error("GitWire check finalization PATCH failed on retry — will retry again");
            }
          }

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
          // ── Idempotency: distinguish fresh duplicate from BullMQ retry ────
          // A BullMQ retry of the same job carries the same checkRunId and
          // is NOT a fresh delivery. It must not neutralize its own check.
          // A fresh duplicate (different webhook event) owns a different
          // checkRunId and should finalize its own check neutral.
          if (!(await checkAndMark("ai_review", "pr-" + pr.number + "-" + (pr.head?.sha || "unknown")))) {
            const isRetry = (job.attemptsMade || 0) > 0;
            if (isRetry && ownedCheckRunId) {
              // BullMQ retry (or stall recovery) with no stored outcome.
              // The prior attempt may have died after checkAndMark but before
              // storing a retry outcome. Check the actual GitHub check state:
              // if already terminal, leave it alone; if still queued,
              // finalize as failure (prior evaluation was interrupted).
              logger.info({ pr: pr.number, attemptsMade: job.attemptsMade }, "AI review retry with no stored outcome — checking GitHub check state");
              const octokit = await octokitLazy();
              try {
                const { data: checkRun } = await octokit.request(
                  "GET /repos/{owner}/{repo}/check-runs/{check_run_id}",
                  { owner: repository.owner.login, repo: repository.name, check_run_id: ownedCheckRunId },
                );
                if (checkRun.status === "completed") {
                  logger.info({ pr: pr.number, checkRunId: ownedCheckRunId, conclusion: checkRun.conclusion }, "Owned check already terminal — leaving untouched");
                  checkFinalized = true;
                  return;
                }
                // Check is still queued/in_progress — prior evaluation was interrupted
                logger.warn({ pr: pr.number, checkRunId: ownedCheckRunId, status: checkRun.status }, "Owned check still queued — finalizing as interrupted");
                await finalizeOwnFailure(new Error("Prior AI review evaluation was interrupted (worker stall/retry)"));
                return;
              } catch (checkErr) {
                // Cannot read check state — finalize as failure to be safe
                logger.warn({ err: checkErr.message, pr: pr.number }, "Cannot read check state on retry — finalizing as failure");
                await finalizeOwnFailure(new Error("Prior AI review evaluation was interrupted (check state unavailable)"));
                return;
              }
            }
            // Fresh duplicate with its own checkRunId: finalize it neutral.
            logger.info({ pr: pr.number }, "AI review fresh duplicate — finalizing this job's check as suppressed");
            await finalizeOwn(null, { force: true });
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

          // Finalize the top-level "GitWire" check run.
          // If PATCH fails, finalizeOwn throws → BullMQ retries →
          // retry replays the stored outcome without rerunning reviewPR.
          await finalizeOwn(result);

          // Emit worker event for merge queue to pick up
          await emitWorkerEvent("review_completed", {
            repo: repository.full_name,
            repoId: repository.id,
            prNumber: pr.number,
            installationId: installation.id,
          });
        } catch (err) {
          // If this is a PATCH-retry error (transport failure, not a review
          // error), rethrow WITHOUT calling finalizeOwnFailure. The stored
          // outcome is correct and will be replayed on the next attempt.
          if (patchRetryPending) {
            throw err;
          }
          // Genuine worker/review error: finalize as failure before rethrowing.
          // If the review already completed and finalized with the correct
          // result, finalizeOwnFailure is a no-op (checkFinalized guard).
          try {
            await finalizeOwnFailure(err);
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
