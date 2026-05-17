// src/services/pipelineEvents.js
// Lightweight event recorder for the observability time-series.
// Every service calls record() to emit structured events.
// The telemetry API queries pipeline_events for dashboard charts.

import { db } from "../lib/db.js";
import { logger } from "../lib/logger.js";

/**
 * Record a pipeline event.
 * Non-fatal: errors are logged but never break the main flow.
 */
export async function record({
  repoId, eventType, actor, ref,
  prNumber, durationMs, success, metadata = {},
}) {
  try {
    await db.query(
      `INSERT INTO pipeline_events
         (repo_id, event_type, actor, ref, pr_number, duration_ms, success, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [repoId, eventType, actor ?? null, ref ?? null,
       prNumber ?? null, durationMs ?? null, success ?? null,
       JSON.stringify(metadata)]
    );
  } catch (err) {
    logger.debug({ err: err.message, eventType }, "pipeline_events: insert failed (non-fatal)");
  }
}

// ── Convenience wrappers ──────────────────────────────────────────────────────

export const Events = {
  ciRunCompleted:      (repoId, data) => record({ repoId, eventType: "ci_run_completed",       ...data }),
  prAdmitted:          (repoId, data) => record({ repoId, eventType: "pr_admitted",             ...data }),
  prMerged:            (repoId, data) => record({ repoId, eventType: "pr_merged",               ...data }),
  prBlocked:           (repoId, data) => record({ repoId, eventType: "pr_blocked",              ...data }),
  healAttempted:       (repoId, data) => record({ repoId, eventType: "heal_attempted",          ...data }),
  healSucceeded:       (repoId, data) => record({ repoId, eventType: "heal_succeeded",          ...data }),
  healFailed:          (repoId, data) => record({ repoId, eventType: "heal_failed",             ...data }),
  configFailed:        (repoId, data) => record({ repoId, eventType: "config_failed",           ...data }),
  feedbackSent:        (repoId, data) => record({ repoId, eventType: "feedback_sent",           ...data }),
  rollbackTriggered:   (repoId, data) => record({ repoId, eventType: "rollback_triggered",      ...data }),
  rollbackCompleted:   (repoId, data) => record({ repoId, eventType: "rollback_completed",      ...data }),
  violationRemediated: (repoId, data) => record({ repoId, eventType: "violation_remediated",    ...data }),
};
