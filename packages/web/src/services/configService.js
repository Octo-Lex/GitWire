// @gitwire/rules — barrel export
// src/services/configService.js
// Fetches .gitwire.yml from GitHub, parses with @gitwire/rules,
// caches in Redis with 5-minute TTL.
//
// The configService owns the runtime coupling (GitHub API + Redis).
// @gitwire/rules stays pure — no network, no cache.

import { parseConfig, DEFAULT_CONFIG } from "@gitwire/rules";
import { redis } from "../lib/queue.js";
import { getInstallationClient } from "../lib/github.js";
import { db } from "../lib/db.js";
import { logger } from "../lib/logger.js";

const CACHE_TTL = 300; // 5 minutes
const CACHE_PREFIX = "gitwire:config:";

const CONFIG_PATHS = [".github/.gitwire.yml", ".gitwire.yml"];

/**
 * Get the resolved .gitwire.yml config for a repo.
 * Checks Redis cache first, then fetches from GitHub API.
 * Returns DEFAULT_CONFIG if no .gitwire.yml exists in the repo.
 *
 * @param {string} repoFullName — e.g. "owner/repo"
 * @returns {Promise<object>} resolved config object
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
    logger.warn({ err: err.message, repo: repoFullName }, "Redis cache read failed — fetching from GitHub");
  }

  // 2. Fetch from GitHub
  const config = await fetchFromGitHub(repoFullName);

  // 3. Cache in Redis
  try {
    await redis.set(cacheKey, JSON.stringify(config), "EX", CACHE_TTL);
  } catch (err) {
    logger.warn({ err: err.message, repo: repoFullName }, "Redis cache write failed — config not cached");
  }

  return config;
}

/**
 * Invalidate the cached config for a repo.
 * Called when a push touches .gitwire.yml.
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
 * Fetch and parse .gitwire.yml from the GitHub repository.
 * Tries .github/.gitwire.yml first, then root .gitwire.yml.
 * Returns DEFAULT_CONFIG if not found or on any error.
 */
async function fetchFromGitHub(repoFullName) {
  // Look up installation for this repo
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
          const config = parseConfig(data);
          logger.info({ repo: repoFullName, path }, ".gitwire.yml loaded");
          return config;
        }
      } catch (err) {
        if (err.status !== 404) throw err;
        // 404 = not at this path, try next
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
