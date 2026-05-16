// src/index.js
// Entry point: starts the HTTP server + background workers.
// Handles graceful shutdown on SIGTERM/SIGINT.

import { createApp } from "./app.js";
import { startWebhookWorker } from "./workers/webhookWorker.js";
import { startTriageWorker }  from "./workers/triageWorker.js";
import { startCIHealWorker }  from "./workers/ciHealWorker.js";
import { startSyncWorker, scheduleSyncJobs } from "./workers/syncWorker.js";
import { startMaintainerWorker, scheduleMaintainerJobs } from "./workers/maintainerWorker.js";
import { startIssueFixWorker } from "./workers/issueFixWorker.js";
import { db }     from "./lib/db.js";
import { redis }  from "./lib/queue.js";
import { logger } from "./lib/logger.js";
import { config } from "../config/index.js";

async function main() {
  // ── Start HTTP server ────────────────────────────────────────────────────
  const app    = createApp();
  const server = app.listen(config.server.port, () => {
    logger.info(
      { port: config.server.port, env: config.server.env },
      "GitOps Hub server started"
    );
    logger.info(
      `Webhook endpoint: ${config.server.baseUrl}/webhooks/github`
    );
  });

  // ── Start background workers ─────────────────────────────────────────────
  const workers = [
    startWebhookWorker(),
    startTriageWorker(),
    startCIHealWorker(),
    startSyncWorker(),
    startMaintainerWorker(),
    startIssueFixWorker(),
  ];

  // Schedule the repeating full-sync (every 30 min + immediate startup run)
  await scheduleSyncJobs();

  // Schedule maintainer jobs (stale scan every 6h, branch cleanup daily)
  await scheduleMaintainerJobs();

  logger.info(`${workers.length} background workers started`);

  // ── Graceful shutdown ────────────────────────────────────────────────────
  async function shutdown(signal) {
    logger.info({ signal }, "Shutdown signal received");

    // Stop accepting new HTTP connections
    server.close();

    // Drain workers (finish current jobs, don't accept new ones)
    await Promise.all(workers.map((w) => w.close()));

    // Close DB and Redis
    await db.end();
    await redis.quit();

    logger.info("Graceful shutdown complete");
    process.exit(0);
  }

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT",  () => shutdown("SIGINT"));

  process.on("uncaughtException", (err) => {
    logger.fatal({ err }, "Uncaught exception — shutting down");
    shutdown("uncaughtException");
  });
}

main().catch((err) => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});
