// src/lib/webhookHandlers/handleCheckSuite.js
// Handler for "check_suite" webhook events.

export async function handleCheckSuite(payload, deliveryId, ctx) {
  if (payload.action === "completed") {
    const jobData = { eventName: "check_suite", payload, deliveryId, receivedAt: Date.now() };
    await ctx.phase2Queue.add("checks-updated", jobData, { priority: 1 });
  }
}
