// src/routes/transfers.js
// Repository reconciliation API — detect and resolve orphaned repos.
//
// GET  /api/repos/reconcile          — list detected orphans
// POST /api/repos/reconcile/merge    — merge orphan data into live repo
// POST /api/repos/reconcile/discard  — discard orphan without merging

import { Router } from "express";
import { detectOrphans, mergeOrphan, discardOrphan } from "../services/repoTransferService.js";
import { logger } from "../lib/logger.js";

const router = Router();

// ── GET /api/repos/reconcile ──────────────────────────────────────────────
router.get("/reconcile", async (_req, res) => {
  try {
    const orphans = await detectOrphans();
    res.json({ data: orphans, meta: { total: orphans.length } });
  } catch (err) {
    logger.error({ err }, "Reconcile detection failed");
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/repos/reconcile/merge ───────────────────────────────────────
router.post("/reconcile/merge", async (req, res) => {
  try {
    const { orphan, live } = req.body;

    if (!orphan || !live) {
      return res.status(400).json({ error: "orphan and live (full names) are required" });
    }

    const result = await mergeOrphan(orphan, live);
    res.json(result);
  } catch (err) {
    logger.error({ err }, "Reconcile merge failed");
    res.status(400).json({ error: err.message });
  }
});

// ── POST /api/repos/reconcile/discard ─────────────────────────────────────
router.post("/reconcile/discard", async (req, res) => {
  try {
    const { orphan } = req.body;

    if (!orphan) {
      return res.status(400).json({ error: "orphan (full name) is required" });
    }

    const result = await discardOrphan(orphan);
    res.json(result);
  } catch (err) {
    logger.error({ err }, "Reconcile discard failed");
    res.status(400).json({ error: err.message });
  }
});

export default router;
