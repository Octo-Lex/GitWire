// src/services/configService.js
// Configuration resolution over the W2-04 canonical layering model.
//
// Fetches each sparse source, resolves through @gitwire/rules'
// resolveConfigLayers(), and caches the complete resolution bundle
// (config + provenance + version vector + effective hash) in Redis.
//
// Resolution order (lowest → highest, sparse — a layer overrides only the
// values it explicitly supplies):
//   1. DEFAULT_CONFIG from @gitwire/rules (enrollment-safe)
//   2. Org-level .gitwire.yml (from {org}/gitwire-config repo)
//   3. Repo .gitwire.yml (.github/.gitwire.yml, then .gitwire.yml)
//   4. Governed live-policy materialization (repo_config, written only by
//      W2-02 governed promotion since W2-03; consumed read-only here)
//
// Every org/repo source carries a stable revision (the fetched blob SHA);
// the governed layer carries the immutable policy version + promotion
// identity when an active binding exists, or an explicit legacy identity
// (never falsely labelled immutable) for pre-W2-03 rows.

import {
  parseConfigLayer,
  resolveConfigLayers,
  DEFAULT_CONFIG,
  CONFIG_SCHEMA_VERSION,
} from "@gitwire/rules";
import { redis } from "../lib/queue.js";
import { getInstallationClient } from "../lib/github.js";
import { wrapOctokit } from "../lib/githubWrapper.js";
import { db } from "../lib/db.js";
import { logger } from "../lib/logger.js";

const CACHE_TTL = 300; // 5 minutes
// Resolver-generation segment of the cache key, DERIVED from the defaults
// schema version: entries written by a previous resolution model (older
// defaults, pre-provenance _meta shape) can never be accepted as hits, and
// any future DEFAULT_CONFIG change that bumps CONFIG_SCHEMA_VERSION starts
// a fresh cache namespace automatically.
const CACHE_GENERATION = `config:${CONFIG_SCHEMA_VERSION}`;
const CACHE_PREFIX = `gitwire:config:${CACHE_GENERATION}:`;

const CONFIG_PATHS = [".github/.gitwire.yml", ".gitwire.yml"];

// Org-level config repo name — can be overridden via ENV
const ORG_CONFIG_REPO = process.env.GITWIRE_ORG_CONFIG_REPO || "gitwire-config";

/**
 * Get the resolved config for a repo.
 *
 * Returns the effective config with `_meta` carrying the complete W2-04
 * resolution evidence: layers, provenance (pointer → supplying layer),
 * provenance_sources (per-layer source identities), version_vector,
 * effective_hash, org_source, and the observational resolved_at.
 * `_explicitKeys` lists top-level keys explicitly supplied by the YAML
 * sources (consumed by quality-gate precedence).
 *
 * The cache stores the whole config-with-_meta bundle so a hit can never
 * return configuration without its resolution evidence.
 */
export async function getConfigForRepo(repoFullName) {
  const cacheKey = CACHE_PREFIX + repoFullName;

  // 1. Check Redis cache (the bundle is cached as one coherent object)
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

  // 2. Fetch every sparse source with its stable identity
  const [orgLayer, repoLayer, governedLayer] = await Promise.all([
    fetchOrgConfig(repoFullName),
    fetchRepoConfig(repoFullName),
    fetchGovernedConfig(repoFullName),
  ]);

  // 3. Canonical sparse resolution
  const resolution = resolveConfigLayers({
    defaults: DEFAULT_CONFIG,
    org: orgLayer,
    repo: repoLayer,
    governed: governedLayer,
  });

  const config = resolution.config;
  config._explicitKeys = resolution.explicitKeys;
  config._meta = {
    layers: resolution.layers,
    org_source: orgLayer ? orgLayer.source : null,
    provenance: resolution.provenance,
    provenance_sources: resolution.provenanceSources,
    version_vector: resolution.versionVector,
    effective_hash: resolution.effectiveHash,
    config_schema_version: CONFIG_SCHEMA_VERSION,
    resolved_at: new Date().toISOString(),
  };

  // 4. Cache the complete bundle
  try {
    await redis.set(cacheKey, JSON.stringify(config), "EX", CACHE_TTL);
  } catch (err) {
    logger.warn({ err: err.message, repo: repoFullName }, "Redis cache write failed");
  }

  return config;
}

