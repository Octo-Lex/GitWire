// src/services/ciService.js
import { db } from "../lib/db.js";
import { logger } from "../lib/logger.js";

export const ciService = {
  /**
   * List recent CI runs, optionally filtered by repo or heal status.
   */
  async list({
    repoFullName,
    installationId,
    conclusion,
    healStatus,
    branch,
    limit = 50,
    offset = 0,
  } = {}) {
    const conditions = [];
    const values     = [];
    let   idx        = 1;

    if (repoFullName) {
      conditions.push(`r.full_name = $${idx++}`);
      values.push(repoFullName);
    }
    if (installationId) {
      conditions.push(`r.installation_id = $${idx++}`);
      values.push(installationId);
    }
    if (conclusion) {
      conditions.push(`cr.conclusion = $${idx++}`);
      values.push(conclusion);
    }
    if (healStatus) {
      conditions.push(`cr.heal_status = $${idx++}`);
      values.push(healStatus);
    }
    if (branch) {
      conditions.push(`cr.branch = $${idx++}`);
      values.push(branch);
    }

    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    values.push(limit, offset);

    const { rows } = await db.query(
      `SELECT
         cr.*,
         r.full_name AS repo_full_name,
         r.owner,
         r.name AS repo_name
       FROM ci_runs cr
       JOIN repositories r ON r.github_id = cr.repo_id
       ${where}
       ORDER BY cr.created_at DESC
       LIMIT $${idx++} OFFSET $${idx++}`,
      values
    );
    return rows;
  },

  /**
   * Healing summary for the self-healing CI panel.
   */
  async getHealingSummary(installationId) {
    const condition = installationId
      ? `AND r.installation_id = $1`
      : "";
    const values = installationId ? [installationId] : [];

    const { rows } = await db.query(
      `SELECT
         COUNT(*)                                               AS total_failures,
         COUNT(*) FILTER (WHERE cr.heal_status = 'healed')     AS healed,
         COUNT(*) FILTER (WHERE cr.heal_status = 'attempted')  AS in_progress,
         COUNT(*) FILTER (WHERE cr.heal_status = 'failed')     AS heal_failed,
         COUNT(*) FILTER (WHERE cr.heal_status = 'skipped')    AS skipped,
         COUNT(*) FILTER (WHERE cr.heal_status = 'pending')    AS pending,
         -- Most common failure types
         MODE() WITHIN GROUP (ORDER BY cr.heal_failure_type)   AS top_failure_type
       FROM ci_runs cr
       JOIN repositories r ON r.github_id = cr.repo_id
       WHERE cr.conclusion = 'failure'
         AND cr.created_at > NOW() - INTERVAL '30 days'
         ${condition}`,
      values
    );
    return rows[0];
  },

  /**
   * Per-repo CI pass rate trend (last 14 days, daily buckets).
   */
  async getPassRateTrend(repoFullName, days = 14) {
    const { rows } = await db.query(
      `SELECT
         DATE_TRUNC('day', cr.created_at)                        AS day,
         COUNT(*)                                                 AS total,
         COUNT(*) FILTER (WHERE cr.conclusion = 'success')       AS passed,
         ROUND(
           100.0 * COUNT(*) FILTER (WHERE cr.conclusion = 'success')
           / NULLIF(COUNT(*), 0)
         )                                                        AS pass_rate
       FROM ci_runs cr
       JOIN repositories r ON r.github_id = cr.repo_id
       WHERE r.full_name = $1
         AND cr.created_at > NOW() - ($2 || ' days')::INTERVAL
       GROUP BY day
       ORDER BY day`,
      [repoFullName, days]
    );
    return rows;
  },

  /**
   * Update healing outcome (called by the ciHealWorker after diagnosis).
   */
  async saveHealResult(githubRunId, { status, failureType, rootCause, fixApplied, confidence }) {
    // Best-effort: only UPDATE if the row exists (the heal worker creates it via upsertCIRun)
    const { rowCount } = await db.query(
      `UPDATE ci_runs SET
         heal_status       = $1,
         heal_failure_type = $2,
         heal_root_cause   = $3,
         heal_fix_applied  = $4,
         heal_confidence   = $5,
         healed_at         = CASE WHEN $1 = 'healed' THEN NOW() ELSE NULL END,
         updated_at        = NOW()
       WHERE github_run_id = $6`,
      [status, failureType, rootCause, fixApplied, confidence, githubRunId]
    );
    if (rowCount === 0) {
      logger.warn({ githubRunId }, 'saveHealResult: no ci_runs row found — heal worker upsertCIRun may have failed');
    }
  },
};
