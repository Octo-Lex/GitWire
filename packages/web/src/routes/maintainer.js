// src/routes/maintainer.js
// GET  /api/maintainer/:owner/:repo/settings      — get maintainer settings
// PATCH /api/maintainer/:owner/:repo/settings      — update settings
// GET  /api/maintainer/:owner/:repo/actions        — action history
// GET  /api/maintainer/:owner/:repo/stats          — action stats
// POST /api/maintainer/:owner/:repo/stale-scan     — trigger stale scan
// POST /api/maintainer/:owner/:repo/branch-cleanup — trigger branch cleanup

import { Router } from "express";
import { db } from "../lib/db.js";
import { maintainerService } from "../services/maintainerService.js";
import { maintainerQueue } from "../lib/queue.js";
import { paginationMiddleware } from "../middleware/pagination.js";

export const maintainerRouter = Router();
maintainerRouter.use(paginationMiddleware);

// ── Settings ─────────────────────────────────────────────────────────────────

maintainerRouter.get("/:owner/:repo/settings", async (req, res, next) => {
  try {
    const fullName = req.params.owner + "/" + req.params.repo;
    const repoRow = await findRepo(fullName);
    if (!repoRow) return res.status(404).json({ error: "Repository not found" });

    const settings = await maintainerService.getSettings(repoRow.github_id);
    res.json(settings || {
      repo_id: repoRow.github_id,
      stale_issue_days: 60,
      stale_pr_days: 30,
      stale_warn_days: 7,
      cleanup_branches: true,
      enabled: true,
    });
  } catch (err) {
    next(err);
  }
});

maintainerRouter.patch("/:owner/:repo/settings", async (req, res, next) => {
  try {
    const fullName = req.params.owner + "/" + req.params.repo;
    const repoRow = await findRepo(fullName);
    if (!repoRow) return res.status(404).json({ error: "Repository not found" });

    const settings = await maintainerService.upsertSettings(repoRow.github_id, req.body);
    res.json(settings);
  } catch (err) {
    next(err);
  }
});

// ── Actions ──────────────────────────────────────────────────────────────────

maintainerRouter.get("/:owner/:repo/actions", async (req, res, next) => {
  try {
    const fullName = req.params.owner + "/" + req.params.repo;
    const repoRow = await findRepo(fullName);
    if (!repoRow) return res.status(404).json({ error: "Repository not found" });

    const { perPage, offset } = res.locals;
    const actions = await maintainerService.listActions(repoRow.github_id, { limit: perPage, offset });
    res.json({ actions, repo: fullName });
  } catch (err) {
    next(err);
  }
});

maintainerRouter.get("/:owner/:repo/stats", async (req, res, next) => {
  try {
    const fullName = req.params.owner + "/" + req.params.repo;
    const repoRow = await findRepo(fullName);
    if (!repoRow) return res.status(404).json({ error: "Repository not found" });

    const stats = await maintainerService.getActionStats(repoRow.github_id);
    res.json(stats);
  } catch (err) {
    next(err);
  }
});

// ── Triggers ─────────────────────────────────────────────────────────────────

maintainerRouter.post("/:owner/:repo/stale-scan", async (req, res, next) => {
  try {
    const fullName = req.params.owner + "/" + req.params.repo;
    const repoRow = await findRepo(fullName);
    if (!repoRow) return res.status(404).json({ error: "Repository not found" });

    const job = await maintainerQueue.add("stale-scan", {
      installationId: repoRow.installation_id,
      repoFullName: fullName,
    });

    res.status(202).json({ queued: true, jobId: job.id });
  } catch (err) {
    next(err);
  }
});

maintainerRouter.post("/:owner/:repo/branch-cleanup", async (req, res, next) => {
  try {
    const fullName = req.params.owner + "/" + req.params.repo;
    const repoRow = await findRepo(fullName);
    if (!repoRow) return res.status(404).json({ error: "Repository not found" });

    const job = await maintainerQueue.add("branch-cleanup", {
      installationId: repoRow.installation_id,
      repoFullName: fullName,
    });

    res.status(202).json({ queued: true, jobId: job.id });
  } catch (err) {
    next(err);
  }
});

// ── Helper ───────────────────────────────────────────────────────────────────

async function findRepo(fullName) {
  const { rows } = await db.query(
    "SELECT github_id, installation_id FROM repositories WHERE full_name = $1",
    [fullName]
  );
  return rows[0] || null;
}
