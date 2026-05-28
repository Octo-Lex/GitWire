// src/services/configService.js
// Fetches .gitwire.yml from GitHub, parses with @gitwire/rules,
// caches in Redis with 5-minute TTL.
//
// Resolution order (highest priority wins):
//   1. DB overrides (repo_config table — set via dashboard UI)
//   2. .gitwire.yml file (fetched from GitHub repo)
//   3. Org-level .gitwire.yml (from {org}/gitwire-config repo)
//   4. DEFAULT_CONFIG from @gitwire/rules

import { parseConfig, DEFAULT_CONFIG, mergeDeep } from "@gitwire/rules";
import { redis } from "../lib/queue.js";
import { getInstallationClient } from "../lib/github.js";
import { wrapOctokit } from "../lib/githubWrapper.js";
import { db } from "../lib/db.js";
import { logger } from "../lib/logger.js";

const CACHE_TTL = 300; // 5 minutes
const CACHE_PREFIX = "gitwire:config:";

const CONFIG_PATHS = [".github/.gitwire.yml", ".gitwire.yml"];

// Org-level config repo name — can be overridden via ENV
const ORG_CONFIG_REPO = process.env.GITWIRE_ORG_CONFIG_REPO || "gitwire-config";

/**
 * Get the resolved config for a repo.
 * Merge order: DEFAULT_CONFIG ← org/.gitwire.yml ← repo/.gitwire.yml ← DB overrides
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
  let layers = { defaults: true, org: false, repo: false, db: false };
  let orgSource = null;

  // 3. Layer on org-level .gitwire.yml
  const orgResult = await fetchOrgConfig(repoFullName);
  if (orgResult.config !== DEFAULT_CONFIG) {
    config = orgResult.config; // already merged with defaults by parseConfig
    layers.org = true;
    orgSource = orgResult.source;
  }

  // 4. Layer on repo-level YAML file from GitHub
  const yamlConfig = await fetchFromGitHub(repoFullName);
  if (yamlConfig !== DEFAULT_CONFIG) {
    config = yamlConfig; // already merged with defaults by parseConfig
    layers.repo = true;
  }

  // 5. Layer on DB overrides (dashboard UI)
  const dbOverrides = await fetchDBOverrides(repoFullName);
  if (dbOverrides && Object.keys(dbOverrides).length > 0) {
    config = mergeDeep(config, dbOverrides);
    layers.db = true;
  }

  // Attach layer metadata for dashboard visibility
  config._meta = {
    layers,
    org_source: orgSource,
    resolved_at: new Date().toISOString(),
  };

  // 6. Cache in Redis
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
 * Records the change in config_history for audit.
 */
export async function setConfigOverrides(repoFullName, overrides, updatedBy = "dashboard", action = "set") {
  const { rows: repoRows } = await db.query(
    "SELECT github_id FROM repositories WHERE full_name = $1",
    [repoFullName]
  );
  if (!repoRows.length) {
    throw new Error(`Repo not found: ${repoFullName}`);
  }
  const repoId = repoRows[0].github_id;

  // Capture current overrides for history (before overwrite)
  const { rows: prevRows } = await db.query(
    "SELECT config FROM repo_config WHERE repo_id = $1",
    [repoId]
  );
  const oldConfig = prevRows[0]?.config || null;

  await db.query(
    `INSERT INTO repo_config (repo_id, config, updated_at, updated_by)
     VALUES ($1, $2, NOW(), $3)
     ON CONFLICT (repo_id) DO UPDATE SET
       config = EXCLUDED.config,
       updated_at = NOW(),
       updated_by = EXCLUDED.updated_by`,
    [repoId, JSON.stringify(overrides), updatedBy]
  );

  // Record in history
  await recordHistory(repoId, action, oldConfig, overrides, updatedBy);

  // Invalidate cache so next read picks up the new overrides
  await invalidateConfigCache(repoFullName);

  logger.info({ repo: repoFullName, updatedBy, action }, "Config overrides updated");
}

/**
 * Delete DB config overrides for a repo (revert to YAML-only).
 * Records the deletion in config_history.
 */
