// src/services/configService.js
// Fetches .gitwire.yml from GitHub, parses with @gitwire/rules,
// caches in Redis with 5-minute TTL.
//
// Resolution order (highest priority wins):
//   1. DB overrides (repo_config table — set via dashboard UI)
//   2. .gitwire.yml file (fetched from GitHub repo)
//   3. DEFAULT_CONFIG from @gitwire/rules

import { parseConfig, DEFAULT_CONFIG, mergeDeep } from "@gitwire/rules";
import { redis } from "../lib/queue.js";
import { getInstallationClient } from "../lib/github.js";
import { db } from "../lib/db.js";
import { logger } from "../lib/logger.js";

const CACHE_TTL = 300; // 5 minutes
const CACHE_PREFIX = "gitwire:config:";

const CONFIG_PATHS = [".github/.gitwire.yml", ".gitwire.yml"];

/**
 * Get the resolved config for a repo.
 * Merge order: DEFAULT_CONFIG ← YAML file ← DB overrides
 */
export async function getConfigForRepo(repoFullName) {
  const cacheKey = CACHE_PREFIX + repoFullName;

  // 1. Check Redis cache
  try {
    const cached = await redis.get(cacheKey);
    if (cached) {
      try {
        return JSON.parse(cached);
      } catch {
        logger.warn({ repo: repoFullName }, "Corrupted config cache — refetching");
      }
    }
  } catch (err) {
    logger.warn({ err: err.message, repo: repoFullName }, "Redis cache read failed");
  }

  // 2. Start from defaults
  let config = structuredClone(DEFAULT_CONFIG);

  // 3. Layer on YAML file from GitHub
  const yamlConfig = await fetchFromGitHub(repoFullName);
  if (yamlConfig !== DEFAULT_CONFIG) {
    config = yamlConfig; // already merged with defaults by parseConfig
  }

  // 4. Layer on DB overrides (dashboard UI)
  const dbOverrides = await fetchDBOverrides(repoFullName);
  if (dbOverrides && Object.keys(dbOverrides).length > 0) {
    config = mergeDeep(config, dbOverrides);
  }

  // 5. Cache in Redis
  try {
    await redis.set(cacheKey, JSON.stringify(config), "EX", CACHE_TTL);
  } catch (err) {
    logger.warn({ err: err.message, repo: repoFullName }, "Redis cache write failed");
  }

  return config;
}

/**
 * Get DB overrides for a repo (raw, not merged).
 * Used by the API to show current overrides to the dashboard.
 */
export async function getConfigOverrides(repoFullName) {
  const { rows } = await db.query(
    `SELECT rc.config, rc.updated_at, rc.updated_by
     FROM repo_config rc
     JOIN repositories r ON r.github_id = rc.repo_id
     WHERE r.full_name = $1`,
    [repoFullName]
  );
  return rows[0] || null;
}

/**
 * Set DB config overrides for a repo (replaces entirely).
 * Used by the dashboard UI.
 */
export async function setConfigOverrides(repoFullName, overrides, updatedBy = "dashboard") {
  const { rows: repoRows } = await db.query(
    "SELECT github_id FROM repositories WHERE full_name = $1",
    [repoFullName]
  );
  if (!repoRows.length) {
    throw new Error(`Repo not found: ${repoFullName}`);
  }
  const repoId = repoRows[0].github_id;

  await db.query(
    `INSERT INTO repo_config (repo_id, config, updated_at, updated_by)
     VALUES ($1, $2, NOW(), $3)
     ON CONFLICT (repo_id) DO UPDATE SET
       config = EXCLUDED.config,
       updated_at = NOW(),
       updated_by = EXCLUDED.updated_by`,
    [repoId, JSON.stringify(overrides), updatedBy]
  );

  // Invalidate cache so next read picks up the new overrides
  await invalidateConfigCache(repoFullName);

  logger.info({ repo: repoFullName, updatedBy }, "Config overrides updated");
}

/**
 * Delete DB config overrides for a repo (revert to YAML-only).
 */
export async function deleteConfigOverrides(repoFullName) {
  const { rows: repoRows } = await db.query(
    "SELECT github_id FROM repositories WHERE full_name = $1",
    [repoFullName]
  );
  if (!repoRows.length) return;

  await db.query("DELETE FROM repo_config WHERE repo_id = $1", [repoRows[0].github_id]);
  await invalidateConfigCache(repoFullName);

  logger.info({ repo: repoFullName }, "Config overrides deleted (reverted to YAML)");
}

/**
 * Invalidate the cached config for a repo.
 */
export async function invalidateConfigCache(repoFullName) {
  try {
    await redis.del(CACHE_PREFIX + repoFullName);
    logger.info({ repo: repoFullName }, "Config cache invalidated");
  } catch (err) {
    logger.warn({ err: err.message }, "Failed to invalidate config cache");
  }
}

// ── Internal ────────────────────────────────────────────────────────────────

async function fetchFromGitHub(repoFullName) {
  const { rows } = await db.query(
    "SELECT installation_id FROM repositories WHERE full_name = $1",
    [repoFullName]
  );
  if (!rows.length) return structuredClone(DEFAULT_CONFIG);

  try {
    const octokit = await getInstallationClient(rows[0].installation_id);
    const [owner, repo] = repoFullName.split("/");

    for (const path of CONFIG_PATHS) {
      try {
        const { data } = await octokit.request(
          "GET /repos/{owner}/{repo}/contents/{path}",
          {
            owner,
            repo,
            path,
            headers: { accept: "application/vnd.github.v3.raw" },
          }
        );
        if (data) {
          logger.info({ repo: repoFullName, path }, ".gitwire.yml loaded");
          return parseConfig(data);
        }
      } catch (err) {
        if (err.status !== 404) throw err;
      }
    }
  } catch (err) {
    logger.warn(
      { err: err.message, repo: repoFullName },
      "Failed to fetch .gitwire.yml — using defaults"
    );
  }

  return structuredClone(DEFAULT_CONFIG);
}

async function fetchDBOverrides(repoFullName) {
  try {
    const { rows } = await db.query(
      `SELECT rc.config
       FROM repo_config rc
       JOIN repositories r ON r.github_id = rc.repo_id
       WHERE r.full_name = $1`,
      [repoFullName]
    );
    return rows[0]?.config || null;
  } catch (err) {
    // Table might not exist yet (pre-migration)
    logger.debug({ err: err.message }, "DB config overrides not available");
    return null;
  }
}