/**
 * Resolve a PROPOSED .gitwire.yml as a prospective repository layer over the
 * repository's current stack — org layer, GOVERNED layer, and the safe
 * defaults — so previews (validate/simulate/diff/recommend) show exactly the
 * effective configuration the proposal would produce. Omitting the governed
 * layer here would make previews report governed values flipping back to
 * defaults, which a repo-layer proposal cannot do.
 *
 * Throws on invalid YAML/shape exactly like parseConfig().
 * The proposed layer's provenance/vector metadata is intentionally omitted —
 * callers preview effective VALUES, not resolution identity.
 */
export async function resolveProposedConfig(repoFullName, yamlText) {
  const { layer } = parseConfigLayer(yamlText);
  // Org and governed layers participate when readable. Operational failures
  // (ConfigSourceUnavailableError / DB errors) propagate so a preview never
  // shows an effective policy computed with a layer silently missing; a
  // validation failure in a fetched source propagates attributed to the
  // exact file. Previews classify the two error classes distinctly.
  const [orgLayer, governedLayer] = await Promise.all([
    fetchOrgConfig(repoFullName),
    fetchGovernedConfig(repoFullName),
  ]);
  return resolveConfigLayers({
    defaults: DEFAULT_CONFIG,
    org: orgLayer,
    repo: { values: layer, source: "proposed:.gitwire.yml" },
    governed: governedLayer,
  }).config;
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

// A deployment without GitHub App credentials structurally has no org/repo
// YAML layers — that is absence, not an outage. Any other client-creation
// failure IS an outage and fails resolution.
function isGitHubAppUnconfigured(err) {
  return /GitHub App not configured/.test(String(err?.message || ""));
}

async function makeInstallationClient(installationId, sourceId) {
  try {
    return wrapOctokit(await getInstallationClient(installationId));
  } catch (err) {
    if (isGitHubAppUnconfigured(err)) return null;
    throw new ConfigSourceUnavailableError(sourceId, err.message);
  }
}

/**
 * A configuration source EXISTS but could not be read right now (GitHub
 * 403/5xx/network failure, oversized file, DB failure). This is a different
 * state from absence: treating an unreadable higher-precedence layer as
 * absent could expose a more permissive lower layer during an outage (for
 * example losing a governed dry_run=true restriction). Resolution fails
 * instead of dropping the layer.
 */
export class ConfigSourceUnavailableError extends Error {
  constructor(source, reason) {
    super(`Configuration source currently unreadable (${source}): ${reason}`);
    this.name = "ConfigSourceUnavailableError";
    this.source = source;
    this.reason = reason;
  }
}

export function isConfigSourceUnavailable(err) {
  return err instanceof ConfigSourceUnavailableError;
}

// Fetch a YAML config file from GitHub, returning the sparse layer plus a
// stable source identity ("{owner}/{repo}@{path}#{blobSha}"). Uses the JSON
// contents response so the blob SHA (the stable revision) is available.
//
//   null             — absent: 404, or an explicitly empty document
//   validation throw — present but invalid (prefixed with the exact file)
//   source-unavailable throw — present but unreadable (transport/oversized)
async function fetchConfigFile(octokit, owner, repoName, path) {
  const sourceId = `${owner}/${repoName}@${path}`;
  let data;
  try {
    ({ data } = await octokit.request(
      "GET /repos/{owner}/{repo}/contents/{path}",
      { owner, repo: repoName, path },
    ));
  } catch (err) {
    if (err.status === 404) return null;
    throw new ConfigSourceUnavailableError(sourceId, err.message);
  }
  if (!data || typeof data.content !== "string" || data.encoding === "none") {
    // Oversized files (>1MB) come back with null content or encoding
    // "none". The file exists, so resolution fails: a safety-bearing large
    // config must not silently vanish from the stack.
    throw new ConfigSourceUnavailableError(
      sourceId,
      data?.message || "contents API returned no readable content",
    );
  }
  if (data.content === "") {
    // A 0-byte file is an explicitly empty document — an empty layer, not
    // an unreadable source (GitHub returns encoding "base64" here).
    return null;
  }
  const yamlText = Buffer.from(data.content, "base64").toString("utf-8");
  try {
    const { layer } = parseConfigLayer(yamlText);
    if (Object.keys(layer).length === 0) return null;
    return {
      values: layer,
      source: `${owner}/${repoName}@${path}#${data.sha}`,
    };
  } catch (err) {
    // Attribute the rejection to the exact file so preview surfaces never
    // blame a user's proposed YAML for a broken org/repo source.
    if (isConfigValidationError(err)) {
      const wrapped = new Error(
        `Invalid .gitwire.yml in ${owner}/${repoName}@${path}: ` +
        err.message.replace(/^Invalid \.gitwire\.yml:\s*/, ""),
      );
      // Marks the rejection as belonging to a FETCHED source, so preview
      // surfaces never present it as a verdict on the user's proposal.
      wrapped.invalidConfigSource = `${owner}/${repoName}@${path}`;
      throw wrapped;
    }
    throw err;
  }
}

// Validation errors from parseConfigLayer carry this prefix and must always
// surface; only the source being genuinely absent degrades a layer.
// Preview services classify by validation-ness: anything that is not a
// validation rejection (ConfigSourceUnavailableError, raw DB errors,
// unexpected failures) is an outage surface, never "invalid proposal".
export function isConfigValidationError(err) {
  return typeof err?.message === "string" && err.message.startsWith("Invalid .gitwire.yml");
}

async function fetchRepoConfig(repoFullName) {
  const { rows } = await db.query(
    "SELECT installation_id FROM repositories WHERE full_name = $1",
    [repoFullName],
  );
  if (!rows.length) return null;

  const octokit = await makeInstallationClient(rows[0].installation_id, repoFullName);
  if (!octokit) return null; // app unconfigured: no GitHub YAML layers exist
  const [owner, repoName] = repoFullName.split("/");

  for (const path of CONFIG_PATHS) {
    // 404/absent returns null; validation and source-unavailable throw.
    const found = await fetchConfigFile(octokit, owner, repoName, path);
    if (found) {
      logger.info({ repo: repoFullName, path, revision: found.source }, ".gitwire.yml loaded");
      return found;
    }
  }

  return null;
}

/**
 * Fetch the governed live-policy layer (repo_config) with its identity.
 *
 * Since W2-03, repo_config is written only by W2-02 governed promotion. When
 * an active_policy_bindings row exists, the identity is the immutable policy
 * version + promotion record. Pre-W2-03 legacy rows (no binding) are labeled
 * explicitly as legacy compatibility data — never as an immutable governed
 * version. Returns null when the repo has no materialized live policy.
 */
async function fetchGovernedConfig(repoFullName) {
  // Errors propagate: the governed layer is the highest-precedence safety
  // authority, and a transient DB failure must never silently remove it
  // (a promoted dry_run=true restriction would vanish mid-outage).
  const { rows: [row] } = await db.query(
    `SELECT rc.config,
            rc.updated_at,
            apb.policy_version_id,
            apb.promotion_record_id
       FROM repo_config rc
       JOIN repositories r ON r.github_id = rc.repo_id
       LEFT JOIN active_policy_bindings apb ON apb.repo_id = rc.repo_id
      WHERE r.full_name = $1`,
    [repoFullName],
  );
  if (!row || !row.config || Object.keys(row.config).length === 0) return null;

  if (row.policy_version_id && row.promotion_record_id) {
    return {
      values: row.config,
      source: `policy_version:${row.policy_version_id}:promotion:${row.promotion_record_id}`,
    };
  }

  // Legacy compatibility row — explicitly not an immutable governed version.
  return {
    values: row.config,
    source: `legacy:repo_config:${new Date(row.updated_at).toISOString()}`,
  };
}

// ── Org-level config ────────────────────────────────────────────────────────

/**
 * Fetch the org-level .gitwire.yml from the {org}/gitwire-config repo.
 * Returns { values, source } or null when the org has no config.
 */
async function fetchOrgConfig(repoFullName) {
  // Look up org name from installations table. A repo with no installation
  // row has no org layer (absent); DB and client failures propagate —
  // either as ConfigSourceUnavailableError or the underlying DB error.
  const { rows: [repo] } = await db.query(
    "SELECT r.installation_id, i.account_login " +
    "FROM repositories r " +
    "JOIN installations i ON i.github_id = r.installation_id " +
    "WHERE r.full_name = $1",
    [repoFullName],
  );
  if (!repo) return null;

  const octokit = await makeInstallationClient(
    repo.installation_id,
    `${repo.account_login}/${ORG_CONFIG_REPO}`,
  );
  if (!octokit) return null; // app unconfigured: no org layer exists

  for (const path of CONFIG_PATHS) {
    // 404/absent returns null (no org config repo is the normal case);
    // validation and source-unavailable failures throw.
    const found = await fetchConfigFile(octokit, repo.account_login, ORG_CONFIG_REPO, path);
    if (found) {
      logger.info(
        { org: repo.account_login, path, revision: found.source },
        "Org-level .gitwire.yml loaded",
      );
      return found;
    }
  }

  return null;
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
