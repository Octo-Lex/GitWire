// src/lib/webhookHandlers/handlePullRequestReview.js
// Handler for "pull_request_review" webhook events.

export async function handlePullRequestReview(payload, deliveryId, ctx) {
  if (payload.action === "submitted" && payload.review?.state === "approved") {
    const jobData = { eventName: "pull_request_review", payload, deliveryId, receivedAt: Date.now() };
    await ctx.phase2Queue.add("review-submitted", jobData, { priority: 2 });
  }
}
