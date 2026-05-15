// src/routes/repos.js
// GET /api/repos                — list all repos with health summary
// GET /api/repos/:owner/:repo   — single repo detail
// POST /api/repos/:owner/:repo/sync — trigger an on-demand sync

import { Router } from "express";
import { db } from "../lib/db.js";
import { syncQueue } from "../lib/queue.js";
import { paginationMiddleware } from "../middleware/pagination.js";

export const reposRouter = Router();
reposRouter.use(paginationMiddleware);

// ── GET /api/repos ────────────────────────────────────────────────────────────
reposRouter.get("/", async (req, res, next) => {
  try {
    const { perPage, offset, paginated } = res.locals;

    // Optional filters
    const { installation_id, language, search } = req.query;

    const conditions = ["r.deleted_at IS NULL"];
    const params     = [];

    if (installation_id) {
      params.push(installation_id);
      conditions.push(`r.installation_id = $${params.length}`);
    }
    if (language) {
      params.push(language);
      conditions.push(`r.language = $${params.length}`);
    }
    if (search) {
      params.push(`%${search}%`);
      conditions.push(`r.full_name ILIKE $${params.length}`);
    }

    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

    // Count query
    const { rows: [{ count }] } = await db.query(
      `SELECT COUNT(*) FROM repositories r ${where}`,
      params
    );

    // Data query with health metrics
    const { rows } = await db.query(
      `SELECT
         r.github_id, r.full_name, r.owner, r.name, r.private,
         r.default_branch, r.language, r.stars,
         r.open_issues, r.open_prs, r.last_synced_at, r.updated_at,

         -- CI health: % of last 10 runs that passed
         ROUND(
           100.0 * COUNT(CASE WHEN cr.conclusion = 'success' THEN 1 END)
           / NULLIF(COUNT(cr.github_run_id), 0)
         ) AS ci_pass_rate,

         -- Last run status
         (SELECT conclusion FROM ci_runs
          WHERE repo_id = r.github_id
          ORDER BY created_at DESC LIMIT 1) AS last_ci_conclusion,

         -- Self-heal stats
         COUNT(CASE WHEN cr.heal_status = 'healed' THEN 1 END) AS healed_runs,
         COUNT(CASE WHEN cr.heal_status = 'failed'  THEN 1 END) AS failed_heal_runs

       FROM repositories r
       LEFT JOIN LATERAL (
         SELECT github_run_id, conclusion, heal_status
         FROM ci_runs
         WHERE repo_id = r.github_id
         ORDER BY created_at DESC
         LIMIT 10
       ) cr ON TRUE
       ${where}
       GROUP BY r.id
       ORDER BY r.full_name
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, perPage, offset]
    );

    res.json(paginated(rows, count));
  } catch (err) {
    next(err);
  }
});

// ── GET /api/repos/:owner/:repo ───────────────────────────────────────────────
reposRouter.get("/:owner/:repo", async (req, res, next) => {
  try {
    const fullName = `${req.params.owner}/${req.params.repo}`;

    const { rows } = await db.query(
      `SELECT
         r.*,
         -- Issue breakdown
         COUNT(DISTINCT CASE WHEN i.state = 'open' THEN i.id END)   AS open_issue_count,
         COUNT(DISTINCT CASE WHEN i.state = 'closed' THEN i.id END) AS closed_issue_count,
         -- PR breakdown
         COUNT(DISTINCT CASE WHEN p.state = 'open'   THEN p.id END) AS open_pr_count,
         COUNT(DISTINCT CASE WHEN p.state = 'merged' THEN p.id END) AS merged_pr_count,
         -- CI
         ROUND(
           100.0 * COUNT(DISTINCT CASE WHEN cr.conclusion = 'success' THEN cr.id END)
           / NULLIF(COUNT(DISTINCT cr.id), 0)
         ) AS ci_pass_rate
       FROM repositories r
       LEFT JOIN issues        i  ON i.repo_id = r.github_id
       LEFT JOIN pull_requests p  ON p.repo_id = r.github_id
       LEFT JOIN ci_runs       cr ON cr.repo_id = r.github_id
         AND cr.created_at > NOW() - INTERVAL '30 days'
       WHERE r.full_name = $1
       GROUP BY r.id`,
      [fullName]
    );

    if (!rows.length) return res.status(404).json({ error: "Repository not found" });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// ── POST /api/repos/:owner/:repo/sync — trigger immediate sync ────────────────
reposRouter.post("/:owner/:repo/sync", async (req, res, next) => {
  try {
    const fullName = `${req.params.owner}/${req.params.repo}`;

    const { rows } = await db.query(
      `SELECT installation_id FROM repositories WHERE full_name = $1`,
      [fullName]
    );
    if (!rows.length) return res.status(404).json({ error: "Repository not found" });

    const job = await syncQueue.add("sync-repo", {
      installationId: rows[0].installation_id,
      repoFullName:   fullName,
    });

    res.status(202).json({ queued: true, jobId: job.id });
  } catch (err) {
    next(err);
  }
});
