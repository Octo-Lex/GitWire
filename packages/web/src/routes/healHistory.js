// src/routes/healHistory.js
// Exposes heal PR history and per-run patch details for the dashboard.
//
// GET /api/heal                     — paginated list of all heal PRs
// GET /api/heal/stats               — aggregate heal metrics
// GET /api/heal/:owner/:repo        — heal PRs for one repo
// GET /api/heal/run/:githubRunId    — single run heal detail

import { Router } from "express";
import { db } from "../lib/db.js";
import { paginationMiddleware } from "../middleware/pagination.js";

export const healRouter = Router();
healRouter.use(paginationMiddleware);

// ── GET /api/heal/stats ───────────────────────────────────────────────────────
healRouter.get("/stats", async (_req, res, next) => {
  try {
    const { rows } = await db.query(`
      SELECT
        COUNT(*)                                                AS total_heals,
        COUNT(CASE WHEN hp.status = 'merged' THEN 1 END)        AS merged,
        COUNT(CASE WHEN hp.status = 'open'   THEN 1 END)        AS open_prs,
        COUNT(CASE WHEN hp.status = 'closed' THEN 1 END)        AS closed_without_merge,
        COUNT(DISTINCT hp.repo_id)                              AS repos_healed,
        MODE() WITHIN GROUP (ORDER BY hp.failure_type)          AS most_common_failure
      FROM heal_prs hp
      WHERE hp.created_at > NOW() - INTERVAL '30 days'
    `);

    const { rows: byType } = await db.query(`
      SELECT failure_type, COUNT(*) AS count,
             COUNT(CASE WHEN status = 'merged' THEN 1 END) AS merged
      FROM heal_prs
      WHERE created_at > NOW() - INTERVAL '30 days'
      GROUP BY failure_type
      ORDER BY count DESC
    `);

    const { rows: trend } = await db.query(`
      SELECT DATE_TRUNC('day', created_at) AS day, COUNT(*) AS heals
      FROM heal_prs
      WHERE created_at > NOW() - INTERVAL '14 days'
      GROUP BY 1 ORDER BY 1
    `);

    res.json({ summary: rows[0], by_type: byType, trend });
  } catch (err) { next(err); }
});

// ── GET /api/heal ─────────────────────────────────────────────────────────────
healRouter.get("/", async (req, res, next) => {
  try {
    const { perPage, offset, paginated } = res.locals;
    const { status, failure_type, repo } = req.query;

    const conditions = [];
    const params     = [];
    const addParam   = (v) => { params.push(v); return "$" + params.length; };

    if (status)       conditions.push("hp.status = " + addParam(status));
    if (failure_type) conditions.push("hp.failure_type = " + addParam(failure_type));
    if (repo)         conditions.push("r.full_name = " + addParam(repo));

    const where = conditions.length ? "WHERE " + conditions.join(" AND ") : "";

    const { rows: [{ count }] } = await db.query(
      "SELECT COUNT(*) FROM heal_prs hp JOIN repositories r ON r.github_id = hp.repo_id " + where,
      params
    );

    params.push(perPage, offset);
    const pIdx = params.length - 1;

    const { rows } = await db.query(
      `SELECT
         hp.id, hp.github_pr_number, hp.github_pr_url,
         hp.heal_branch, hp.failure_type, hp.files_changed,
         hp.pr_title, hp.status, hp.created_at, hp.updated_at,
         r.full_name AS repo_full_name,
         r.owner AS repo_owner, r.name AS repo_name,
         cr.github_run_id, cr.workflow_name, cr.branch,
         cr.heal_root_cause, cr.heal_confidence
       FROM heal_prs hp
       JOIN repositories r  ON r.github_id   = hp.repo_id
       JOIN ci_runs      cr ON cr.id          = hp.ci_run_id
       ${where}
       ORDER BY hp.created_at DESC
       LIMIT $${pIdx + 1} OFFSET $${pIdx + 2}`,
      params
    );

    res.json(paginated(rows, count));
  } catch (err) { next(err); }
});

// ── GET /api/heal/:owner/:repo ────────────────────────────────────────────────
healRouter.get("/:owner/:repo", async (req, res, next) => {
  try {
    const { perPage, offset, paginated } = res.locals;
    const fullName = req.params.owner + "/" + req.params.repo;

    const { rows: [{ count }] } = await db.query(
      `SELECT COUNT(*) FROM heal_prs hp
       JOIN repositories r ON r.github_id = hp.repo_id
       WHERE r.full_name = $1`,
      [fullName]
    );

    const { rows } = await db.query(
      `SELECT hp.*, cr.github_run_id, cr.workflow_name, cr.branch,
              cr.heal_root_cause, cr.heal_confidence, cr.heal_failure_type
       FROM heal_prs hp
       JOIN repositories r ON r.github_id = hp.repo_id
       JOIN ci_runs      cr ON cr.id       = hp.ci_run_id
       WHERE r.full_name = $1
       ORDER BY hp.created_at DESC
       LIMIT $2 OFFSET $3`,
      [fullName, perPage, offset]
    );

    res.json(paginated(rows, count));
  } catch (err) { next(err); }
});

// ── GET /api/heal/run/:githubRunId — detail for one run ───────────────────────
healRouter.get("/run/:githubRunId", async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT cr.*, hp.github_pr_url, hp.github_pr_number,
              hp.heal_branch, hp.files_changed, hp.pr_title, hp.status AS pr_status,
              r.full_name AS repo_full_name
       FROM ci_runs cr
       JOIN repositories r ON r.github_id = cr.repo_id
       LEFT JOIN heal_prs hp ON hp.ci_run_id = cr.id
       WHERE cr.github_run_id = $1`,
      [req.params.githubRunId]
    );

    if (!rows.length) return res.status(404).json({ error: "Run not found" });
    res.json(rows[0]);
  } catch (err) { next(err); }
});
