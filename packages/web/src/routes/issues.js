// src/routes/issues.js
// GET  /api/issues               — list issues across all repos (triage queue view)
// GET  /api/issues/:owner/:repo  — list issues for a specific repo
// GET  /api/issues/stats         — aggregate counts by type/priority for dashboard

import { Router } from "express";
import { db } from "../lib/db.js";
import { paginationMiddleware } from "../middleware/pagination.js";

export const issuesRouter = Router();
issuesRouter.use(paginationMiddleware);

// ── GET /api/issues/stats — dashboard summary card ────────────────────────────
issuesRouter.get("/stats", async (_req, res, next) => {
  try {
    const { rows } = await db.query(`
      SELECT
        COUNT(*)                                          AS total_open,
        COUNT(CASE WHEN assignees = '{}'  THEN 1 END)    AS unassigned,
        COUNT(CASE WHEN triage_priority = 'critical' THEN 1 END) AS critical,
        COUNT(CASE WHEN triage_priority = 'high'     THEN 1 END) AS high,
        COUNT(CASE WHEN triage_type = 'bug'         THEN 1 END)  AS bugs,
        COUNT(CASE WHEN triage_type = 'feature'     THEN 1 END)  AS features,
        COUNT(CASE WHEN updated_at < NOW() - INTERVAL '14 days' THEN 1 END) AS stale
      FROM issues
      WHERE state = 'open'
    `);

    // Type distribution for chart
    const { rows: byType } = await db.query(`
      SELECT COALESCE(triage_type, 'untriaged') AS type, COUNT(*) AS count
      FROM issues WHERE state = 'open'
      GROUP BY triage_type ORDER BY count DESC
    `);

    res.json({ summary: rows[0], by_type: byType });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/issues — cross-repo triage list ──────────────────────────────────
issuesRouter.get("/", async (req, res, next) => {
  try {
    const { perPage, offset, paginated } = res.locals;
    const {
      state        = "open",
      priority,
      type,
      unassigned,
      stale,
      repo,
      search,
    } = req.query;

    const conditions = [];
    const params     = [];

    const addParam = (val) => { params.push(val); return `$${params.length}`; };

    conditions.push(`i.state = ${addParam(state)}`);
    if (priority)   conditions.push(`i.triage_priority = ${addParam(priority)}`);
    if (type)       conditions.push(`i.triage_type = ${addParam(type)}`);
    if (unassigned === "true") conditions.push(`i.assignees = '{}'`);
    if (stale === "true")      conditions.push(`i.updated_at < NOW() - INTERVAL '14 days'`);
    if (repo)       conditions.push(`r.full_name = ${addParam(repo)}`);
    if (search)     conditions.push(`i.title ILIKE ${addParam(`%${search}%`)}`);

    const where = `WHERE ${conditions.join(" AND ")}`;

    const { rows: [{ count }] } = await db.query(
      `SELECT COUNT(*) FROM issues i JOIN repositories r ON r.github_id = i.repo_id ${where}`,
      params
    );

    const { rows } = await db.query(
      `SELECT
         i.github_id, i.number, i.title, i.state,
         i.labels, i.assignees,
         i.triage_type, i.triage_priority, i.triage_summary,
         i.triaged_at, i.created_at, i.updated_at,
         r.full_name AS repo_full_name,
         r.owner     AS repo_owner,
         r.name      AS repo_name
       FROM issues i
       JOIN repositories r ON r.github_id = i.repo_id
       ${where}
       ORDER BY
         CASE i.triage_priority
           WHEN 'critical' THEN 1
           WHEN 'high'     THEN 2
           WHEN 'medium'   THEN 3
           WHEN 'low'      THEN 4
           ELSE 5
         END,
         i.created_at DESC
       LIMIT ${addParam(perPage)} OFFSET ${addParam(offset)}`,
      params
    );

    res.json(paginated(rows, count));
  } catch (err) {
    next(err);
  }
});

// ── GET /api/issues/:owner/:repo — repo-scoped issue list ─────────────────────
issuesRouter.get("/:owner/:repo", async (req, res, next) => {
  try {
    const { perPage, offset, paginated } = res.locals;
    const fullName = `${req.params.owner}/${req.params.repo}`;
    const { state = "open" } = req.query;

    const { rows: [{ count }] } = await db.query(
      `SELECT COUNT(*) FROM issues i
       JOIN repositories r ON r.github_id = i.repo_id
       WHERE r.full_name = $1 AND i.state = $2`,
      [fullName, state]
    );

    const { rows } = await db.query(
      `SELECT i.*
       FROM issues i
       JOIN repositories r ON r.github_id = i.repo_id
       WHERE r.full_name = $1 AND i.state = $2
       ORDER BY i.created_at DESC
       LIMIT $3 OFFSET $4`,
      [fullName, state, perPage, offset]
    );

    res.json(paginated(rows, count));
  } catch (err) {
    next(err);
  }
});
