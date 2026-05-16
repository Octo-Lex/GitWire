// src/routes/fix.js
// REST API for autonomous issue fix.
//
// POST /api/fix/:owner/:repo/issues/:number  — trigger fix
// GET  /api/fix/:owner/:repo/issues/:number  — get fix status
// GET  /api/fix/:owner/:repo/attempts         — list recent fix attempts

import { Router } from "express";
import { issueFixQueue } from "../lib/queue.js";
import { db } from "../lib/db.js";
import { logger } from "../lib/logger.js";

export const fixRouter = Router();

// ── Trigger a fix attempt ────────────────────────────────────────────────
fixRouter.post("/:owner/:repo/issues/:number", async (req, res) => {
  const { owner, repo, number: issueNumber } = req.params;
  const installationId = req.query.installation_id
    ? parseInt(req.query.installation_id, 10)
    : null;

  if (!installationId) {
    return res.status(400).json({ error: "installation_id query parameter required" });
  }

  const repoFullName = owner + "/" + repo;

  try {
    const job = await issueFixQueue.add("fix-issue", {
      repo: repoFullName,
      issueNumber: parseInt(issueNumber, 10),
      installationId: installationId,
      triggeredBy: "api",
    }, { priority: 1 });

    logger.info({ repo: repoFullName, issueNumber, jobId: job.id }, "Fix attempt triggered via API");

    res.status(202).json({
      queued: true,
      jobId: job.id,
      repo: repoFullName,
      issueNumber: parseInt(issueNumber, 10),
    });
  } catch (err) {
    logger.error({ err }, "Failed to queue fix attempt");
    res.status(500).json({ error: "Failed to queue fix attempt" });
  }
});

// ── Get fix status for an issue ──────────────────────────────────────────
fixRouter.get("/:owner/:repo/issues/:number", async (req, res) => {
  const { owner, repo, number: issueNumber } = req.params;
  const repoFullName = owner + "/" + repo;

  try {
    const { rows: repoRows } = await db.query(
      "SELECT github_id FROM repositories WHERE full_name = $1", [repoFullName]
    );
    if (!repoRows.length) {
      return res.status(404).json({ error: "Repo not found" });
    }

    const { rows } = await db.query(
      "SELECT * FROM fix_attempts WHERE repo_id = $1 AND issue_number = $2",
      [repoRows[0].github_id, parseInt(issueNumber, 10)]
    );

    if (!rows.length) {
      return res.json({ repo: repoFullName, issueNumber: parseInt(issueNumber, 10), attempts: [] });
    }

    res.json({ repo: repoFullName, issueNumber: parseInt(issueNumber, 10), attempts: rows });
  } catch (err) {
    logger.error({ err }, "Failed to get fix status");
    res.status(500).json({ error: "Failed to get fix status" });
  }
});

// ── List recent fix attempts for a repo ──────────────────────────────────
fixRouter.get("/:owner/:repo/attempts", async (req, res) => {
  const { owner, repo } = req.params;
  const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);
  const repoFullName = owner + "/" + repo;

  try {
    const { rows: repoRows } = await db.query(
      "SELECT github_id FROM repositories WHERE full_name = $1", [repoFullName]
    );
    if (!repoRows.length) {
      return res.status(404).json({ error: "Repo not found" });
    }

    const { rows } = await db.query(
      "SELECT id, issue_number, branch_name, pr_number, status, complexity, explanation, error, created_at, updated_at " +
      "FROM fix_attempts WHERE repo_id = $1 ORDER BY created_at DESC LIMIT $2",
      [repoRows[0].github_id, limit]
    );

    res.json({ repo: repoFullName, attempts: rows });
  } catch (err) {
    logger.error({ err }, "Failed to list fix attempts");
    res.status(500).json({ error: "Failed to list fix attempts" });
  }
});
