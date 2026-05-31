// src/lib/webhookHandlers/handleIssues.js
// Handler for "issues" webhook events.

export async function handleIssues(payload, deliveryId, ctx) {
  if (["opened", "reopened", "edited"].includes(payload.action)) {
    const jobData = { eventName: "issues", payload, deliveryId, receivedAt: Date.now() };
    await ctx.triageQueue.add("triage-issue", jobData, { priority: 1 });
    ctx.logger.info({ action: payload.action, issue: payload.issue?.number }, "Issue queued for triage");
  }
}
