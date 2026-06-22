// src/lib/deploymentInfo.js
// Deployment visibility helpers for /health and /readiness.
//
// Reports version, git SHA (when injected at build time), and applied-vs-
// available migration status so deployment drift is externally detectable
// without SSH access to the container.
//
// Migration status is derived from a comparison, not a hardcoded target:
//   applied   = COUNT(*) FROM schema_migrations
//   available = number of .sql files in the image's migrations dir
//   status    = "current" if applied == available, else "behind"
// This way the check stays correct after migration 037, 038, and beyond.

import { readdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { VERSION } from "@gitwire/core";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Migrations live at packages/web/db/migrations relative to this file
// (src/lib/ -> ../../db/migrations). Resolved lazily so import never throws
// even if the directory is somehow absent.
const MIGRATIONS_DIR = join(__dirname, "..", "..", "db", "migrations");

// Git SHA is injected at build time via Docker ARG -> ENV. Null when not set
// (local dev, tests), which is fine — health still reports version + migrations.
const GIT_SHA = process.env.GITWIRE_COMMIT_SHA || null;

/**
 * Count available migration files in the image.
 * @returns {Promise<number|null>} file count, or null if the dir is unreadable
 */
async function countAvailableMigrations() {
  try {
    const files = await readdir(MIGRATIONS_DIR);
    return files.filter((f) => f.endsWith(".sql")).length;
  } catch {
    // Directory missing — don't crash health, just report unknown.
    return null;
  }
}

/**
 * Count applied migrations from the database.
 * @param {object} db - the pg-compatible db client (query method)
 * @returns {Promise<number|null>} row count, or null if the query fails
 */
async function countAppliedMigrations(db) {
  try {
    const { rows } = await db.query("SELECT COUNT(*)::int AS n FROM schema_migrations");
    return rows[0]?.n ?? null;
  } catch {
    // schema_migrations missing or DB unreachable — health should still work.
    return null;
  }
}

/**
 * Build the deployment info object for health/readiness responses.
 * @param {object} db - the pg-compatible db client
 * @returns {Promise<object>} deployment info fields
 */
export async function getDeploymentInfo(db) {
  const [applied, available] = await Promise.all([
    countAppliedMigrations(db),
    countAvailableMigrations(),
  ]);

  let dbMigrationStatus = "unknown";
  if (applied !== null && available !== null) {
    dbMigrationStatus = applied === available ? "current" : "behind";
  }

  // Probe executor reachability + validator readiness.
  // Gap 1 (v0.22.0): executor.selected_pass_capable + the validator block make
  // CT 115's "healthy but not pass-capable" state externally unambiguous.
  // v0.23.0 Task 4: switched to the ASYNC getBackendLevelSummary() so /health
  // also surfaces selected_backend_id + selected_backend_reachable (rev 3
  // amendment — backend_id-level reachability, load-bearing for proof once
  // two backends share the container-runtime kind).
  let executor = {};
  let validator = {};
  try {
    const {
      getBackendLevelSummary,
      getValidatorReadiness,
    } = await import("./executorReachability.js");
    executor = await getBackendLevelSummary();
    validator = getValidatorReadiness();
  } catch {
    // Reachability module unavailable — health still works, but report
    // validator as explicitly not ready (fail-safe, not silent).
    validator = { configured: false, pass_capable: false, reason: "module_unavailable" };
  }

  return {
    version: VERSION,
    git_sha: GIT_SHA,
    db_migrations_applied: applied,
    db_migrations_available: available,
    db_migration_status: dbMigrationStatus,
    executor,
    validator,
  };
}
