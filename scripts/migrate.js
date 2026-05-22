#!/usr/bin/env node
/**
 * GitWire Database Migration Runner
 *
 * Runs SQL migrations from packages/web/db/migrations/ in order.
 * Tracks applied migrations in a schema_migrations table.
 *
 * Usage:
 *   node scripts/migrate.js
 *
 * DATABASE_URL is loaded from packages/web/.env (shell env takes precedence).
 */

import { readdir, readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

// Load .env from packages/web/ (shell env takes precedence)
const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = join(__dirname, "..", "packages", "web", ".env");

try {
  const { config: loadDotenv } = await import("dotenv");
  loadDotenv({ path: envPath });
} catch {
  // dotenv not available — rely on shell env
}

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error("❌ DATABASE_URL not set.");
  console.error("   Set it in packages/web/.env or as an environment variable.");
  process.exit(1);
}

const MIGRATIONS_DIR = join(__dirname, "..", "packages", "web", "db", "migrations");

async function run() {
  const pool = new pg.Pool({ connectionString: DATABASE_URL });

  try {
    // Ensure schema_migrations table exists
    await pool.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version   TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    // Get applied migrations
    const { rows } = await pool.query("SELECT version FROM schema_migrations");
    const applied = new Set(rows.map((r) => r.version));

    // Read migration files sorted by name
    const files = (await readdir(MIGRATIONS_DIR))
      .filter((f) => f.endsWith(".sql"))
      .sort();

    if (files.length === 0) {
      console.log("ℹ️  No migration files found.");
      return;
    }

    let appliedCount = 0;

    for (const file of files) {
      if (applied.has(file)) {
        console.log(`⏭  ${file} (already applied)`);
        continue;
      }

      const sql = await readFile(join(MIGRATIONS_DIR, file), "utf-8");

      // Run in a transaction
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (version) VALUES ($1)", [file]);
        await client.query("COMMIT");
        console.log(`✅ ${file}`);
        appliedCount++;
      } catch (err) {
        await client.query("ROLLBACK");
        console.error(`❌ ${file}: ${err.message}`);
        process.exitCode = 1;
        return;
      } finally {
        client.release();
      }
    }

    if (appliedCount > 0) {
      console.log(`\n🎉 ${appliedCount} migration(s) applied.`);
    } else {
      console.log(`\n✨ All ${files.length} migration(s) already applied.`);
    }
  } finally {
    await pool.end();
  }
}

run().catch((err) => {
  console.error("❌ Migration failed:", err.message);
  process.exit(1);
});
