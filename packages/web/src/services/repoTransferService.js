// src/services/repoTransferService.js
// Handle repository ownership transfers — migrate data or start fresh.
//
// GitHub transfers keep the same github_id but change full_name + owner.
// GitWire's 32 FK-linked tables auto-follow an UPDATE to repositories.
// 4 denormalized text columns need explicit backfill.

import { db } from "../lib/db.js";
import { logger } from "../lib/logger.js";

/**
 * Transfer a repo to a new owner/org.
 *
 * @param {object} params
 * @param {string} params.currentFullName — current "owner/repo"
 * @param {string} params.newFullName — new "owner/repo"
 * @param {boolean} params.migrate — true = keep history, false = fresh start
 * @returns {object} result
 */
export async function transferRepo({ currentFullName, newFullName, migrate }) {
  const [newOwner, newName] = newFullName.split("/");

  if (!newOwner || !newName) {
    throw new Error("new_full_name must be in 'owner/repo' format");
  }

  // Find the existing repo
  const { rows: [repo] } = await db.query(
    "SELECT * FROM repositories WHERE full_name = $1 AND deleted_at IS NULL",
    [currentFullName]
  );

  if (!repo) {
    throw new Error(`Repository "${currentFullName}" not found`);
  }

  // Check if the target already exists
  const { rows: [existing] } = await db.query(
    "SELECT * FROM repositories WHERE full_name = $1 AND deleted_at IS NULL",
    [newFullName]
  );

  if (existing) {
    if (existing.github_id === repo.github_id) {
      // Same repo — idempotent, already transferred
      return { status: "already_transferred", repo_id: repo.github_id };
    }
    throw new Error(`Repository "${newFullName}" already exists with a different github_id`);
  }

  if (migrate) {
    return await migrateWithData(repo, newOwner, newName, newFullName);
  } else {
    return await freshStart(repo, newOwner, newName, newFullName);
  }
}

/**
 * Migrate: update repo row + backfill denormalized text columns.
 * All FK-linked tables (32) auto-follow the UPDATE.
 */
async function migrateWithData(repo, newOwner, newName, newFullName) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");

    // 1. Update the repositories row
    await client.query(
      `UPDATE repositories
       SET full_name = $1, owner = $2, name = $3, updated_at = NOW()
       WHERE github_id = $4`,
      [newFullName, newOwner, newName, repo.github_id]
    );

    // 2. Backfill denormalized text columns
    const backfillTables = [
      { table: "managed_actions", column: "repo_full_name" },
      { table: "webhook_deliveries", column: "repo" },
      { table: "action_feed", column: "repo" },
      { table: "audit_trail_entries", column: "repo_full_name" },
    ];

    let backfillCounts = {};
    for (const { table, column } of backfillTables) {
      const { rowCount } = await client.query(
        `UPDATE ${table} SET ${column} = $1 WHERE ${column} = $2`,
        [newFullName, repo.full_name]
      );
      backfillCounts[table] = rowCount;
    }

    await client.query("COMMIT");

    logger.info(
      {
        old: repo.full_name,
        new: newFullName,
        github_id: repo.github_id,
        backfill: backfillCounts,
      },
      "Repo transferred (migrated with data)"
    );

    return {
      status: "migrated",
      old_name: repo.full_name,
      new_name: newFullName,
      github_id: repo.github_id,
      backfilled: backfillCounts,
    };
  } catch (err) {
    await client.query("ROLLBACK");
    client.release();
    throw err;
  } finally {
    if (!client._released) client.release();
  }
}

/**
 * Fresh start: soft-delete old repo. Next webhook from new org
 * creates a clean repo row via normal sync flow.
 */
async function freshStart(repo, newOwner, newName, newFullName) {
  // Soft-delete the old repo
  await db.query(
    `UPDATE repositories SET deleted_at = NOW(), updated_at = NOW() WHERE github_id = $1`,
    [repo.github_id]
  );

  logger.info(
    {
      old: repo.full_name,
      new: newFullName,
      github_id: repo.github_id,
    },
    "Repo transfer: fresh start (old repo soft-deleted)"
  );

  return {
    status: "fresh_start",
    old_name: repo.full_name,
    new_name: newFullName,
    github_id: repo.github_id,
    note: "Old repo soft-deleted. It will re-appear under the new name when the next webhook arrives.",
  };
}

/**
 * Get transfer preview — shows what would happen if a repo is transferred.
 * Useful for the dashboard to show counts before the user commits.
 */
export async function getTransferPreview(currentFullName) {
  const { rows: [repo] } = await db.query(
    "SELECT * FROM repositories WHERE full_name = $1 AND deleted_at IS NULL",
    [currentFullName]
  );

  if (!repo) {
    throw new Error(`Repository "${currentFullName}" not found`);
  }

  // Count rows in each backfill table
  const counts = {};
  const backfillTables = [
    { table: "managed_actions", column: "repo_full_name", label: "Actions" },
    { table: "webhook_deliveries", column: "repo", label: "Webhook Deliveries" },
    { table: "action_feed", column: "repo", label: "Activity Feed" },
    { table: "audit_trail_entries", column: "repo_full_name", label: "Audit Entries" },
  ];

  for (const { table, column, label } of backfillTables) {
    const { rows: [{ count }] } = await db.query(
      `SELECT COUNT(*)::int AS count FROM ${table} WHERE ${column} = $1`,
      [currentFullName]
    );
    counts[label] = count;
  }

  // Count total FK-linked rows (sampling key tables)
  const fkCounts = {};
  const fkTables = [
    { table: "ci_runs", label: "CI Runs" },
    { table: "issues", label: "Issues" },
    { table: "pull_requests", label: "Pull Requests" },
    { table: "decision_log", label: "Decisions" },
    { table: "fix_attempts", label: "Fix Attempts" },
    { table: "heal_prs", label: "Heal PRs" },
  ];

  for (const { table, label } of fkTables) {
    const { rows: [{ count }] } = await db.query(
      `SELECT COUNT(*)::int AS count FROM ${table} WHERE repo_id = $1`,
      [repo.github_id]
    );
    if (count > 0) fkCounts[label] = count;
  }

  // Count denormalized total
  const denormTotal = Object.values(counts).reduce((a, b) => a + b, 0);
  const fkTotal = Object.values(fkCounts).reduce((a, b) => a + b, 0);

  return {
    repo: {
      github_id: repo.github_id,
      full_name: repo.full_name,
      owner: repo.owner,
      name: repo.name,
    },
    data_at_risk: {
      denormalized_rows: counts,
      denormalized_total: denormTotal,
      fk_linked_rows: fkCounts,
      fk_linked_total: fkTotal,
      grand_total: denormTotal + fkTotal,
    },
    fk_auto_follow: "All 32 FK-linked tables automatically follow the transfer",
    denormalized_need_backfill: "4 text columns updated in migrate mode",
  };
}
