// src/routes/duplicates.js
// REST API for the duplicate detection module.
//
// GET  /api/duplicates                    — all pending signals (cross-repo)
// GET  /api/duplicates/stats              — dashboard summary
// GET  /api/duplicates/:owner/:repo       — signals for one repo
// GET  /api/duplicates/issue/:issueId     — signals for a specific issue
// POST /api/duplicates/:id/confirm        — confirm a signal
// POST /api/duplicates/:id/dismiss        — dismiss a signal
// POST /api/duplicates/backfill/:owner/:repo — trigger embedding backfill

import { Router } from "express";
import { db } from "../lib/db.js";
import { getInstallationClient } from "../lib/github.js";
import {
  backfillEmbeddings,
  updateDuplicateStatus,
} from "../services/duplicateDetectionService.js";
import { paginationMiddleware } from "../middleware/pagination.js";
import { logger } from "../lib/logger.js";

export const duplicatesRouter = Router();
duplicatesRouter.use(paginationMiddleware);

// ── GET /api/duplicates/stats ─────────────────────────────────────────────────
duplicatesRouter.get("/stats", async (_req, res, next) => {
  try {
    const { rows: [summary] } = await db.query(`
      SELECT
        COUNT(*)                                                    AS total_signals,
        COUNT(CASE WHEN status = 'pending'   THEN 1 END)            AS pending,
        COUNT(CASE WHEN status = 'confirmed' THEN 1 END)            AS confirmed,
        COUNT(CASE WHEN status = 'dismissed' THEN 1 END)            AS dismissed,
        COUNT(CASE WHEN similarity >= 0.97   AND status = 'pending' THEN 1 END) AS near_identical,
        COUNT(DISTINCT source_issue_id)                             AS issues_flagged,
        COUNT(DISTINCT repo_id)                                     AS repos_affected,
        ROUND(AVG(similarity)::numeric, 3)                          AS avg_similarity
      FROM duplicate_signals
      WHERE created_at > NOW() - INTERVAL '30 days'
    `);

    // Embedding coverage
    const { rows: [coverage] } = await db.query(`
      SELECT
        COUNT(*)                                          AS total_open_issues,
        COUNT(embedding_id)                               AS embedded,
        ROUND(100.0 * COUNT(embedding_id) / NULLIF(COUNT(*),0)) AS coverage_pct
      FROM issues
      WHERE state = 'open'
    `);

    // Daily signal trend (last 14 days)
    const { rows: trend } = await db.query(`
      SELECT DATE_TRUNC('day', created_at) AS day, COUNT(*) AS signals
      FROM duplicate_signals
      WHERE created_at > NOW() - INTERVAL '14 days'
      GROUP BY 1 ORDER BY 1
    `);

    res.json({ summary, coverage, trend });
  } catch (err) { next(err); }
});

// ── GET /api/duplicates — cross-repo signal list ──────────────────────────────
duplicatesRouter.get("/", async (req, res, next) => {
  try {
    const { perPage, offset, paginated } = res.locals;
    const { status = "pending", repo, min_similarity } = req.query;

    const conditions = [];
    const params = [];
    const p = (v) => { params.push(v); return `$${params.length}`; };

    if (status) conditions.push(`ds.status = ${p(status)}`);
    if (repo) conditions.push(`r.full_name = ${p(repo)}`);
    if (min_similarity) conditions.push(`ds.similarity >= ${p(parseFloat(min_similarity))}`);

    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

    const { rows: [{ count }] } = await db.query(
      `SELECT COUNT(*) FROM duplicate_signals ds
       JOIN repositories r ON r.github_id = ds.repo_id ${where}`,
      params
    );

    // Re-build params for the data query (separate param array)
    const dataParams = [...params];
    const dp = (v) => { dataParams.push(v); return `$${dataParams.length}`; };

    const { rows } = await db.query(
      `SELECT
         ds.id, ds.similarity, ds.status, ds.comment_id,
         ds.created_at, ds.updated_at,
         si.number  AS source_number,
         si.title   AS source_title,
         si.state   AS source_state,
         ti.number  AS target_number,
         ti.title   AS target_title,
         ti.state   AS target_state,
         r.full_name AS repo_full_name,
         r.owner     AS repo_owner,
         r.name      AS repo_name
       FROM duplicate_signals ds
       JOIN issues      si ON si.github_id = ds.source_issue_id
       JOIN issues      ti ON ti.github_id = ds.target_issue_id
       JOIN repositories r ON r.github_id  = ds.repo_id
       ${where}
       ORDER BY ds.similarity DESC, ds.created_at DESC
       LIMIT ${dp(perPage)} OFFSET ${dp(offset)}`,
      dataParams
    );

    res.json(paginated(rows, count));
  } catch (err) { next(err); }
});

