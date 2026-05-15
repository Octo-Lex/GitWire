// src/routes/pullRequests.js
// GET /api/pull-requests         — cross-repo PR list with triage data
// GET /api/pull-requests/:owner/:repo — repo-scoped PR list
// GET /api/pull-requests/stats   — aggregate counts for the dashboard

import { Router } from "express";
import { db } from "../lib/db.js";
import { paginationMiddleware } from "../middleware/pagination.js";

export const pullRequestsRouter = Router();
pullRequestsRouter.use(paginationMiddleware);

// ── GET /api/pull-requests/stats ──────────────────────────────────────────────
pullRequestsRouter.get("/stats", async (_req, res, next) => {
  try {
    const { rows } = await db.query(`
      SELECT
        COUNT(*)                                           AS total_open,
        COUNT(CASE WHEN draft = true     THEN 1 END)      AS draft,
        COUNT(CASE WHEN draft = false    THEN 1 END)      AS ready_for_review,
        COUNT(CASE WHEN triage_risk = 'high' THEN 1 END)  AS high_risk,
        COUNT(CASE WHEN triage_size IN ('size/L','size/XL') THEN 1 END) AS large
      FROM pull_requests
      WHERE state = 'open'
    `);

    const { rows: bySize } = await db.query(`
      SELECT COALESCE(triage_size, 'unclassified') AS size, COUNT(*) AS count
      FROM pull_requests WHERE state = 'open'
      GROUP BY triage_size
      ORDER BY count DESC
    `);

    res.json({ summary: rows[0], by_size: bySize });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/pull-requests — cross-repo PR triage list ───────────────────────
pullRequestsRouter.get("/", async (req, res, next) => {
  try {
    const { perPage, offset, paginated } = res.locals;
    const { state = "open", draft, risk, size, repo, search } = req.query;

    const conditions = [];
    const params     = [];
    const addParam   = (v) => { params.push(v); return `$${params.length}`; };

    conditions.push(`p.state = ${addParam(state)}`);
    if (draft !== undefined) conditions.push(`p.draft = ${addParam(draft === "true")}`);
    if (risk)   conditions.push(`p.triage_risk = ${addParam(risk)}`);
    if (size)   conditions.push(`p.triage_size = ${addParam(size)}`);
    if (repo)   conditions.push(`r.full_name = ${addParam(repo)}`);
    if (search) conditions.push(`p.title ILIKE ${addParam(`%${search}%`)}`);

    const where = `WHERE ${conditions.join(" AND ")}`;

    const { rows: [{ count }] } = await db.query(
      `SELECT COUNT(*) FROM pull_requests p
       JOIN repositories r ON r.github_id = p.repo_id ${where}`,
      params
    );

    const { rows } = await db.query(
      `SELECT
         p.github_id, p.number, p.title, p.state, p.draft,
         p.head_branch, p.base_branch, p.labels,
         p.triage_type, p.triage_size, p.triage_risk, p.triage_summary,
         p.triaged_at, p.created_at, p.updated_at,
         r.full_name AS repo_full_name,
         r.owner     AS repo_owner,
         r.name      AS repo_name
       FROM pull_requests p
       JOIN repositories r ON r.github_id = p.repo_id
       ${where}
       ORDER BY
         CASE p.triage_risk
           WHEN 'high'   THEN 1
           WHEN 'medium' THEN 2
           WHEN 'low'    THEN 3
           ELSE 4
         END,
         p.created_at DESC
       LIMIT ${addParam(perPage)} OFFSET ${addParam(offset)}`,
      params
    );

    res.json(paginated(rows, count));
  } catch (err) {
    next(err);
  }
});

// ── GET /api/pull-requests/:owner/:repo — repo-scoped ─────────────────────────
pullRequestsRouter.get("/:owner/:repo", async (req, res, next) => {
  try {
    const { perPage, offset, paginated } = res.locals;
    const fullName = `${req.params.owner}/${req.params.repo}`;
    const { state = "open" } = req.query;

    const { rows: [{ count }] } = await db.query(
      `SELECT COUNT(*) FROM pull_requests p
       JOIN repositories r ON r.github_id = p.repo_id
       WHERE r.full_name = $1 AND p.state = $2`,
      [fullName, state]
    );

    const { rows } = await db.query(
      `SELECT p.*
       FROM pull_requests p
       JOIN repositories r ON r.github_id = p.repo_id
       WHERE r.full_name = $1 AND p.state = $2
       ORDER BY p.created_at DESC
       LIMIT $3 OFFSET $4`,
      [fullName, state, perPage, offset]
    );

    res.json(paginated(rows, count));
  } catch (err) {
    next(err);
  }
});
