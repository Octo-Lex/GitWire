// src/routes/actions.js
// Action lifecycle API — query, retry, cancel, reconcile GitWire actions.
//
// Endpoints:
//   GET    /api/actions              — List actions with filters
//   GET    /api/actions/summary      — Counts by status
//   GET    /api/actions/:id          — Single action detail
//   POST   /api/actions/:id/retry    — Retry a failed action
//   POST   /api/actions/:id/cancel   — Cancel a pending action
//   POST   /api/actions/:id/reconcile — Trigger reconciliation for an action

import { Router } from "express";
import {
  listActions,
  getAction,
  getActionSummary,
  retry,
  cancel,
  reconcile,
} from "../services/actionStateMachine.js";
import { logger } from "../lib/logger.js";

const router = Router();

// ── GET /api/actions/summary ────────────────────────────────────────────────
router.get("/summary", async (_req, res) => {
  try {
    const summary = await getActionSummary();
    res.json({ summary });
  } catch (err) {
    logger.error({ err }, "Failed to get action summary");
    res.status(500).json({ error: "Failed to get summary" });
  }
});

// ── GET /api/actions ────────────────────────────────────────────────────────
router.get("/", async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const offset = parseInt(req.query.offset) || 0;
    const result = await listActions({
      repo: req.query.repo,
      status: req.query.status,
      pillar: req.query.pillar,
      actionType: req.query.action_type,
      limit,
      offset,
    });
    res.json(result);
  } catch (err) {
    logger.error({ err }, "Failed to list actions");
    res.status(500).json({ error: "Failed to list actions" });
  }
});

// ── GET /api/actions/:id ────────────────────────────────────────────────────
router.get("/:id", async (req, res) => {
  try {
    const action = await getAction(parseInt(req.params.id));
    if (!action) return res.status(404).json({ error: "Action not found" });
    res.json(action);
  } catch (err) {
    logger.error({ err }, "Failed to get action");
    res.status(500).json({ error: "Failed to get action" });
  }
});

// ── POST /api/actions/:id/retry ─────────────────────────────────────────────
router.post("/:id/retry", async (req, res) => {
  try {
    const result = await retry(parseInt(req.params.id));
    if (!result) {
      return res.status(400).json({ error: "Max retries exceeded or action not in failed state" });
    }
    res.json(result);
  } catch (err) {
    logger.error({ err }, "Failed to retry action");
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/actions/:id/cancel ────────────────────────────────────────────
router.post("/:id/cancel", async (req, res) => {
  try {
    const reason = req.body?.reason || "Cancelled via API";
    const result = await cancel(parseInt(req.params.id), reason);
    res.json(result);
  } catch (err) {
    logger.error({ err }, "Failed to cancel action");
    res.status(400).json({ error: err.message });
  }
});

// ── POST /api/actions/:id/reconcile ────────────────────────────────────────
router.post("/:id/reconcile", async (req, res) => {
  try {
    const status = req.body?.status || "confirmed";
    const result = await reconcile(parseInt(req.params.id), status);
    res.json(result);
  } catch (err) {
    logger.error({ err }, "Failed to reconcile action");
    res.status(400).json({ error: err.message });
  }
});

export default router;
