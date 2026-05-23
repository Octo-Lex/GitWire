// src/routes/webhookDeliveries.js
// Webhook delivery tracking — success/failure rates, event breakdown,
// dead letter review, and per-delivery detail.
//
// Endpoints:
//   GET /api/webhooks/deliveries/stats      — Aggregate stats
//   GET /api/webhooks/deliveries             — Paginated delivery list
//   GET /api/webhooks/deliveries/:id         — Single delivery detail
//   GET /api/webhooks/deliveries/events      — Event type breakdown
//   GET /api/webhooks/deliveries/timeline    — Time-series for charts

import { Router } from "express";
import { db } from "../lib/db.js";
import { logger } from "../lib/logger.js";

const router = Router();

// ── GET /api/webhooks/deliveries/stats ─────────────────────────────────────
router.get("/stats", async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE processed = true)::int AS processed_ok,
        COUNT(*) FILTER (WHERE error IS NOT NULL)::int AS errors,
        COUNT(*) FILTER (WHERE received_at > NOW() - INTERVAL '1 hour')::int AS last_1h,
        COUNT(*) FILTER (WHERE received_at > NOW() - INTERVAL '24 hours')::int AS last_24h,
        COUNT(*) FILTER (WHERE received_at > NOW() - INTERVAL '7 days')::int AS last_7d,
        COUNT(*) FILTER (WHERE received_at > NOW() - INTERVAL '30 days')::int AS last_30d,
        COUNT(DISTINCT repo)::int AS active_repos,
        MIN(received_at) AS earliest,
        MAX(received_at) AS latest
      FROM webhook_deliveries
    `);

    const stats = rows[0] || {};
    const total = stats.total || 0;
    const errors = stats.errors || 0;

    // Error rate
    stats.error_rate = total > 0 ? (errors / total) : 0;

    // Events per hour (last 24h)
    const last24h = stats.last_24h || 0;
    stats.events_per_hour = last24h > 0 ? +(last24h / 24).toFixed(1) : 0;

    res.json(stats);
  } catch (err) {
    logger.error({ err }, "Failed to get webhook stats");
    res.status(500).json({ error: "Failed to get stats" });
  }
});

// ── GET /api/webhooks/deliveries/events — Event type breakdown ─────────────
router.get("/events", async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT
        event_name,
        COUNT(*)::int AS count,
        COUNT(*) FILTER (WHERE error IS NOT NULL)::int AS errors,
        MAX(received_at) AS last_received
      FROM webhook_deliveries
      GROUP BY event_name
      ORDER BY count DESC
    `);

    res.json({ events: rows });
  } catch (err) {
    logger.error({ err }, "Failed to get event breakdown");
    res.status(500).json({ error: "Failed to get event breakdown" });
  }
});

// ── GET /api/webhooks/deliveries/timeline — Time-series data ───────────────
router.get("/timeline", async (req, res) => {
  try {
    const days = Math.min(parseInt(req.query.days) || 7, 30);

    const { rows } = await db.query(`
      SELECT
        DATE(received_at) AS date,
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE error IS NOT NULL)::int AS errors,
        COUNT(*) FILTER (WHERE processed = true)::int AS processed
      FROM webhook_deliveries
      WHERE received_at > NOW() - ($1 || ' days')::interval
      GROUP BY DATE(received_at)
      ORDER BY date ASC
    `, [days]);

    res.json({ timeline: rows, days });
  } catch (err) {
    logger.error({ err }, "Failed to get timeline");
    res.status(500).json({ error: "Failed to get timeline" });
  }
});

// ── GET /api/webhooks/deliveries — Paginated delivery list ─────────────────
router.get("/", async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const offset = parseInt(req.query.offset) || 0;
    const event = req.query.event;
    const repo = req.query.repo;
    const status = req.query.status; // "error" or "ok"

    const conditions = [];
    const params = [];
    let paramIdx = 1;

    if (event) {
      conditions.push("event_name = $" + paramIdx++);
      params.push(event);
    }
    if (repo) {
      conditions.push("repo = $" + paramIdx++);
      params.push(repo);
    }
    if (status === "error") {
      conditions.push("error IS NOT NULL");
    } else if (status === "ok") {
      conditions.push("error IS NULL");
    }

    const where = conditions.length > 0 ? "WHERE " + conditions.join(" AND ") : "";

    const { rows } = await db.query(
      `SELECT id, delivery_id, event_name, action, repo, processed, error, received_at
       FROM webhook_deliveries
       ${where}
       ORDER BY received_at DESC
       LIMIT $${paramIdx++} OFFSET $${paramIdx++}`,
      [...params, limit, offset]
    );

    const countResult = await db.query(
      `SELECT COUNT(*)::int AS total FROM webhook_deliveries ${where}`,
      params
    );

    res.json({
      data: rows,
      meta: {
        total: countResult.rows[0]?.total || 0,
        limit,
        offset,
      },
    });
  } catch (err) {
    logger.error({ err }, "Failed to list deliveries");
    res.status(500).json({ error: "Failed to list deliveries" });
  }
});

// ── GET /api/webhooks/deliveries/:id — Single delivery ─────────────────────
router.get("/:id", async (req, res) => {
  try {
    const { rows: [row] } = await db.query(
      "SELECT * FROM webhook_deliveries WHERE delivery_id = $1 OR id = $1",
      [req.params.id]
    );

    if (!row) {
      return res.status(404).json({ error: "Delivery not found" });
    }

    res.json(row);
  } catch (err) {
    logger.error({ err }, "Failed to get delivery");
    res.status(500).json({ error: "Failed to get delivery" });
  }
});

export default router;
