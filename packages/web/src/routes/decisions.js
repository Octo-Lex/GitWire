// src/routes/decisions.js
// GET /api/decisions           — paginated decision log
// GET /api/decisions/summary   — decision stats by source

import { Router } from "express";
import { getDecisions, getDecisionSummary } from "../services/decisionLogService.js";
import { logger } from "../lib/logger.js";

export const decisionsRouter = Router();

/**
 * GET /api/decisions
 * Query params: repo, source, targetType, targetNumber, decision, per_page, page
 */
decisionsRouter.get("/", async (req, res) => {
  try {
    const result = await getDecisions({
      repo: req.query.repo,
      source: req.query.source,
      targetType: req.query.targetType || req.query.target_type,
      targetNumber: req.query.targetNumber || req.query.target_number
        ? Number(req.query.targetNumber || req.query.target_number)
        : undefined,
      decision: req.query.decision,
      perPage: Math.min(Number(req.query.per_page) || 20, 100),
      page: Number(req.query.page) || 1,
    });
    res.json(result);
  } catch (err) {
    logger.error({ err }, "Decisions API error");
    res.status(500).json({ error: "Failed to fetch decisions" });
  }
});

/**
 * GET /api/decisions/summary
 * Returns decision stats grouped by source and decision type.
 */
decisionsRouter.get("/summary", async (_req, res) => {
  try {
    const data = await getDecisionSummary();
    res.json({ data });
  } catch (err) {
    logger.error({ err }, "Decision summary error");
    res.status(500).json({ error: "Failed to fetch decision summary" });
  }
});
