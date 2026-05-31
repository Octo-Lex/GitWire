// src/lib/webhookHandlers/handlePullRequest.js
// Handler for "pull_request" webhook events.

import { checkSpamGate } from "./handleSpamGate.js";

export async function handlePullRequest(payload, deliveryId, ctx) {
  const jobData = { eventName: "pull_request", payload, deliveryId, receivedAt: Date.now() };

  // Spam gate check on opened PRs (before triage)
  if (payload.action === "opened") {
    const spamResult = await checkSpamGate(ctx, payload, "pull_request");
    if (spamResult.blocked) {
      ctx.logger.info({ pr: payload.pull_request?.number, reason: spamResult.reason }, "PR blocked by spam gate");
      return; // Don't triage spam
    }
  }

  // Triage + AI review on open / reopen / ready
  if (["opened", "reopened", "ready_for_review"].includes(payload.action)) {
    await ctx.triageQueue.add("triage-pr", jobData, { priority: 2 });
    ctx.logger.info({ action: payload.action, pr: payload.pull_request?.number }, "PR queued for triage");

    // Phase 4: AI review
    await ctx.phase4Queue.add("ai-review", {
      pr:           payload.pull_request,
      repository:   payload.repository,
      installation: payload.installation,
    }, { priority: 1 });
  }

  // Managed actions: reconcile on force-push
  if (payload.action === "synchronize") {
    await ctx.ciHealQueue.add("reconcile-pr", {
      payload: {
        repository:   payload.repository,
        pull_request: payload.pull_request,
        installation: payload.installation,
      },
    }, { priority: 5 });
    ctx.logger.info({ pr: payload.pull_request?.number }, "PR synchronize — reconcile job queued");
  }

  // Managed actions: cleanup when PR is closed/merged
  if (payload.action === "closed") {
    await cleanupManagedActions(payload, ctx);
  }

  // Phase 2: auto-merge label → merge queue
  if (payload.action === "labeled" && payload.label?.name === "auto-merge") {
    await ctx.phase2Queue.add("pr-labeled-auto-merge", jobData, { priority: 1 });
  }

  // Phase 2: closed/unlabeled → merge queue cleanup
  if (payload.action === "closed" || payload.action === "unlabeled") {
    await ctx.phase2Queue.add("pr-closed-or-unlabeled", jobData, { priority: 2 });
  }
}

async function cleanupManagedActions(payload, ctx) {
  try {
    const { cleanupPR } = await import("../../services/managedActionService.js");
    const deactivated = await cleanupPR(payload.repository?.id, payload.pull_request?.number);
    if (deactivated.length > 0) {
      ctx.logger.info(
        { pr: payload.pull_request?.number, deactivated: deactivated.length },
        "Cleaned up managed actions on PR close"
      );
    }
  } catch (err) {
    ctx.logger.warn({ err: err.message }, "Managed action cleanup failed (non-fatal)");
  }
}
