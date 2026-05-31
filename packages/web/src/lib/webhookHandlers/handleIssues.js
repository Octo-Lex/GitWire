// src/lib/webhookHandlers/handleIssues.js
// Handler for "issues" webhook events.

import { checkSpamGate } from "./handleSpamGate.js";

export async function handleIssues(payload, deliveryId, ctx) {
  // Spam gate check on opened issues (before triage)
  if (payload.action === "opened") {
    const spamResult = await checkSpamGate(ctx, payload, "issue");
    if (spamResult.blocked) {
      ctx.logger.info({ issue: payload.issue?.number, reason: spamResult.reason }, "Issue blocked by spam gate");
      return; // Don't triage spam
    }
  }

  if (["opened", "reopened", "edited"].includes(payload.action)) {
    const jobData = { eventName: "issues", payload, deliveryId, receivedAt: Date.now() };
    await ctx.triageQueue.add("triage-issue", jobData, { priority: 1 });
    ctx.logger.info({ action: payload.action, issue: payload.issue?.number }, "Issue queued for triage");
  }
}
