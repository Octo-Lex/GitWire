// src/routes/activity.js
// Unified action feed — aggregates all GitWire actions across 9 sources.
// GET /api/activity — returns recent actions with filtering + pagination.

import { Router } from "express";
import { db } from "../lib/db.js";
import { logger } from "../lib/logger.js";

const router = Router();

// ── Source labels and icons for the dashboard ────────────────────────────────
const SOURCE_META = {
  ci_heal:       { label: "CI Heal",          icon: "🔧", color: "blue" },
  issue_fix:     { label: "Issue Fix",        icon: "🐛", color: "purple" },
  maintainer:    { label: "Maintainer",       icon: "🧹", color: "green" },
  config_change: { label: "Config Change",    icon: "⚙️",  color: "gray" },
  duplicate:     { label: "Duplicate",        icon: "📋", color: "amber" },
  merge_queue:   { label: "Merge Queue",      icon: "🔀", color: "indigo" },
  ai_review:     { label: "AI Review",        icon: "🧠", color: "teal" },
  enforcement:   { label: "Enforcement",      icon: "🛡", color: "red" },
  webhook:       { label: "Webhook",          icon: "📡", color: "slate" },
};

// ── GET /api/activity ────────────────────────────────────────────────────────
// Query params:
//   source    — filter by source (ci_heal, issue_fix, maintainer, etc.)
//   repo      — filter by repo full_name
//   status    — filter by status
//   since     — ISO timestamp, only actions after this time
//   per_page  — page size (default 25, max 100)
//   page      — page number (default 1)

router.get("/", async (req, res) => {
  try {
    const { source, repo, status, since, per_page = 25, page = 1 } = req.query;
    const limit = Math.min(parseInt(per_page) || 25, 100);
    const offset = (Math.max(parseInt(page) || 1, 1) - 1) * limit;

    const conditions = [];
    const params = [];
    let paramIdx = 1;

    if (source) {
      const sources = source.split(",").map(s => s.trim()).filter(Boolean);
      conditions.push(`source = ANY($${paramIdx})`);
      params.push(sources);
      paramIdx++;
    }

    if (repo) {
      conditions.push(`repo = $${paramIdx}`);
      params.push(repo);
      paramIdx++;
    }

    if (status) {
      conditions.push(`status = $${paramIdx}`);
      params.push(status);
      paramIdx++;
    }

    if (since) {
      conditions.push(`created_at >= $${paramIdx}`);
      params.push(since);
      paramIdx++;
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    // Get total count
    const countResult = await db.query(
      `SELECT COUNT(*)::int AS total FROM action_feed ${where}`,
      params
    );
    const total = countResult.rows[0]?.total || 0;

    // Get page
    const result = await db.query(
      `SELECT * FROM action_feed ${where} ORDER BY created_at DESC LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
      [...params, limit, offset]
    );

    // Enrich with source metadata
    const rows = result.rows.map(row => ({
      ...row,
      meta: SOURCE_META[row.source] || { label: row.source, icon: "•", color: "gray" },
    }));

    res.json({
      data: rows,
      pagination: {
        total,
        page: parseInt(page),
        per_page: limit,
        total_pages: Math.ceil(total / limit),
      },
      sources: SOURCE_META,
    });
  } catch (err) {
    logger.error({ err }, "Failed to fetch activity feed");
    res.status(500).json({ error: "Failed to fetch activity feed" });
  }
});

// ── GET /api/activity/summary ────────────────────────────────────────────────
// Returns counts by source and status for dashboard overview cards.

router.get("/summary", async (req, res) => {
  try {
    const { since } = req.query;
    const params = [];
    let whereClause = "";
    if (since) {
      params.push(since);
      whereClause = "WHERE created_at >= $1";
    }

    const result = await db.query(`
      SELECT
        source,
        status,
        COUNT(*)::int AS count
      FROM action_feed ${whereClause}
      GROUP BY source, status
      ORDER BY source, status
    `, params);

    // Also get total counts
    const totalResult = await db.query(`
      SELECT COUNT(*)::int AS total FROM action_feed ${whereClause}
    `, params);

    // Get recent counts (last 24h, last 7d)
    const recentResult = await db.query(`
      SELECT
        COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '24 hours') AS last_24h,
        COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '7 days')  AS last_7d,
        COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '30 days') AS last_30d
      FROM action_feed
    `);

    // Build source summary
    const bySource = {};
    for (const row of result.rows) {
      if (!bySource[row.source]) {
        bySource[row.source] = { source: row.source, meta: SOURCE_META[row.source], statuses: {} };
      }
      bySource[row.source].statuses[row.status] = row.count;
    }

    res.json({
      total: totalResult.rows[0]?.total || 0,
      recent: recentResult.rows[0] || { last_24h: 0, last_7d: 0, last_30d: 0 },
      by_source: bySource,
      sources: SOURCE_META,
    });
  } catch (err) {
    logger.error({ err }, "Failed to fetch activity summary");
    res.status(500).json({ error: "Failed to fetch activity summary" });
  }
});

export default router;
