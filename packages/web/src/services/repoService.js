// src/services/repoService.js
// Data access layer for repositories.
// All SQL lives here — routes stay thin.

import { db } from "../lib/db.js";

export const repoService = {
  /**
   * List all repos visible to the given installation(s).
   * Supports filtering, searching, and sorting.
   */
  async list({ installationId, search, language, sort = "updated_at", order = "desc", limit = 50, offset = 0 } = {}) {
    const conditions = ["r.deleted_at IS NULL"];
    const values = [];
    let i = 1;

    if (installationId) {
      conditions.push(`r.installation_id = $${i++}`);
      values.push(installationId);
    }
    if (search) {
      conditions.push(`r.full_name ILIKE $${i++}`);
      values.push(`%${search}%`);
    }
    if (language) {
      conditions.push(`r.language = $${i++}`);
      values.push(language);
    }

    const allowedSorts = ["updated_at", "stars", "open_issues", "open_prs", "name"];
    const safeSort  = allowedSorts.includes(sort) ? sort : "updated_at";
    const safeOrder = order === "asc" ? "ASC" : "DESC";

    values.push(limit, offset);

    const { rows } = await db.query(
      `SELECT
         r.*,
         i.account_login AS org,
         -- Pass rate from last 20 runs
         ROUND(
           100.0 * COUNT(CASE WHEN cr.conclusion = 'success' THEN 1 END)
           / NULLIF(COUNT(cr.id), 0)
         ) AS ci_pass_rate,
         COUNT(cr.id) AS ci_run_count
       FROM repositories r
       JOIN installations i ON i.github_id = r.installation_id
       LEFT JOIN ci_runs cr ON cr.repo_id = r.github_id
         AND cr.created_at > NOW() - INTERVAL '7 days'
       WHERE ${conditions.join(" AND ")}
       GROUP BY r.id, i.account_login
       ORDER BY r.${safeSort} ${safeOrder}
       LIMIT $${i++} OFFSET $${i++}`,
      values
    );

    return rows;
  },

  /**
   * Get a single repo by owner/name, with full stats.
   */
  async getByFullName(fullName) {
    const { rows } = await db.query(
      `SELECT
         r.*,
         i.account_login AS org,
         -- Open issue / PR counts from our DB (faster than GitHub API)
         (SELECT COUNT(*) FROM issues     WHERE repo_id = r.github_id AND state = 'open') AS open_issue_count,
         (SELECT COUNT(*) FROM pull_requests WHERE repo_id = r.github_id AND state = 'open') AS open_pr_count,
         -- CI stats (last 30 days)
         (SELECT COUNT(*)  FROM ci_runs WHERE repo_id = r.github_id AND created_at > NOW() - INTERVAL '30 days') AS ci_total_runs,
         (SELECT COUNT(*)  FROM ci_runs WHERE repo_id = r.github_id AND conclusion = 'failure' AND created_at > NOW() - INTERVAL '30 days') AS ci_failed_runs,
         (SELECT COUNT(*)  FROM ci_runs WHERE repo_id = r.github_id AND heal_status = 'healed') AS ci_healed_runs
       FROM repositories r
       JOIN installations i ON i.github_id = r.installation_id
       WHERE r.full_name = $1 AND r.deleted_at IS NULL`,
      [fullName]
    );
    return rows[0] ?? null;
  },

  /**
   * Aggregate stats across all repos for the multi-repo insights panel.
   */
  async getInsightsSummary(installationId) {
    const condition = installationId ? `AND r.installation_id = $1` : "";
    const values    = installationId ? [installationId] : [];

    const { rows } = await db.query(
      `SELECT
         COUNT(DISTINCT r.id)                                              AS total_repos,
         COALESCE(SUM(r.open_issues), 0)                                  AS total_open_issues,
         (SELECT COUNT(*) FROM pull_requests pr
            JOIN repositories rr ON rr.github_id = pr.repo_id
            WHERE pr.state = 'open' ${installationId ? "AND rr.installation_id = $1" : ""}) AS total_open_prs,
         ROUND(
           100.0 * COUNT(CASE WHEN cr.conclusion = 'success' THEN 1 END)
           / NULLIF(COUNT(cr.id), 0)
         )                                                                 AS ci_pass_rate,
         COUNT(CASE WHEN cr.heal_status = 'healed' THEN 1 END)            AS total_healed_runs,
         COUNT(CASE WHEN cr.conclusion = 'failure'
                     AND cr.heal_status = 'pending' THEN 1 END)           AS active_failures
       FROM repositories r
       LEFT JOIN ci_runs cr ON cr.repo_id = r.github_id
         AND cr.created_at > NOW() - INTERVAL '7 days'
       WHERE r.deleted_at IS NULL ${condition}`,
      values
    );
    return rows[0];
  },

  /**
   * Health score per repo (for the insights table).
   * Returns repos sorted by health score ascending (worst first).
   */
  async getHealthScores(installationId) {
    const condition = installationId ? `WHERE r.installation_id = $1 AND r.deleted_at IS NULL` : `WHERE r.deleted_at IS NULL`;
    const values    = installationId ? [installationId] : [];

    const { rows } = await db.query(
      `SELECT
         r.full_name,
         r.language,
         r.stars,
         r.last_synced_at,
         COUNT(DISTINCT i.id)  FILTER (WHERE i.state = 'open')                     AS open_issues,
         COUNT(DISTINCT pr.id) FILTER (WHERE pr.state = 'open')                    AS open_prs,
         COUNT(cr.id)          FILTER (WHERE cr.conclusion = 'failure'
                                        AND cr.created_at > NOW() - INTERVAL '7 days') AS recent_failures,
         ROUND(
           100.0 * COUNT(cr.id) FILTER (WHERE cr.conclusion = 'success' AND cr.created_at > NOW() - INTERVAL '7 days')
           / NULLIF(COUNT(cr.id) FILTER (WHERE cr.created_at > NOW() - INTERVAL '7 days'), 0)
         )                                                                           AS ci_pass_rate,
         -- Health score: 100 - deductions
         GREATEST(0,
           100
           - LEAST(30, COUNT(DISTINCT i.id)  FILTER (WHERE i.state = 'open') * 2)
           - LEAST(20, COUNT(DISTINCT pr.id) FILTER (WHERE pr.state = 'open' AND pr.created_at < NOW() - INTERVAL '7 days') * 5)
           - LEAST(40, COUNT(cr.id) FILTER (WHERE cr.conclusion = 'failure' AND cr.created_at > NOW() - INTERVAL '7 days') * 10)
         )                                                                           AS health_score
       FROM repositories r
       LEFT JOIN issues         i  ON i.repo_id  = r.github_id
       LEFT JOIN pull_requests  pr ON pr.repo_id = r.github_id
       LEFT JOIN ci_runs        cr ON cr.repo_id = r.github_id
       ${condition}
       GROUP BY r.id
       ORDER BY health_score ASC`,
      values
    );
    return rows;
  },
};
