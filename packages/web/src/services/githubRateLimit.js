// src/services/githubRateLimit.js
// Track GitHub API rate limit budget from response headers.
// Classify errors into cooldown strategies.
//
// After every GitHub API call, parse x-ratelimit-* headers and
// store remaining budget in Redis. When errors occur, classify
// them and set cooldown periods to prevent stampede on exhausted tokens.
//
// Workers check budget before making calls and defer jobs when
// cooling down.

import { redis } from "../lib/queue.js";
import { logger } from "../lib/logger.js";

const RATE_KEY_PREFIX = "gitwire:ratelimit:";
const COOLDOWN_KEY_PREFIX = "gitwire:cooldown:";

// ── Rate limit header parsing ───────────────────────────────────────────────

/**
 * Parse rate limit headers from a GitHub API response.
 * @param {Headers|object} headers - Response headers
 * @returns {{ remaining: number, limit: number, resetAt: number, resource: string, used: number }|null}
 */
export function parseRateHeaders(headers) {
  const get = typeof headers.get === "function"
    ? function (k) { return headers.get(k); }
    : function (k) { return headers[k] || headers[k.toLowerCase()]; };

  const remaining = parseInt(get("x-ratelimit-remaining"), 10);
  const limit     = parseInt(get("x-ratelimit-limit"), 10);
  const resetAt   = parseInt(get("x-ratelimit-reset"), 10);
  const resource  = get("x-ratelimit-resource") || "core";
  const used      = parseInt(get("x-ratelimit-used"), 10);
  const retryAfter = get("retry-after");

  if (!Number.isFinite(remaining) || !Number.isFinite(resetAt)) {
    return null;
  }

  return {
    remaining:   remaining,
    limit:       Number.isFinite(limit) ? limit : 0,
    resetAt:     resetAt,
    resource:    resource,
    used:        Number.isFinite(used) ? used : 0,
    retryAfter:  Number.isFinite(parseInt(retryAfter, 10)) ? parseInt(retryAfter, 10) : null,
  };
}

function getHeader(headers, name) {
  if (!headers) return null;
  if (typeof headers.get === "function") return headers.get(name);
  return headers[name] || headers[name.toLowerCase()] || null;
}

// ── Rate tracking ───────────────────────────────────────────────────────────

/**
 * Record rate limit info from a GitHub API response.
 * Stores remaining budget in Redis with TTL equal to reset window.
 * @param {Headers|object} headers - GitHub response headers
 */
export async function recordRateHeaders(headers) {
  const info = parseRateHeaders(headers);
  if (!info) return;

  const key = RATE_KEY_PREFIX + info.resource;
  const ttl = Math.max(1, info.resetAt - Math.floor(Date.now() / 1000));
  const payload = JSON.stringify({
    remaining: info.remaining,
    limit:     info.limit,
    resetAt:   info.resetAt,
    used:      info.used,
    updatedAt: Date.now(),
  });

  await redis.setex(key, ttl, payload);
  logger.debug(
    { resource: info.resource, remaining: info.remaining, limit: info.limit, resetIn: ttl + "s" },
    "Rate limit recorded"
  );
}

/**
 * Get current rate limit budget for a resource.
 * @param {string} [resource="core"]
 * @returns {Promise<{ remaining: number, limit: number, resetAt: number, cooldown: boolean }>}
 */
export async function getRateBudget(resource) {
  resource = resource || "core";
  const key = RATE_KEY_PREFIX + resource;
  const raw = await redis.get(key);
  if (!raw) {
    return { remaining: Infinity, limit: 0, resetAt: 0, cooldown: false };
  }
  const info = JSON.parse(raw);
  const cooldown = await isCoolingDown(resource);
  return { ...info, cooldown };
}

// ── Cooldown management ─────────────────────────────────────────────────────

/**
 * Classify a GitHub API error into a cooldown strategy.
 * @param {number} status - HTTP status code
 * @param {Headers|object} [headers] - Response headers
 * @returns {{ scope: string, ttlMs: number, reason: string }}
 */
