// src/services/repoTransferService.js
// Repository reconciliation — detect and resolve orphaned repo rows.
//
// When a GitHub repo is deleted and re-created under a different org
// (NOT a transfer — a transfer keeps the same github_id), GitWire ends
// up with TWO rows for the "same" repo name but different github_ids.
// The webhook worker's ON CONFLICT (github_id) handles real transfers
// automatically. This service handles the orphan cleanup case.
//
// Detection: repos sharing the same name with different github_ids.
// Resolution: merge old data into the live repo, or discard the orphan.

import { db } from "../lib/db.js";
import { logger } from "../lib/logger.js";

// All tables with FK to repositories(github_id)
const FK_TABLES = [
  "ai_review_config",
  "ai_reviews",
  "branch_rules",
  "ci_runs",
  "config_history",
  "config_validation_results",
  "decision_log",
  "dependency_manifests",
  "dependency_update_batches",
  "duplicate_signals",
  "enforcement_violations",
  "fix_attempts",
  "flaky_tests",
  "gate_evaluations",
  "heal_prs",
  "issue_embeddings",
  "issues",
  "maintainer_actions",
  "maintainer_settings",
  "managed_actions",
  "merge_queue_config",
  "merge_queue_entries",
  "pipeline_events",
  "policy_repo_configs",
  "policy_waivers",
  "pull_requests",
  "quality_gates",
  "repo_collaborators",
  "repo_config",
  "rollback_events",
  "test_results",
  "vulnerability_advisories",
];

// Tables with denormalized text referencing repo full_name
const DENORM_TABLES = [
  { table: "managed_actions", column: "repo_full_name" },
  { table: "webhook_deliveries", column: "repo" },
  { table: "action_feed", column: "repo" },
  { table: "audit_trail_entries", column: "repo_full_name" },
];

/**
 * Detect all orphaned repos — repos sharing a name with another active repo.
 * Returns grouped by repo name, each with an "orphan" and a "live" candidate.
 */
export async function detectOrphans() {
  // Find repo names that appear more than once (active, non-deleted)
  const { rows: duplicates } = await db.query(`
    SELECT name
    FROM repositories
    WHERE deleted_at IS NULL
    GROUP BY name
    HAVING COUNT(*) > 1
  `);

  const results = [];

  for (const { name } of duplicates) {
    // Get all active repos with this name
    const { rows: variants } = await db.query(
      `SELECT github_id, full_name, owner, name, last_synced_at, created_at
       FROM repositories
       WHERE name = $1 AND deleted_at IS NULL
       ORDER BY github_id`,
      [name]
    );

    // Count activity for each variant to determine which is "live"
    const withActivity = await Promise.all(
      variants.map(async (v) => {
        const { rows: [{ cnt }] } = await db.query(
          `SELECT COUNT(*)::int AS cnt FROM webhook_deliveries WHERE repo = $1`,
          [v.full_name]
        );
        return { ...v, delivery_count: cnt };
      })
    );

    // The variant with more recent activity is "live"
    withActivity.sort((a, b) => b.delivery_count - a.delivery_count);
    const live = withActivity[0];
    const orphans = withActivity.slice(1);

    for (const orphan of orphans) {
      // Count all data for the orphan
      const fkData = {};
      for (const table of FK_TABLES) {
        const { rows: [{ count }] } = await db.query(
          `SELECT COUNT(*)::int AS count FROM ${table} WHERE repo_id = $1`,
          [orphan.github_id]
        );
        if (count > 0) fkData[table] = count;
      }

      const denormData = {};
      for (const { table, column } of DENORM_TABLES) {
        const { rows: [{ count }] } = await db.query(
          `SELECT COUNT(*)::int AS count FROM ${table} WHERE ${column} = $1`,
          [orphan.full_name]
        );
        if (count > 0) denormData[table] = count;
      }

      const fkTotal = Object.values(fkData).reduce((a, b) => a + b, 0);
      const denormTotal = Object.values(denormData).reduce((a, b) => a + b, 0);

      results.push({
        orphan: {
          github_id: orphan.github_id,
          full_name: orphan.full_name,
          delivery_count: orphan.delivery_count,
        },
        live: {
          github_id: live.github_id,
          full_name: live.full_name,
          delivery_count: live.delivery_count,
        },
        data: {
          fk_tables: fkData,
          fk_total: fkTotal,
          denorm_tables: denormData,
          denorm_total: denormTotal,
          grand_total: fkTotal + denormTotal,
        },
      });
    }
  }

  return results;
}

