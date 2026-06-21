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
import { db } from "../lib/db.js";
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

// ── GET /api/actions/abstentions ───────────────────────────────────────────
// Abstention/block metrics — surfaces WHY automation refused to act.
router.get("/abstentions", async (_req, res) => {
  try {
    const result = await db.query(`
      SELECT
        blocked_reason,
        repo_full_name,
        action_type,
        COUNT(*) AS count
      FROM managed_actions
      WHERE status = 'blocked' AND blocked_reason IS NOT NULL
      GROUP BY blocked_reason, repo_full_name, action_type
      ORDER BY count DESC
      LIMIT 100
    `);
    const totals = await db.query(`
      SELECT
        COUNT(*) FILTER (WHERE status = 'blocked')                          AS blocked_total,
        COUNT(*) FILTER (WHERE status = 'failed')                            AS failed_total,
        COUNT(*) FILTER (WHERE status = 'succeeded')                         AS mutation_success_total,
        COUNT(*) FILTER (WHERE status IN ('succeeded','failed','blocked'))   AS mutation_attempts_total,
        COUNT(*) FILTER (WHERE status = 'blocked' AND blocked_reason = 'target_drifted')      AS blocked_target_drifted,
        COUNT(*) FILTER (WHERE status = 'blocked' AND blocked_reason = 'duplicate_action')   AS blocked_duplicate,
        COUNT(*) FILTER (WHERE status = 'blocked' AND blocked_reason = 'policy_denied')      AS blocked_policy,
        COUNT(*) FILTER (WHERE status = 'blocked' AND blocked_reason = 'marker_ambiguous')   AS blocked_marker
      FROM managed_actions
    `);
    res.json({
      totals: totals.rows[0],
      breakdown: result.rows,
    });
  } catch (err) {
    logger.error({ err }, "Failed to get abstention metrics");
    res.status(500).json({ error: "Failed to get abstentions" });
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