export function classifyError(status, headers) {
  const info = parseRateHeaders(headers);

  switch (status) {
    case 401:
      // Token is invalid — stop everything
      return { scope: "global", ttlMs: 120_000, reason: "token_invalid" };

    case 403:
      if (info && info.remaining === 0) {
        // Rate limit exhausted — cooldown until reset
        const resetIn = Math.max(0, info.resetAt - Math.floor(Date.now() / 1000));
        return { scope: "resource:" + info.resource, ttlMs: resetIn * 1000 + 5000, reason: "rate_exhausted" };
      }
      // Permission issue — likely token scope problem
      return { scope: "global", ttlMs: 120_000, reason: "forbidden" };

    case 404:
      // Resource not found — no cooldown needed
      return { scope: "none", ttlMs: 0, reason: "not_found" };

    case 422:
      // Validation error — no cooldown needed
      return { scope: "none", ttlMs: 0, reason: "validation_error" };

    case 429:
      // Explicit rate limit hit
      if (info && info.retryAfter) {
        return { scope: "resource:" + info.resource, ttlMs: info.retryAfter * 1000, reason: "rate_limited_retry_after" };
      }
      // Use resource from headers if available, otherwise default to core
      var resource429 = (info && info.resource) || getHeader(headers, "x-ratelimit-resource") || "core";
      return { scope: "resource:" + resource429, ttlMs: 120_000, reason: "rate_limited" };

    default:
      if (status >= 500) {
        // GitHub transient error — short cooldown
        return { scope: "none", ttlMs: 0, reason: "server_error" };
      }
      return { scope: "none", ttlMs: 0, reason: "unknown" };
  }
}

/**
 * Set a cooldown period for a scope.
 * @param {string} scope - "global", "resource:core", etc.
 * @param {number} ttlMs - Cooldown duration in milliseconds
 * @param {string} reason
 */
export async function setCooldown(scope, ttlMs, reason) {
  if (scope === "none" || ttlMs <= 0) return;
  const key = COOLDOWN_KEY_PREFIX + scope;
  const ttlSec = Math.ceil(ttlMs / 1000);
  await redis.setex(key, ttlSec, JSON.stringify({ reason, setAt: Date.now() }));
  logger.warn({ scope, ttlSec, reason }, "GitHub API cooldown set");
}

/**
 * Check if a scope is currently in cooldown.
 * @param {string} [resource="core"]
 * @returns {Promise<boolean>}
 */
export async function isCoolingDown(resource) {
  resource = resource || "core";
  // Check both global and resource-specific cooldowns
  const [globalCd, resourceCd] = await Promise.all([
    redis.exists(COOLDOWN_KEY_PREFIX + "global"),
    redis.exists(COOLDOWN_KEY_PREFIX + "resource:" + resource),
  ]);
  return globalCd === 1 || resourceCd === 1;
}

/**
 * Get all active cooldowns for dashboard display.
 * @returns {Promise<Array<{ scope: string, reason: string, remainingMs: number }>>}
 */
export async function getActiveCooldowns() {
  const results = [];
  let cursor = "0";
  do {
    const [nextCursor, keys] = await redis.scan(
      cursor, "MATCH", COOLDOWN_KEY_PREFIX + "*", "COUNT", 50
    );
    cursor = nextCursor;
    for (const key of keys) {
      const raw = await redis.get(key);
      const ttl = await redis.ttl(key);
      if (raw && ttl > 0) {
        const scope = key.slice(COOLDOWN_KEY_PREFIX.length);
        const info = JSON.parse(raw);
        results.push({
          scope,
          reason: info.reason,
          remainingMs: ttl * 1000,
        });
      }
    }
  } while (cursor !== "0");
  return results;
}

/**
 * Get all tracked rate limit resources for dashboard display.
 * @returns {Promise<Array<{ resource: string, remaining: number, limit: number, resetAt: number }>>}
 */
export async function getAllRateBudgets() {
  const results = [];
  let cursor = "0";
  do {
    const [nextCursor, keys] = await redis.scan(
      cursor, "MATCH", RATE_KEY_PREFIX + "*", "COUNT", 50
    );
    cursor = nextCursor;
    for (const key of keys) {
      const raw = await redis.get(key);
      if (raw) {
        const resource = key.slice(RATE_KEY_PREFIX.length);
        const info = JSON.parse(raw);
        results.push({ resource, ...info });
      }
    }
  } while (cursor !== "0");
  return results;
}

/**
 * Wait for rate limit budget to become available.
 * Sleeps until the cooldown expires or budget is available.
 * @param {string} resource
 * @param {number} [needed=1] - How many requests we need
 * @param {number} [maxWaitMs=30000] - Maximum wait time
 * @returns {Promise<boolean>} true if budget is available, false if timed out
 */
export async function waitForBudget(resource, needed, maxWaitMs) {
  needed = needed || 1;
  maxWaitMs = maxWaitMs || 30000;
  resource = resource || "core";

  const deadline = Date.now() + maxWaitMs;

  while (Date.now() < deadline) {
    const cooling = await isCoolingDown(resource);
    if (!cooling) {
      const budget = await getRateBudget(resource);
      if (budget.remaining >= needed) return true;
    }

    // Sleep in 1s increments
    await new Promise(function (r) { setTimeout(r, 1000); });
  }

  return false;
}
