// src/services/maintainerService.js
import { db } from "../lib/db.js";
import { logger } from "../lib/logger.js";

export const maintainerService = {
  // ── Settings ──────────────────────────────────────────────────────────────

  async getSettings(repoId) {
    const { rows } = await db.query(
      "SELECT * FROM maintainer_settings WHERE repo_id = $1",
      [repoId]
    );
    return rows[0] || null;
  },

  async upsertSettings(repoId, patch) {
    const setClauses = [];
    const values = [];
    let idx = 1;

    for (const [key, val] of Object.entries(patch)) {
      if (["stale_issue_days", "stale_pr_days", "stale_warn_days", "cleanup_branches", "enabled"].includes(key)) {
        setClauses.push(key + " = $" + idx);
        values.push(val);
        idx++;
      }
    }

    if (setClauses.length === 0) return null;

    setClauses.push("updated_at = NOW()");
    values.push(repoId);

    await db.query(
      `INSERT INTO maintainer_settings (repo_id, updated_at)
       VALUES ($${idx}, NOW())
       ON CONFLICT (repo_id) DO UPDATE SET ${setClauses.join(", ")}`,
      values
    );

    return maintainerService.getSettings(repoId);
  },

  // ── Action recording (idempotency) ────────────────────────────────────────

  async recordAction(repoId, { actionType, targetType, targetNumber, idempotencyKey, status, result }) {
    await db.query(
      `INSERT INTO maintainer_actions
         (repo_id, action_type, target_type, target_number, idempotency_key, status, result, applied_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, ${status === "applied" ? "NOW()" : "NULL"})
       ON CONFLICT (idempotency_key) DO NOTHING`,
      [repoId, actionType, targetType, targetNumber, idempotencyKey, status || "pending", result || null]
    );
  },

  async actionExists(idempotencyKey) {
    const { rows } = await db.query(
      "SELECT 1 FROM maintainer_actions WHERE idempotency_key = $1",
      [idempotencyKey]
    );
    return rows.length > 0;
  },

  // ── Action history ────────────────────────────────────────────────────────

  async listActions(repoId, { limit = 50, offset = 0 } = {}) {
    const { rows } = await db.query(
      `SELECT * FROM maintainer_actions
       WHERE repo_id = $1
       ORDER BY created_at DESC
       LIMIT $2 OFFSET $3`,
      [repoId, limit, offset]
    );
    return rows;
  },

  async getActionStats(repoId) {
    const { rows } = await db.query(
      `SELECT
         COUNT(*) FILTER (WHERE status = 'applied')   AS applied,
         COUNT(*) FILTER (WHERE status = 'skipped')   AS skipped,
         COUNT(*) FILTER (WHERE status = 'failed')    AS failed,
         COUNT(*) FILTER (WHERE status = 'pending')   AS pending,
         COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '7 days') AS last_7_days
       FROM maintainer_actions
       WHERE repo_id = $1`,
      [repoId]
    );
    return rows[0];
  },
};
