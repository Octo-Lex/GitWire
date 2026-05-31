// src/lib/webhookHandlers/handleInstallation.js
// Handler for "installation" and "installation_repositories" webhook events.

export async function handleInstallation(payload, deliveryId, ctx) {
  const jobData = { eventName: "installation", payload, deliveryId, receivedAt: Date.now() };
  await ctx.webhookQueue.add("sync-installation", jobData);
}
