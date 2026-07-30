// src/workers/webhookWorker.js
// Processes general webhook events from the webhook-events queue.
// Handles: installation sync, repo sync, generic events.

import { createWorker, QUEUES } from "../lib/queue.js";
import { db } from "../lib/db.js";
import { getInstallationClient } from "../lib/github.js";
import { logger } from "../lib/logger.js";
import { adoptWorker, workerPrincipalId } from "../services/auth/workerAdoption.js";

export function startWebhookWorker() {
  return createWorker(QUEUES.WEBHOOK_EVENTS, async (job) => {
    const { eventName, payload } = job.data;

    // Wave 2: resolve trusted installation principal from the webhook-verified
    // payload. The installation.id was placed in the job data by the webhook
    // ingress route after HMAC verification — it is trusted. Any principal/auth
    // fields in the payload are non-authoritative metadata and ignored.
    const adoption = await adoptWorker({
      workerId: "worker:webhook",
      permission: "installation:read",
      resourceType: "installation",
      installationId: payload?.installation?.id,
      jobData: job.data,
      legacyActor: payload?.sender?.login,
    });
    const principalId = workerPrincipalId(adoption.context);

    switch (job.name) {
      case "sync-installation":
        await handleInstallationSync(payload, principalId);
        break;
      case "sync-repo":
        await handleRepoSync(payload, principalId);
        break;
      default:
        logger.debug({ event: eventName, jobName: job.name }, "Generic event logged");
    }
  });
}

// ── Upsert installation record ───────────────────────────────────────────────
async function handleInstallationSync(payload, principalId) {
  const installation = payload.installation;
  if (!installation) return;

  const { action } = payload;

  if (action === "deleted") {
    await db.query(
      `UPDATE installations SET deleted_at = NOW() WHERE github_id = $1`,
      [installation.id]
    );
    logger.info({ installationId: installation.id }, "Installation marked deleted");
    return;
  }

  await db.query(
    `INSERT INTO installations (github_id, account_login, account_type, target_id, created_at, updated_at)
     VALUES ($1, $2, $3, $4, NOW(), NOW())
     ON CONFLICT (github_id) DO UPDATE SET
       account_login = EXCLUDED.account_login,
       updated_at    = NOW()`,
    [
      installation.id,
      installation.account.login,
      installation.account.type,
      installation.target_id,
    ]
  );

  logger.info(
    { installationId: installation.id, org: installation.account.login },
    "Installation synced"
  );
}

// ── Upsert repository record on push ────────────────────────────────────────
async function handleRepoSync(payload, principalId) {
  const repo         = payload.repository;
  const installation = payload.installation;
  if (!repo || !installation) return;

  await db.query(
    `INSERT INTO repositories
       (github_id, installation_id, full_name, owner, name, private, default_branch, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
     ON CONFLICT (github_id) DO UPDATE SET
       full_name      = EXCLUDED.full_name,
       default_branch = EXCLUDED.default_branch,
       updated_at     = NOW()`,
    [
      repo.id,
      installation.id,
      repo.full_name,
      repo.owner.login,
      repo.name,
      repo.private,
      repo.default_branch,
    ]
  );

  logger.info({ repo: repo.full_name }, "Repository synced from push event");
}
