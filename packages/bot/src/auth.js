// packages/bot/src/auth.js
// Telegram user → GitWire API key mapping stored in Redis.
// Uses the shared Redis instance on the Docker network.

import Redis from "ioredis";

const redis = new Redis(process.env.REDIS_URL || "redis://redis:6379");
const PREFIX = "gitwire:tg-auth:";

/**
 * Store a Telegram user's API key.
 * Key: gitwire:tg-auth:<telegram_user_id> → API key
 */
export async function setUserKey(telegramUserId, apiKey) {
  await redis.set(PREFIX + telegramUserId, apiKey);
}

/**
 * Retrieve a Telegram user's API key. Returns null if not authenticated.
 */
export async function getUserKey(telegramUserId) {
  return redis.get(PREFIX + telegramUserId);
}

/**
 * Remove a Telegram user's API key (logout).
 */
export async function removeUserKey(telegramUserId) {
  await redis.del(PREFIX + telegramUserId);
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
 * Format number for Telegram display.
 */
export function fmtNum(n) {
  if (n == null) return "—";
  if (n >= 1000000) return (n / 1000000).toFixed(1) + "M";
  if (n >= 1000) return (n / 1000).toFixed(1) + "K";
  return String(n);
}

/**
 * Format percent (0-1 range).
 */
export function fmtPct(n) {
  if (n == null) return "—";
  return (n * 100).toFixed(1) + "%";
}

/**
 * Truncate string.
 */
export function trunc(s, max = 60) {
  if (!s) return "—";
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

/**
 * Escape HTML for Telegram.
 */
export function escHtml(s) {
  if (!s) return "";
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
