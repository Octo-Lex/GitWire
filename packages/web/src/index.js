// src/index.js
// Entry point: starts the HTTP server + background workers.
// Handles graceful shutdown on SIGTERM/SIGINT.

import { createApp } from "./app.js";
import { startWebhookWorker } from "./workers/webhookWorker.js";
import { startTriageWorker }  from "./workers/triageWorker.js";
import { startCIHealWorker }  from "./workers/ciHealWorker.js";
import { startCIEvidenceWorker } from "./workers/ciEvidenceWorker.js";
import { startDiagnosisWorker } from "./workers/diagnosisWorker.js";
import { startPatchWorker } from "./workers/patchWorker.js";
import { startVerificationWorker } from "./workers/verificationWorker.js";
import { startCriticWorker } from "./workers/criticWorker.js";
import { startSyncWorker, scheduleSyncJobs } from "./workers/syncWorker.js";
import { startMaintainerWorker, scheduleMaintainerJobs } from "./workers/maintainerWorker.js";
import { startIssueFixWorker } from "./workers/issueFixWorker.js";
import { startMergeQueueWorker } from "./workers/phase2Worker.js";
import { startPhase3Worker, schedulePhase3Jobs } from "./workers/phase3Worker.js";
import { startPhase4Worker, schedulePhase4Jobs } from "./workers/phase4Worker.js";
import { runReconciliation } from "./workers/reconciliationWorker.js";
import { initRuntime, getRuntime } from "@gitwire/runtime";
import { config } from "../config/index.js";
import { createGracefulShutdown } from "./lib/gracefulShutdown.js";

async function main() {
  // ── Initialize runtime infrastructure (db, redis, logger, github) ────────
  initRuntime(config);
  const { db, redis, logger } = getRuntime();
  // ── Start HTTP server ────────────────────────────────────────────────────
  const app    = createApp();
  const server = app.listen(config.server.port, () => {
    logger.info(
      { port: config.server.port, env: config.server.env },
      "GitWire server started"
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
    startCIEvidenceWorker(),
    startDiagnosisWorker(),
    startPatchWorker(),
    startVerificationWorker(),
    startCriticWorker(),
    startSyncWorker(),
    startMaintainerWorker(),
    startIssueFixWorker(),
    startMergeQueueWorker(),
    startPhase3Worker(),
    startPhase4Worker(),
  ];

  // Schedule the repeating full-sync (every 30 min + immediate startup run)
  await scheduleSyncJobs();

  // Schedule maintainer jobs (stale scan every 6h, branch cleanup daily)
  await scheduleMaintainerJobs();

  // Schedule Phase 3 recurring jobs (policy reconciliation nightly, dep scan weekly, graduation weekly)
  await schedulePhase3Jobs();

  // Schedule Phase 4 recurring jobs (nightly audit export at 01:00 UTC)
  await schedulePhase4Jobs();

  // Schedule reconciliation scan (every 6 hours)
  setInterval(async () => {
    try { await runReconciliation(); } catch (err) { logger.error({ err }, "Reconciliation failed"); }
  }, 6 * 60 * 60 * 1000);
  // Run first scan after 5 minutes
  setTimeout(() => runReconciliation().catch((err) => logger.error({ err }, "Initial reconciliation failed")), 5 * 60 * 1000);

  logger.info(workers.length + " background workers started");

  // ── Graceful shutdown ────────────────────────────────────────────────────
  // Idempotent + bounded orchestrator. Fixes the CT 115 crash-loop where an
  // uncaughtException triggered shutdown(), which threw on db.end() ("Called
  // end on pool more than once"), which became a new uncaughtException, which
  // re-entered shutdown() — looping forever with the process never exiting
  // and never serving. Invariant: uncaughtException → ONE shutdown attempt →
  // process exits (code 1), so Docker's restart policy brings it back clean.
  const shutdown = createGracefulShutdown({ server, workers, db, redis, logger });

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT",  () => shutdown("SIGINT"));

  process.on("uncaughtException", (err) => {
    logger.fatal({ err }, "Uncaught exception — shutting down");
    shutdown("uncaughtException");
  });

  process.on("unhandledRejection", (reason) => {
    // Serialize the reason properly — Error objects, AbortError, DOMException,
    // and plain objects all need different treatment. Without this, the log
    // shows reason: {} which is useless for debugging.
    const serialized = reason instanceof Error
      ? { name: reason.name, message: reason.message, stack: reason.stack }
      : (typeof reason === "string" ? reason : JSON.stringify(reason));
    logger.fatal({ reason: serialized }, "Unhandled rejection — shutting down");
    shutdown("unhandledRejection");
  });
}

main().catch((err) => {
  logger.error({ err }, "Fatal startup error");
  process.exit(1);
});
