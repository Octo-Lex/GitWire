// packages/bot/src/auth.js
// Telegram user → GitWire API key mapping stored in Redis.
//
// Wave 2 refactor (issue #94): the Redis client is now dependency-injected
// via createAuth(redis) instead of created at module level. The production
// entry module constructs it from environment configuration. The proof
// harness supplies a disposable Redis client.

import Redis from "ioredis";

const PREFIX = "gitwire:tg-auth:";

// Module-level singleton (backward compatible with production code that
// imports functions directly). Initialized lazily on first use.
let _redis = null;

function getRedis() {
  if (!_redis) {
    _redis = new Redis(process.env.REDIS_URL || "redis://redis:6379");
  }
  return _redis;
}

/**
 * Dependency-injection factory. The proof harness calls this with a
 * disposable Redis client. Production code can ignore it — the lazy
 * singleton initializes from process.env.REDIS_URL.
 * @param {import('ioredis').Redis} redisClient
 */
export function setRedisClient(redisClient) {
  if (_redis) { try { _redis.disconnect(); } catch {} }
  _redis = redisClient;
}

/**
 * Close the Redis connection (for deterministic teardown).
 */
export async function closeAuth() {
  if (_redis) { try { await _redis.quit(); } catch {} _redis = null; }
}

/**
 * Store a Telegram user's API key.
 */
export async function setUserKey(telegramUserId, apiKey) {
  await getRedis().set(PREFIX + telegramUserId, apiKey);
}

/**
 * Retrieve a Telegram user's API key. Returns null if not authenticated.
 */
export async function getUserKey(telegramUserId) {
  return getRedis().get(PREFIX + telegramUserId);
}

/**
 * Remove a Telegram user's API key (logout).
 */
export async function removeUserKey(telegramUserId) {
  await getRedis().del(PREFIX + telegramUserId);
}

/**
 * Check if a user is authenticated. Returns the API key or throws.
 */
export async function requireAuth(telegramUserId) {
  const key = await getUserKey(telegramUserId);
  if (!key) {
    throw new Error("NOT_AUTHENTICATED");
  }
  return key;
}

/**
 * Resolve the installation_id for a repository from trusted server state.
 * This is the trusted resource lookup — not derived from Telegram metadata.
 * Uses the single-repo endpoint GET /api/repos/:owner/:repo which returns
 * the row directly (including installation_id from r.*). The list endpoint
 * /api/repos?search= does NOT include installation_id in its SELECT list,
 * so it cannot be used to resolve the trusted resource.
 * Returns null if the repository is not found or the lookup fails.
 * @param {string} repoFullName - "owner/repo"
 * @param {string} apiBaseUrl - the GitWire API URL
 * @param {string} apiKey - the user's API key for auth
 */
export async function resolveInstallationId(repoFullName, apiBaseUrl, apiKey) {
  try {
    const parts = repoFullName.split("/");
    if (parts.length !== 2) return null;
    const [owner, repo] = parts;
    const res = await fetch(`${apiBaseUrl}/api/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) return null;
    const row = await res.json();
    return row?.installation_id || null;
  } catch {
    return null;
  }
}

// Display utility functions (no state)

export function fmtNum(n) {
  if (n == null) return "—";
  if (n >= 1000000) return (n / 1000000).toFixed(1) + "M";
  if (n >= 1000) return (n / 1000).toFixed(1) + "K";
  return String(n);
}

export function fmtPct(n) {
  if (n == null) return "—";
  return (n * 100).toFixed(1) + "%";
}

export function trunc(s, max = 60) {
  if (!s) return "—";
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

export function escHtml(s) {
  if (!s) return "";
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
