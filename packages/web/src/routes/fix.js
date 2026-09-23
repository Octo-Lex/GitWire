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
import {
  buildIssueFixJob,
  enqueueIssueFixJob,
  parseIssueNumber,
} from "../services/issueFixJobService.js";
import { resolveIssueFixRepositoryByFullName } from "../services/issueFixTargetService.js";

export const fixRouter = Router();

// ── Trigger a fix attempt ────────────────────────────────────────────────
fixRouter.post("/:owner/:repo/issues/:number", async (req, res) => {
  const { owner, repo, number } = req.params;
  const issueNumber = parseIssueNumber(number);
  if (!issueNumber) {
    return res.status(400).json({ error: "issue number must be a positive integer" });
  }

  const repoFullName = owner + "/" + repo;

  try {
    // D0-02: callers identify only the target repository. The GitHub App
    // installation is resolved from current server-owned state and is never
    // accepted from query/body data as execution authority.
    const resolution = await resolveIssueFixRepositoryByFullName(repoFullName);
    if (resolution.status === "invalid") {
      return res.status(400).json({ error: "Invalid repository name" });
    }
    if (resolution.status === "not_found") {
      return res.status(404).json({ error: "Repo not found or installation inactive" });
    }
    if (resolution.status === "ambiguous") {
      logger.error({ repo: repoFullName }, "Ambiguous active repository mapping — refusing issue fix");
      return res.status(409).json({ error: "Ambiguous repository mapping" });
    }

    if (req.query.installation_id != null) {
      logger.warn(
        { repo: repoFullName },
        "Ignoring legacy installation_id on issue-fix request; installation authority is server-owned",
      );
    }

    const jobData = buildIssueFixJob({
      repository: resolution.repository,
      issueNumber,
      triggerKind: "api",
      requestedByPrincipalId: req.auth?.principalId ?? undefined,
    });
    const job = await enqueueIssueFixJob(issueFixQueue, jobData, { priority: 1 });

    logger.info({ repo: repoFullName, issueNumber, jobId: job.id }, "Fix attempt triggered via API");

    res.status(202).json({
      queued: true,
      status: "queued",
      jobId: job.id,
      repo: repoFullName,
      issueNumber,
    });
  } catch (err) {
    logger.error({ err, repo: repoFullName, issueNumber }, "Failed to queue fix attempt");
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