export async function deleteConfigOverrides(repoFullName, deletedBy = "dashboard") {
  const { rows: repoRows } = await db.query(
    "SELECT github_id FROM repositories WHERE full_name = $1",
    [repoFullName]
  );
  if (!repoRows.length) return;
  const repoId = repoRows[0].github_id;

  // Capture current overrides for history
  const { rows: prevRows } = await db.query(
    "SELECT config FROM repo_config WHERE repo_id = $1",
    [repoId]
  );
  const oldConfig = prevRows[0]?.config || null;

  await db.query("DELETE FROM repo_config WHERE repo_id = $1", [repoId]);

  // Record deletion in history
  await recordHistory(repoId, "delete", oldConfig, null, deletedBy);

  await invalidateConfigCache(repoFullName);

  logger.info({ repo: repoFullName, deletedBy }, "Config overrides deleted (reverted to YAML)");
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

/**
 * Get config change history for a repo.
 */
export async function getConfigHistory(repoFullName, limit = 20) {
  const { rows } = await db.query(
    `SELECT ch.id, ch.action, ch.config_old, ch.config_new, ch.changed_by, ch.changed_at
     FROM config_history ch
     JOIN repositories r ON r.github_id = ch.repo_id
     WHERE r.full_name = $1
     ORDER BY ch.changed_at DESC
     LIMIT $2`,
    [repoFullName, limit]
  );
  return rows;
}

/**
 * Restore a specific historical config version.
 */
export async function restoreConfigVersion(repoFullName, historyId, restoredBy = "dashboard") {
  const { rows } = await db.query(
    `SELECT ch.config_new, ch.config_old
     FROM config_history ch
     JOIN repositories r ON r.github_id = ch.repo_id
     WHERE r.full_name = $1 AND ch.id = $2`,
    [repoFullName, historyId]
  );
  if (!rows.length) {
    throw new Error(`History entry ${historyId} not found for ${repoFullName}`);
  }

  const target = rows[0].config_new;
  if (!target) {
    throw new Error("Cannot restore a deletion entry — use delete overrides instead");
  }

  await setConfigOverrides(repoFullName, target, restoredBy, "restore");
  return target;
}

// ── Internal ────────────────────────────────────────────────────────────────

async function recordHistory(repoId, action, configOld, configNew, changedBy) {
  try {
    await db.query(
      `INSERT INTO config_history (repo_id, action, config_old, config_new, changed_by)
       VALUES ($1, $2, $3, $4, $5)`,
      [repoId, action, JSON.stringify(configOld), configNew ? JSON.stringify(configNew) : null, changedBy]
    );
  } catch (err) {
    // History is best-effort — never block the main operation
    logger.warn({ err: err.message, repoId }, "Failed to record config history");
  }
}

async function fetchFromGitHub(repoFullName) {
  const { rows } = await db.query(
    "SELECT installation_id FROM repositories WHERE full_name = $1",
    [repoFullName]
  );
  if (!rows.length) return structuredClone(DEFAULT_CONFIG);

  try {
    const octokit = wrapOctokit(await getInstallationClient(rows[0].installation_id));
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

// ── Org-level config ────────────────────────────────────────────────────────

/**
 * Fetch org-level .gitwire.yml from the {org}/gitwire-config repo.
 * Returns { config, source } where source is "org/gitwire-config" or null.
 */
async function fetchOrgConfig(repoFullName) {
  try {
    // Look up org name from installations table
    const { rows: [repo] } = await db.query(
      "SELECT r.installation_id, i.account_login " +
      "FROM repositories r " +
      "JOIN installations i ON i.github_id = r.installation_id " +
      "WHERE r.full_name = $1",
      [repoFullName]
    );
    if (!repo) return { config: structuredClone(DEFAULT_CONFIG), source: null };

    // Try to fetch org config from {org}/gitwire-config repo
    const octokit = wrapOctokit(await getInstallationClient(repo.installation_id));
    const [owner] = repoFullName.split("/");

    for (const path of CONFIG_PATHS) {
      try {
        const { data } = await octokit.request(
          "GET /repos/{owner}/{repo}/contents/{path}",
          {
            owner: repo.account_login,
            repo: ORG_CONFIG_REPO,
            path,
            headers: { accept: "application/vnd.github.v3.raw" },
          }
        );
        if (data) {
          logger.info(
            { org: repo.account_login, path, source: repo.account_login + "/" + ORG_CONFIG_REPO },
            "Org-level .gitwire.yml loaded"
          );
          return {
            config: parseConfig(data),
            source: repo.account_login + "/" + ORG_CONFIG_REPO,
          };
        }
      } catch (err) {
        if (err.status !== 404) {
          logger.warn(
            { err: err.message, org: repo.account_login },
            "Org config fetch error (non-404)"
          );
        }
        // 404 = no org config repo — that's normal, skip silently
      }
    }
  } catch (err) {
    logger.debug(
      { err: err.message, repo: repoFullName },
      "Org config resolution failed — using defaults"
    );
  }

  return { config: structuredClone(DEFAULT_CONFIG), source: null };
}

/**
 * Fetch plugin files from .gitwire/plugins/ directory in a repo.
 * Returns a map of function name → function (loaded from source).
 *
 * @param {string} repoFullName — owner/repo
 * @returns {Promise<object>} plugin filter functions
 */
export async function getPluginsForRepo(repoFullName) {
  const cacheKey = CACHE_PREFIX + "plugins:" + repoFullName;
  try {
    const cached = await redis.get(cacheKey);
    if (cached) {
      return JSON.parse(cached);
    }
  } catch (_e) {
    // Cache miss — continue
  }

  try {
    const [owner, repo] = repoFullName.split("/");
    const octokit = wrapOctokit(await getInstallationClient(owner));
    if (!octokit) return {};

    // Get the repo tree
    const { data: treeData } = await octokit.request("GET /repos/{owner}/{repo}/git/trees/{ref}", {
      owner,
      repo,
      ref: "HEAD",
      recursive: "1",
    });

    // Find plugin files
    const pluginFiles = (treeData.tree || [])
      .filter((entry) =>
        entry.type === "blob" &&
        entry.path.startsWith(".gitwire/plugins/") &&
        entry.path.endsWith(".js")
      );

    if (pluginFiles.length === 0) return {};

    // Fetch each plugin file's content
    const pluginSources = [];
    for (const file of pluginFiles) {
      try {
        const { data: blob } = await octokit.request("GET /repos/{owner}/{repo}/git/blobs/{sha}", {
          owner,
          repo,
          sha: file.sha,
        });
        const source = Buffer.from(blob.content, "base64").toString("utf-8");
        pluginSources.push({ source, filename: file.path.replace(".gitwire/plugins/", "") });
      } catch (_e) {
        // Skip files we can't read
      }
    }

    // Cache the source list (not the functions — they're not serializable)
    // The caller will load them with loadPlugins()
    const result = pluginSources;
    try {
      await redis.set(cacheKey, JSON.stringify(result), "EX", CACHE_TTL);
    } catch (_e) {
      // Cache write failure is non-critical
    }

    return result;
  } catch (err) {
    logger.debug(
      { err: err.message, repo: repoFullName },
      "Plugin fetch failed — returning empty"
    );
    return {};
  }
}
