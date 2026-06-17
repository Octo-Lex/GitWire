// src/routes/waivers.js
// API routes for policy waivers.
//
// GET /api/waivers?repo=owner/repo&pillar=ci_healing&active=true
// POST /api/waivers — grant a new waiver
// DELETE /api/waivers/:id — revoke a waiver

import { Router } from "express";
import { db } from "../lib/db.js";
import { isWaived, grantWaiver, revokeWaiver, listWaivers, listAllWaivers, expireWaivers } from "../services/waiverService.js";
import { logger } from "../lib/logger.js";

const router = Router();

// List waivers — global or repo-specific
router.get("/", async (req, res) => {
  try {
    const { repo, pillar, active } = req.query;

    // Global view: no repo specified → list all waivers across repos
    if (!repo) {
      const result = await listAllWaivers({
        repo: undefined,
        pillar: pillar || undefined,
        scope: req.query.scope,
        status: req.query.status,
        grantedBy: req.query.granted_by || req.query.grantedBy,
        q: req.query.q,
        limit: Math.min(Number(req.query.limit) || 50, 200),
        offset: Number(req.query.offset) || 0,
      });
      return res.json(result);
    }

    // Repo-specific view
    const { rows: [repoRow] } = await db.query(
      "SELECT github_id FROM repositories WHERE full_name = $1",
      [repo]
    );
    if (!repoRow) {
      return res.status(404).json({ error: "Repository not found" });
    }

    const waivers = await listWaivers({
      repoId: repoRow.github_id,
      pillar: pillar || undefined,
      activeOnly: active !== "false",
    });

    res.json({ data: waivers });
  } catch (err) {
    logger.error({ err: err.message }, "Failed to list waivers");
    res.status(500).json({ error: "Failed to list waivers" });
  }
});

// Check if a specific pillar is waived
router.get("/check", async (req, res) => {
  try {
    const { repo, pillar, scope, scopeValue } = req.query;
    if (!repo || !pillar) {
      return res.status(400).json({ error: "repo and pillar are required" });
    }

    const { rows: [repoRow] } = await db.query(
      "SELECT github_id FROM repositories WHERE full_name = $1",
      [repo]
    );
    if (!repoRow) {
      return res.status(404).json({ error: "Repository not found" });
    }

    const waiver = await isWaived({
      repoId: repoRow.github_id,
      pillar,
      scope: scope || undefined,
      scopeValue: scopeValue || undefined,
    });

    res.json({ waived: !!waiver, waiver });
  } catch (err) {
    logger.error({ err: err.message }, "Failed to check waiver");
    res.status(500).json({ error: "Failed to check waiver" });
  }
});

// Grant a new waiver
router.post("/", async (req, res) => {
  try {
    const { repo, pillar, scope, scopeValue, reason, grantedBy, expiresAt } = req.body;
    if (!repo || !pillar || !reason || !grantedBy) {
      return res.status(400).json({ error: "repo, pillar, reason, and grantedBy are required" });
    }

    const { rows: [repoRow] } = await db.query(
      "SELECT github_id FROM repositories WHERE full_name = $1",
      [repo]
    );
    if (!repoRow) {
      return res.status(404).json({ error: "Repository not found" });
    }

    const waiver = await grantWaiver({
      repoId: repoRow.github_id,
      pillar,
      scope: scope || "repo",
      scopeValue,
      reason,
      grantedBy,
      expiresAt,
    });

    res.status(201).json({ data: waiver });
  } catch (err) {
    logger.error({ err: err.message }, "Failed to grant waiver");
    res.status(500).json({ error: "Failed to grant waiver" });
  }
});

// Revoke a waiver
router.delete("/:id", async (req, res) => {
  try {
    const waiver = await revokeWaiver(parseInt(req.params.id, 10), req.body.revokedBy || "api");
    if (!waiver) {
      return res.status(404).json({ error: "Waiver not found or already revoked" });
    }
    res.json({ data: waiver });
  } catch (err) {
    logger.error({ err: err.message }, "Failed to revoke waiver");
    res.status(500).json({ error: "Failed to revoke waiver" });
  }
});

export default router;
