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
        const { pr, repository, installation, checkRunId, skipReason } = job.data;
        if (!pr || !repository || !installation) return;

        const ownedCheckRunId = checkRunId || null;
        const octokitLazy = () => wrapOctokit(getInstallationClient(installation.id));

        let checkFinalized = false;
        let patchRetryPending = false;

        // A repeated processing attempt means either a BullMQ retry
        // (attemptsMade > 0) or a stall recovery (attemptsStarted > 1).
        // BullMQ increments attemptsStarted on every activation, including
        // stalled-job reactivation that does not increment attemptsMade.
        const isRepeatedAttempt =
          (job.attemptsMade || 0) > 0 ||
          (job.attemptsStarted || 0) > 1;

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
            patchRetryPending = true;
            throw new Error("GitWire check finalization PATCH failed — will retry");
          }
          checkFinalized = true;
        }

        async function finalizeOwnFailure(err) {
          if (checkFinalized) return;
          if (patchRetryPending) return;
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
            // The failure-finalization PATCH itself failed. The finalizer
            // stored the failure outcome for replay. Throw so BullMQ retries
            // and the next attempt replays it.
            patchRetryPending = true;
            throw new Error("GitWire check failure-finalization PATCH failed — will retry");
          }
        }

        try {
          // ── BullMQ retry replay ───────────────────────────────────────────
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
              // Replay PATCH failed again — set sentinel and throw for retry.
              // Do NOT enter finalizeOwnFailure (the stored outcome is correct).
              patchRetryPending = true;
              throw new Error("GitWire check finalization PATCH failed on retry — will retry again");
            }
          }

          // ── Skip-reason terminalization (e.g. spam-gate blocked PR) ────────
          // The webhook route created a GitWire check before the spam gate ran.
          // The handler enqueued this job with skipReason so the check reaches
          // a terminal state without running reviewPR.
          if (skipReason) {
            logger.info({ pr: pr.number, skipReason }, "AI review skipped — terminalizing owned check");
            await finalizeOwn(null);
            return;
          }

          // ── Check .gitwire.yml pillar config ──────────────────────────────
          const repoConfig = await getConfigForRepo(repository.full_name);
          if (!isPillarEnabled("ai_review", repoConfig)) {
            logger.debug({ repo: repository.full_name, pr: pr.number }, "AI review disabled — skipping");
            await finalizeOwn(null);
            return;
          }
          if (!shouldTrigger("ai_review", { branch: pr.base?.ref, author: pr.user?.login, paths: pr.changed_files }, repoConfig)) {
            logger.info({ pr: pr.number, branch: pr.base?.ref }, "Trigger filter: AI review skipped for branch/author/paths");
            await finalizeOwn(null);
            return;
          }
          const waiver = await isWaived({ repoId: repository.id, pillar: "ai_review", scope: "pr", scopeValue: String(pr.number) });
          if (waiver) {
            logger.info({ pr: pr.number, waiverId: waiver.id }, "Policy waived — skipping AI review");
            await finalizeOwn(null);
            return;
          }
          // ── Idempotency: distinguish fresh duplicate from repeated attempt ─
          if (!(await checkAndMark("ai_review", "pr-" + pr.number + "-" + (pr.head?.sha || "unknown")))) {
            if (isRepeatedAttempt && ownedCheckRunId) {
              // Repeated processing with no stored retry outcome. The prior
              // attempt may have died after checkAndMark but before completing.
              // Check the actual GitHub check state to decide:
              // - completed → leave untouched (correct result stands)
              // - queued/in_progress → finalize as interrupted failure
              // - state unavailable → finalize as interrupted failure (safe)
              logger.info({ pr: pr.number, attemptsMade: job.attemptsMade, attemptsStarted: job.attemptsStarted }, "AI review repeated attempt with no stored outcome — checking GitHub check state");

              // Step 1: Read check state (isolated try/catch)
              let checkStatus = null;
              try {
                const octokit = await octokitLazy();
                const { data: checkRun } = await octokit.request(
                  "GET /repos/{owner}/{repo}/check-runs/{check_run_id}",
                  { owner: repository.owner.login, repo: repository.name, check_run_id: ownedCheckRunId },
                );
                checkStatus = checkRun.status;
              } catch (checkErr) {
                logger.warn({ err: checkErr.message, pr: pr.number }, "Cannot read check state on repeated attempt — treating as interrupted");
              }

              // Step 2: Act on check state (OUTSIDE the GET catch so a
              // finalization transport error propagates to the outer catch)
              if (checkStatus === "completed") {
                logger.info({ pr: pr.number, checkRunId: ownedCheckRunId }, "Owned check already terminal — leaving untouched");
                checkFinalized = true;
                return;
              }
              // queued, in_progress, or unavailable → finalize as interrupted
              logger.warn({ pr: pr.number, checkRunId: ownedCheckRunId, checkStatus }, "Owned check not terminal — finalizing as interrupted");
              await finalizeOwnFailure(new Error(
                checkStatus
                  ? "Prior AI review evaluation was interrupted (check status: " + checkStatus + ")"
                  : "Prior AI review evaluation was interrupted (check state unavailable)"
              ));
              return;
            }
            // Fresh duplicate with its own checkRunId: finalize neutral.
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
            logicalInvocation: "automatic",
          });

          await finalizeOwn(result);

          // ── Shadow v2 sidecar (RI-9) ──────────────────────────────────────
          // Run the v2 pipeline alongside production when shadow mode is enabled.
          // Shadow mode NEVER produces a GitHub mutation — it only records
          // divergence between the production and v2 decisions.
          try {
            const { resolveShadowMode, runShadowVerification } = await import("../services/reviewIntegrityShadow.js");
            const shadowMode = resolveShadowMode(repoConfig, reviewOpts);
            if (shadowMode !== "disabled") {
              // Build real v2 ReviewEvidence from the same octokit the production review used
              const { acquireChangedFiles, buildReviewEvidence } = await import("../services/reviewEvidenceService.js");
              const { allFiles, paginatedFully } = await acquireChangedFiles(
                octokit, repository.owner.login, repository.name, pr.number,
                pr.changed_files || 0,
              );
              const evidence = await buildReviewEvidence({
                allFiles,
                paginatedFully,
                ignorePatterns: reviewOpts.ignore_patterns || [],
                maxFiles: reviewOpts.max_files_to_review || 30,
                maxLines: reviewOpts.max_lines_to_review || 2000,
                review: {
                  repoId: repository.id,
                  repoFullName: repository.full_name,
                  prNumber: pr.number,
                  baseSha: pr.base?.sha,
                  headSha: pr.head.sha,
                  invocationId: "shadow-" + pr.number + "-" + pr.head.sha,
                },
                octokit,
                owner: repository.owner.login,
                repo: repository.name,
              });

              // Construct a real Anthropic client for the verifier from production config
              const { config } = await import("../../config/index.js");
              const Anthropic = (await import("@anthropic-ai/sdk")).default;
              const shadowAnthropic = new Anthropic({
                apiKey: config.anthropic.apiKey,
                baseURL: config.anthropic.baseURL,
              });

              const shadowResult = await runShadowVerification({
                productionResult: result,
                productionFindings: result?.findings || [],
                evidence,
                octokit,
                owner: repository.owner.login,
                repo: repository.name,
                anthropic: shadowAnthropic,
                model: reviewOpts.model || "claude-sonnet-4-20250514",
                repoConfig,
                reviewConfig: reviewOpts,
                reviewRowId: 0, // best-effort: reviewRow id not exposed by reviewPR return
                invocationId: "shadow-" + pr.number + "-" + pr.head.sha,
                primaryTokens: 0, // production token count not exposed by reviewPR return
                primaryLatencyMs: 0, // production latency not exposed by reviewPR return
              });

              // Durable divergence recording
              if (shadowResult.ran && shadowResult.divergence?.diverged) {
                logger.warn({
                  pr: pr.number,
                  repo: repository.full_name,
                  productionEvent: shadowResult.productionEvent,
                  v2Event: shadowResult.v2Event,
                  divergence: shadowResult.divergence,
                }, "Shadow v2 divergence detected — production and v2 decisions differ");
              } else if (shadowResult.ran) {
                logger.info({
                  pr: pr.number,
                  productionEvent: shadowResult.productionEvent,
                  v2Event: shadowResult.v2Event,
                }, "Shadow v2 completed — no divergence");
              }
            }
          } catch (shadowErr) {
            // Shadow failures must NEVER affect the production review path
            logger.debug({ err: shadowErr.message, pr: pr.number }, "Shadow v2 sidecar failed (non-fatal)");
          }

          await emitWorkerEvent("review_completed", {
            repo: repository.full_name,
            repoId: repository.id,
            prNumber: pr.number,
            installationId: installation.id,
          });
        } catch (err) {
          // Transport failure (PATCH failed): rethrow without entering
          // finalizeOwnFailure. The stored outcome is correct and will be
          // replayed on the next BullMQ attempt.
          if (patchRetryPending) {
            throw err;
          }
          // Genuine worker/review error: finalize as failure before rethrowing.
          try {
            await finalizeOwnFailure(err);
          } catch (finalizeErr) {
            if (patchRetryPending) {
              // finalizeOwnFailure's PATCH also failed — rethrow as transport
              throw finalizeErr;
            }
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
