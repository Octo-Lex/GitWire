// src/routes/githubRelay.js
// GitHub API resilience metrics — cache stats, rate limit budget, cooldowns.
// GET /api/github-relay/stats
// GET /api/github-relay/rate-limits
// GET /api/github-relay/cooldowns

import { Router } from "express";
import { getCacheStats } from "../services/githubCache.js";
import { getAllRateBudgets, getActiveCooldowns } from "../services/githubRateLimit.js";
import { logger } from "../lib/logger.js";

const router = Router();

// ── GET /api/github-relay/stats ─────────────────────────────────────────────
// Cache hit/miss stats and key count.

router.get("/stats", async function (_req, res) {
  try {
    const stats = await getCacheStats();
    res.json({
      data: {
        cache_keys: stats.keys,
        cache_enabled: true,
      },
    });
  } catch (err) {
    logger.error({ err }, "Failed to fetch GitHub relay stats");
    res.status(500).json({ error: "Failed to fetch relay stats" });
  }
});

// ── GET /api/github-relay/rate-limits ───────────────────────────────────────
// Current rate limit budget per resource.

router.get("/rate-limits", async function (_req, res) {
  try {
    const budgets = await getAllRateBudgets();
    res.json({
      data: budgets,
    });
  } catch (err) {
    logger.error({ err }, "Failed to fetch rate limits");
    res.status(500).json({ error: "Failed to fetch rate limits" });
  }
});

// ── GET /api/github-relay/cooldowns ─────────────────────────────────────────
// Active cooldowns.

router.get("/cooldowns", async function (_req, res) {
  try {
    const cooldowns = await getActiveCooldowns();
    res.json({
      data: cooldowns,
    });
  } catch (err) {
    logger.error({ err }, "Failed to fetch cooldowns");
    res.status(500).json({ error: "Failed to fetch cooldowns" });
  }
});

export default router;