/**
 * Merge orphan data into the live repo.
 * 1. Re-point all FK references: orphan.github_id → live.github_id
 * 2. Backfill denormalized text: orphan.full_name → live.full_name
 * 3. Soft-delete the orphan repo row
 */
export async function mergeOrphan(orphanFullName, liveFullName) {
  // Look up both repos
  const { rows: [orphan] } = await db.query(
    `SELECT * FROM repositories WHERE full_name = $1 AND deleted_at IS NULL`,
    [orphanFullName]
  );
  if (!orphan) throw new Error(`Orphan "${orphanFullName}" not found`);

  const { rows: [live] } = await db.query(
    `SELECT * FROM repositories WHERE full_name = $1 AND deleted_at IS NULL`,
    [liveFullName]
  );
  if (!live) throw new Error(`Live repo "${liveFullName}" not found`);

  if (orphan.github_id === live.github_id) {
    throw new Error("Both repos have the same github_id — not an orphan pair");
  }

  const client = await db.connect();
  try {
    await client.query("BEGIN");

    const reparented = {};
    const backfilled = {};

    // 1. Re-point FK references from orphan.github_id → live.github_id
    for (const table of FK_TABLES) {
      const { rowCount } = await client.query(
        `UPDATE ${table} SET repo_id = $1 WHERE repo_id = $2`,
        [live.github_id, orphan.github_id]
      );
      if (rowCount > 0) reparented[table] = rowCount;
    }

    // 2. Backfill denormalized text from orphan.full_name → live.full_name
    for (const { table, column } of DENORM_TABLES) {
      const { rowCount } = await client.query(
        `UPDATE ${table} SET ${column} = $1 WHERE ${column} = $2`,
        [live.full_name, orphan.full_name]
      );
      if (rowCount > 0) backfilled[table] = rowCount;
    }

    // 3. Soft-delete the orphan repo
    await client.query(
      `UPDATE repositories SET deleted_at = NOW(), updated_at = NOW() WHERE github_id = $1`,
      [orphan.github_id]
    );

    await client.query("COMMIT");

    const totalReparented = Object.values(reparented).reduce((a, b) => a + b, 0);
    const totalBackfilled = Object.values(backfilled).reduce((a, b) => a + b, 0);

    logger.info(
      {
        orphan: orphan.full_name,
        live: live.full_name,
        reparented,
        backfilled,
      },
      "Orphan repo merged into live repo"
    );

    return {
      status: "merged",
      orphan: orphan.full_name,
      live: live.full_name,
      reparented,
      backfilled,
      total_reparented: totalReparented,
      total_backfilled: totalBackfilled,
      total_affected: totalReparented + totalBackfilled,
    };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Discard an orphan — soft-delete it without merging data.
 * Historical data stays in DB but is hidden (orphan repo is soft-deleted).
 */
export async function discardOrphan(orphanFullName) {
  const { rows: [orphan] } = await db.query(
    `SELECT * FROM repositories WHERE full_name = $1 AND deleted_at IS NULL`,
    [orphanFullName]
  );
  if (!orphan) throw new Error(`Orphan "${orphanFullName}" not found`);

  await db.query(
    `UPDATE repositories SET deleted_at = NOW(), updated_at = NOW() WHERE github_id = $1`,
    [orphan.github_id]
  );

  logger.info({ orphan: orphan.full_name, github_id: orphan.github_id }, "Orphan repo discarded");

  return {
    status: "discarded",
    orphan: orphan.full_name,
    github_id: orphan.github_id,
    note: "Orphan soft-deleted. Its data remains in DB but is hidden from queries.",
  };
}
