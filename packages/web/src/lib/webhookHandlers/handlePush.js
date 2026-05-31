// src/lib/webhookHandlers/handlePush.js
// Handler for "push" webhook events.
// Triggers incremental repo sync, config validation, and cache invalidation.

import { invalidateConfigCache } from "../../services/configService.js";

export async function handlePush(payload, deliveryId, ctx) {
  const jobData = { eventName: "push", payload, deliveryId, receivedAt: Date.now() };

  await ctx.webhookQueue.add("sync-repo", jobData, { priority: 3 });
  await ctx.webhookQueue.add("validate-configs", jobData, { priority: 2 });

  // Invalidate .gitwire.yml cache if it changed in this push
  const changed = [
    ...(payload.head_commit?.added || []),
    ...(payload.head_commit?.modified || []),
  ];
  if (changed.some((f) => f === ".gitwire.yml" || f === ".github/.gitwire.yml")) {
    await invalidateConfigCache(payload.repository.full_name);
  }
}
