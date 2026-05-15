// src/routes/insights.js
// GET /api/insights/overview      — top-level dashboard numbers
// GET /api/insights/repos         — per-repo health table
// GET /api/insights/velocity      — issue/PR close rate over time
// GET /api/insights/ci-trend      — CI pass rate trend per repo

import { Router } from "express";
import { db } from "../lib/db.js";

export const insightsRouter = Router();

// ── GET /api/insights/overview ────────────────────────────────────────────────
// Four summary cards at the top of the dashboard
insightsRouter.get("/overview", async (_req, res, next) => {
  try {
    const [repos, issues, prs, ci] = await Promise.all([
      db.query(`
        SELECT
          COUNT(*)                                          AS total,
          COUNT(CASE WHEN last_synced_at IS NOT NULL THEN 1 END) AS synced
        FROM repositories
      `),
      db.query(`
        SELECT
          COUNT(CASE WHEN state = 'open'   THEN 1 END) AS open,
          COUNT(CASE WHEN state = 'closed' THEN 1 END) AS closed,
          COUNT(CASE WHEN state = 'open' AND assignees = '{}' THEN 1 END) AS unassigned,
          COUNT(CASE WHEN triage_priority = 'critical' AND state = 'open' THEN 1 END) AS critical
        FROM issues
      `),
      db.query(`
        SELECT
          COUNT(CASE WHEN state = 'open'   THEN 1 END) AS open,
          COUNT(CASE WHEN state = 'merged' THEN 1 END) AS merged,
          COUNT(CASE WHEN draft = true AND state = 'open' THEN 1 END) AS draft
        FROM pull_requests
      `),
      db.query(`
        SELECT
          ROUND(
            100.0 * COUNT(CASE WHEN conclusion = 'success' THEN 1 END)
            / NULLIF(COUNT(*), 0)
          ) AS pass_rate,
          COUNT(CASE WHEN heal_status = 'healed' THEN 1 END) AS auto_healed,
          COUNT(CASE WHEN conclusion = 'failure' THEN 1 END) AS total_failures
        FROM ci_runs
        WHERE created_at > NOW() - INTERVAL '7 days'
      `),
    ]);

    res.json({
      repos:  repos.rows[0],
      issues: issues.rows[0],
      prs:    prs.rows[0],
      ci:     ci.rows[0],
    });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/insights/repos ───────────────────────────────────────────────────
// Per-repo health table for the "Multi-repository insights" panel
insightsRouter.get("/repos", async (_req, res, next) => {
  try {
    const { rows } = await db.query(`
      SELECT
        r.full_name,
        r.owner,
        r.name,
        r.language,
        r.stars,
        r.open_issues,
        r.open_prs,
        r.last_synced_at,

        -- CI pass rate (last 30 days)
        ROUND(
          100.0 * COUNT(CASE WHEN cr.conclusion = 'success' THEN 1 END)
          / NULLIF(COUNT(cr.id), 0)
        ) AS ci_pass_rate,

        -- Health status
        CASE
          WHEN COUNT(CASE WHEN cr.conclusion = 'failure' AND cr.heal_status != 'healed' THEN 1 END) > 3
            THEN 'at_risk'
          WHEN ROUND(
            100.0 * COUNT(CASE WHEN cr.conclusion = 'success' THEN 1 END)
            / NULLIF(COUNT(cr.id), 0)
          ) >= 90
            THEN 'healthy'
          WHEN ROUND(
            100.0 * COUNT(CASE WHEN cr.conclusion = 'success' THEN 1 END)
            / NULLIF(COUNT(cr.id), 0)
          ) >= 70
            THEN 'degraded'
          ELSE 'at_risk'
        END AS health_status,

        -- Issue staleness (>14 days without update)
        COUNT(CASE WHEN i.state = 'open' AND i.updated_at < NOW() - INTERVAL '14 days' THEN 1 END)
          AS stale_issues,

        -- Heal stats
        COUNT(CASE WHEN cr.heal_status = 'healed' THEN 1 END) AS healed_runs

      FROM repositories r
      LEFT JOIN ci_runs cr ON cr.repo_id = r.github_id
        AND cr.created_at > NOW() - INTERVAL '30 days'
      LEFT JOIN issues i ON i.repo_id = r.github_id
      GROUP BY r.id
      ORDER BY
        CASE
          WHEN COUNT(CASE WHEN cr.conclusion = 'failure' AND cr.heal_status != 'healed' THEN 1 END) > 3
            THEN 1
          ELSE 2
        END,
        r.full_name
    `);

    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// ── GET /api/insights/velocity ────────────────────────────────────────────────
// Issue + PR open/close rates over the last 30 days (for velocity chart)
insightsRouter.get("/velocity", async (_req, res, next) => {
  try {
    const { rows: issueVelocity } = await db.query(`
      SELECT
        DATE_TRUNC('day', created_at) AS day,
        COUNT(*) AS opened
      FROM issues
      WHERE created_at > NOW() - INTERVAL '30 days'
      GROUP BY 1 ORDER BY 1
    `);

    const { rows: prVelocity } = await db.query(`
      SELECT
        DATE_TRUNC('day', created_at) AS day,
        COUNT(*) AS opened,
        COUNT(CASE WHEN state = 'merged' THEN 1 END) AS merged
      FROM pull_requests
      WHERE created_at > NOW() - INTERVAL '30 days'
      GROUP BY 1 ORDER BY 1
    `);

    // Average time to close issues (in hours)
    const { rows: [timeToClose] } = await db.query(`
      SELECT
        ROUND(AVG(EXTRACT(EPOCH FROM (updated_at - created_at)) / 3600)) AS avg_hours_to_close
      FROM issues
      WHERE state = 'closed'
        AND updated_at > NOW() - INTERVAL '30 days'
    `);

    res.json({
      issue_velocity: issueVelocity,
      pr_velocity:    prVelocity,
      avg_hours_to_close_issue: timeToClose.avg_hours_to_close,
    });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/insights/ci-trend ────────────────────────────────────────────────
// Per-repo CI pass rate for the last 14 days (sparkline data)
insightsRouter.get("/ci-trend", async (_req, res, next) => {
  try {
    const { rows } = await db.query(`
      SELECT
        r.full_name,
        DATE_TRUNC('day', cr.created_at) AS day,
        ROUND(
          100.0 * COUNT(CASE WHEN cr.conclusion = 'success' THEN 1 END)
          / NULLIF(COUNT(*), 0)
        ) AS pass_rate,
        COUNT(*) AS total_runs
      FROM ci_runs cr
      JOIN repositories r ON r.github_id = cr.repo_id
      WHERE cr.created_at > NOW() - INTERVAL '14 days'
      GROUP BY r.full_name, DATE_TRUNC('day', cr.created_at)
      ORDER BY r.full_name, day
    `);

    // Group by repo for easy charting
    const byRepo = rows.reduce((acc, row) => {
      if (!acc[row.full_name]) acc[row.full_name] = [];
      acc[row.full_name].push({ day: row.day, pass_rate: row.pass_rate, total: row.total_runs });
      return acc;
    }, {});

    res.json(byRepo);
  } catch (err) {
    next(err);
  }
});
