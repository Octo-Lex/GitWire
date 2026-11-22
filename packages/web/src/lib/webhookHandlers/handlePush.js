// src/lib/webhookHandlers/handlePush.js
// Handler for "push" webhook events.
// Triggers incremental repo sync and config cache invalidation.
//
// Nothing is enqueued to validate .gitwire.yml on push. No worker consumes
// such a job (startWebhookWorker handles sync-installation and sync-repo
// only), so an enqueue would only add a job that is stored and never
// processed. Validation runs on request instead: the policy preview API
// and the dashboard's playground.

import { invalidateConfigCache } from "../../services/configService.js";

export async function handlePush(payload, deliveryId, ctx) {
  const jobData = { eventName: "push", payload, deliveryId, receivedAt: Date.now() };

  await ctx.webhookQueue.add("sync-repo", jobData, { priority: 3 });

  // Invalidate .gitwire.yml cache if it changed in this push
  const changed = [
    ...(payload.head_commit?.added || []),
    ...(payload.head_commit?.modified || []),
  ];
  if (changed.some((f) => f === ".gitwire.yml" || f === ".github/.gitwire.yml")) {
    await invalidateConfigCache(payload.repository.full_name);
  }
}