// ── GET /api/duplicates/:owner/:repo ─────────────────────────────────────────
duplicatesRouter.get("/:owner/:repo", async (req, res, next) => {
  try {
    const { perPage, offset, paginated } = res.locals;
    const fullName = `${req.params.owner}/${req.params.repo}`;
    const { status = "pending" } = req.query;

    const { rows: [{ count }] } = await db.query(
      `SELECT COUNT(*) FROM duplicate_signals ds
       JOIN repositories r ON r.github_id = ds.repo_id
       WHERE r.full_name = $1 AND ds.status = $2`,
      [fullName, status]
    );

    const { rows } = await db.query(
      `SELECT
         ds.id, ds.similarity, ds.status, ds.created_at,
         si.number AS source_number, si.title AS source_title, si.state AS source_state,
         ti.number AS target_number, ti.title AS target_title, ti.state AS target_state
       FROM duplicate_signals ds
       JOIN issues      si ON si.github_id = ds.source_issue_id
       JOIN issues      ti ON ti.github_id = ds.target_issue_id
       JOIN repositories r ON r.github_id  = ds.repo_id
       WHERE r.full_name = $1 AND ds.status = $2
       ORDER BY ds.similarity DESC
       LIMIT $3 OFFSET $4`,
      [fullName, status, perPage, offset]
    );

    res.json(paginated(rows, count));
  } catch (err) { next(err); }
});

// ── GET /api/duplicates/issue/:githubIssueId ──────────────────────────────────
// NOTE: Must come BEFORE /:owner/:repo and /:id/:action to avoid param conflicts
duplicatesRouter.get("/issue/:githubIssueId", async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT
         ds.id, ds.similarity, ds.status, ds.created_at,
         si.number AS source_number, si.title AS source_title,
         ti.number AS target_number, ti.title AS target_title, ti.state AS target_state,
         r.full_name AS repo_full_name
       FROM duplicate_signals ds
       JOIN issues      si ON si.github_id = ds.source_issue_id
       JOIN issues      ti ON ti.github_id = ds.target_issue_id
       JOIN repositories r ON r.github_id  = ds.repo_id
       WHERE ds.source_issue_id = $1
          OR ds.target_issue_id = $1
       ORDER BY ds.similarity DESC`,
      [req.params.githubIssueId]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// ── POST /api/duplicates/:id/confirm ─────────────────────────────────────────
// NOTE: Must come BEFORE /:owner/:repo
duplicatesRouter.post("/:id(\\d+)/confirm", async (req, res, next) => {
  try {
    const signal = await resolveSignalAndAct(req.params.id, "confirmed", req);
    if (!signal) return res.status(404).json({ error: "Signal not found" });
    res.json({ updated: true, status: "confirmed" });
  } catch (err) { next(err); }
});

// ── POST /api/duplicates/:id/dismiss ─────────────────────────────────────────
duplicatesRouter.post("/:id(\\d+)/dismiss", async (req, res, next) => {
  try {
    const signal = await resolveSignalAndAct(req.params.id, "dismissed", req);
    if (!signal) return res.status(404).json({ error: "Signal not found" });
    res.json({ updated: true, status: "dismissed" });
  } catch (err) { next(err); }
});

// ── POST /api/duplicates/backfill/:owner/:repo ────────────────────────────────
// NOTE: Must come BEFORE /:owner/:repo
duplicatesRouter.post("/backfill/:owner/:repo", async (req, res, next) => {
  try {
    const fullName = `${req.params.owner}/${req.params.repo}`;

    const { rows: [repoRow] } = await db.query(
      `SELECT github_id FROM repositories WHERE full_name = $1`, [fullName]
    );
    if (!repoRow) return res.status(404).json({ error: "Repository not found" });

    // Run in background — respond immediately
    res.json({ queued: true, repo: fullName });

    backfillEmbeddings({ repoId: repoRow.github_id, repoFullName: fullName })
      .then((done) => logger.info({ repo: fullName, done }, "Backfill complete"))
      .catch((err) => logger.error({ err }, "Backfill failed"));

  } catch (err) { next(err); }
});

// ── Shared helper ─────────────────────────────────────────────────────────────
async function resolveSignalAndAct(signalId, status, req) {
  const { rows: [signal] } = await db.query(
    `SELECT ds.*, r.owner AS repo_owner, r.name AS repo_name, r.installation_id
     FROM duplicate_signals ds
     JOIN repositories r ON r.github_id = ds.repo_id
     WHERE ds.id = $1`,
    [signalId]
  );
  if (!signal) return null;

  const octokit = await getInstallationClient(signal.installation_id);

  return updateDuplicateStatus({
    sourceIssueId: signal.source_issue_id,
    targetIssueId: signal.target_issue_id,
    status,
    octokit,
    owner: signal.repo_owner,
    repo: signal.repo_name,
  });
}
