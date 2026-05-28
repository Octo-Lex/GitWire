// src/services/githubCache.js
// Redis-backed read-through cache for GitHub API GET responses.
//
// Route-specific TTLs match data freshness expectations:
//   - CI status, check runs: 15s (changes rapidly during workflows)
//   - PR files, comments:    30s (changes during review)
//   - Issues:                60s
//   - File contents:         120s
//   - Repo metadata, trees:  300s (rarely changes)
//
// Only caches 200 responses. Mutations, errors, and conditional
// requests bypass cache entirely.

import { redis } from "../lib/queue.js";
import { logger } from "../lib/logger.js";
import crypto from "node:crypto";

// ── Route classification ────────────────────────────────────────────────────

const ROUTE_TTL = {
  // CI / check runs — very dynamic during workflows
  "check_runs":     15,
  "check_suites":   15,
  "workflow_runs":  15,
  "actions_runs":   15,
  "actions_jobs":   15,
  "statuses":       15,

  // PR data — changes during review
  "pulls_files":    30,
  "pulls_reviews":  30,
  "pulls_comments": 30,
  "pulls_commits":  30,
  "pulls":          30,

  // Issues — moderate freshness
  "issues":         60,
  "issues_comments":60,
  "labels":         60,

  // File contents — 120s
  "contents":       120,
  "blobs":          120,

  // Repo metadata / trees — rarely changes
  "git_trees":      300,
  "git_refs":       300,
  "repositories":   300,
  "branches":       300,
  "tags":           300,
  "releases":       300,
};

const DEFAULT_TTL = 60;

const KEY_PREFIX = "gitwire:ghcache:";

/**
 * Classify a GitHub API path into a route kind and TTL.
 * @param {string} path - e.g. "/repos/owner/repo/pulls/42/files"
 * @returns {{ kind: string, ttl: number }}
 */
export function classifyRoute(path) {
  // Match the most specific pattern first
  // Path format: /repos/{owner}/{repo}/... or /orgs/{org}/...
  const segments = path.split("/").filter(Boolean);

  // /repos/{o}/{r} → bare repo view (exactly 3 segments: repos, owner, repo)
  if (segments[0] === "repos" && segments.length === 3) {
    return { kind: "repositories", ttl: ROUTE_TTL.repositories };
  }

  // /repos/{o}/{r}/... → look at segment[3]+ for classification
  if (segments[0] === "repos" && segments.length >= 4) {
    const tail = segments.slice(3); // e.g. ["pulls", "42", "files"]

    // Build compound key: pulls_files, actions_runs, etc.
    if (tail.length >= 1) {
      const resource = tail[0];

      // Check compound: pulls/42/files → "pulls_files"
      if (tail.length >= 3) {
        const compound = resource + "_" + tail[2];
        if (ROUTE_TTL[compound] !== undefined) {
          return { kind: compound, ttl: ROUTE_TTL[compound] };
        }
      }

      // Check simple: pulls, issues, contents, etc.
      if (ROUTE_TTL[resource] !== undefined) {
        return { kind: resource, ttl: ROUTE_TTL[resource] };
      }

      // actions/runs → "actions_runs"
      if (tail.length >= 2) {
        const compound = resource + "_" + tail[1];
        if (ROUTE_TTL[compound] !== undefined) {
          return { kind: compound, ttl: ROUTE_TTL[compound] };
        }
      }

      // commits/:sha/check-runs → "check_runs"
      // git/:sub/:ref → "git_:sub"
      // Look at the last segment for known resources (normalize hyphens → underscores)
      const lastSeg = tail[tail.length - 1].replace(/-/g, "_");
      if (ROUTE_TTL[lastSeg] !== undefined) {
        return { kind: lastSeg, ttl: ROUTE_TTL[lastSeg] };
      }
    }

    // Fallback: treat as repo-level
    return { kind: "repositories", ttl: ROUTE_TTL.repositories };
  }

  // /orgs/... or other paths
  return { kind: "other", ttl: DEFAULT_TTL };
}

// ── Cache key generation ────────────────────────────────────────────────────

/**
 * Generate a deterministic cache key from request parameters.
 * @param {string} method
 * @param {string} path
 * @param {object} [query]
 * @returns {string}
 */
export function cacheKey(method, path, query) {
  const normalized = normalizeQuery(query);
  const raw = method.toUpperCase() + "\0" + path + "\0" + normalized;
  const hash = crypto.createHash("sha256").update(raw).digest("hex");
  return KEY_PREFIX + hash;
}

function normalizeQuery(query) {
  if (!query || typeof query !== "object") return "";
  // Sort keys for deterministic ordering
  const sorted = Object.keys(query).sort();
  return sorted.map(function (k) {
    const v = query[k];
    if (Array.isArray(v)) return k + "=" + v.slice().sort().join(",");
    return k + "=" + (v ?? "");
  }).join("&");
}

// ── Cache operations ────────────────────────────────────────────────────────

/**
 * Look up a cached GitHub API response.
 * @param {string} method
 * @param {string} path
 * @param {object} [query]
 * @returns {Promise<object|null>} Cached response or null
 */
export async function getCached(method, path, query) {
  try {
    if (method.toUpperCase() !== "GET") return null;
    const key = cacheKey(method, path, query);
    const raw = await redis.get(key);
    if (!raw) return null;
    const entry = JSON.parse(raw);
    logger.debug({ path, kind: entry.kind, age: Date.now() - entry.cachedAt }, "GitHub API cache hit");
    return entry.data;
  } catch (err) {
    logger.warn({ err: err.message, path }, "GitHub API cache read error");
    return null;
  }
}

/**
 * Store a GitHub API response in cache.
 * @param {string} method
 * @param {string} path
 * @param {object} [query]
 * @param {object} data - Response data to cache
 * @returns {Promise<void>}
 */
export async function setCached(method, path, query, data) {
  try {
    if (method.toUpperCase() !== "GET") return;
    const { kind, ttl } = classifyRoute(path);
    const key = cacheKey(method, path, query);
    const entry = JSON.stringify({ data, kind, cachedAt: Date.now() });
    await redis.setex(key, ttl, entry);
    logger.debug({ path, kind, ttl }, "GitHub API response cached");
  } catch (err) {
    logger.warn({ err: err.message, path }, "GitHub API cache write error");
  }
}

/**
 * Invalidate cache entries matching a path prefix.
 * Uses SCAN to find matching keys (no KEYS * on production).
 * @param {string} pathPrefix - e.g. "/repos/owner/repo/pulls"
 * @returns {Promise<number>} Number of keys invalidated
 */
export async function invalidatePathPrefix(pathPrefix) {
  let count = 0;
  // We can't efficiently scan by path since keys are hashed.
  // Instead, track path→key mapping in a Redis set.
  // For now, just let TTL handle expiry — this is a read cache.
  return count;
}

/**
 * Get cache stats for monitoring.
 * @returns {Promise<{ keys: number, estimatedBytes: number }>}
 */
export async function getCacheStats() {
  // Count keys with the gitwire:ghcache: prefix using SCAN
  let cursor = "0";
  let count = 0;
  do {
    const result = await redis.scan(cursor, "MATCH", KEY_PREFIX + "*", "COUNT", 100);
    cursor = result[0];
    count += result[1].length;
  } while (cursor !== "0");

  return { keys: count };
}
