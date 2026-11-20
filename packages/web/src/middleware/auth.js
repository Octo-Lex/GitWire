// src/middleware/auth.js
// API key + session cookie authentication for REST API routes.
// Accepts:
//   1. Authorization: Bearer <key> header
//   2. gitwire-session cookie (Redis-backed session)
// Skips auth for /health, /webhooks, and /api/auth/*.

import { config } from "../../config/index.js";
import { logger } from "../lib/logger.js";
import { redis } from "../lib/queue.js";
import { extractBearerToken } from "./bearerToken.js";

const SESSION_PREFIX = "gitwire:session:";

// Parse cookies from request header
function parseCookies(req) {
  const header = req.headers.cookie;
  if (!header) return {};
  const cookies = {};
  for (const pair of header.split(";")) {
    const [k, ...v] = pair.split("=");
    cookies[k.trim()] = v.join("=").trim();
  }
  return cookies;
}

// ── Resolve allowed keys ────────────────────────────────────────────────────
const keys = new Set();

if (process.env.API_KEY) {
  keys.add(process.env.API_KEY);
}
if (process.env.API_KEYS) {
  for (const k of process.env.API_KEYS.split(",")) {
    const trimmed = k.trim();
    if (trimmed) keys.add(trimmed);
  }
}

// SECURITY: If no keys are configured in production, fail closed.
// Previously this auto-generated a random UUID and logged it — that behavior
// is unsafe because it creates an unmanaged credential visible in logs.
if (keys.size === 0) {
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "No API_KEY or API_KEYS configured in production. " +
      "Set API_KEY in the environment before starting the application."
    );
  }
  // In non-production (development, test), auto-generate is still acceptable.
  const generated = crypto.randomUUID();
  keys.add(generated);
  logger.warn(
    `No API_KEY set. Generated: ${generated}. Set API_KEY in .env to control access.`
  );
}

/**
 * Express middleware that checks for a valid API key.
 * Accepts key via:
 *   - Authorization: Bearer <key> header
 *
 * Skips /health and /webhooks paths.
 */
export async function apiKeyAuth(req, res, next) {
  // Skip auth for health checks, webhook endpoint, and auth routes
  if (
    req.path === "/health" ||
    req.path.startsWith("/webhooks") ||
    req.path.startsWith("/api/auth")
  ) {
    return next();
  }

  // Extract the key from the Authorization header (the only in-header
  // channel; there is no query-parameter key path). Recognition lives in
  // the shared bearerToken.js helper so apiKeyAuth and the rate limiter
  // cannot drift apart (the limiter derives its identity from the exact
  // same forms auth accepts).
  const providedKey = extractBearerToken(req.headers.authorization) || null;

  // Check session cookie if no Bearer token
  if (!providedKey) {
    const cookies = parseCookies(req);
    const sessionToken = cookies["gitwire-session"];
    if (sessionToken) {
      try {
        const data = await redis.get(SESSION_PREFIX + sessionToken);
        if (data) {
          // Valid session — refresh TTL
          await redis.expire(SESSION_PREFIX + sessionToken, 7 * 24 * 60 * 60);
          return next();
        }
      } catch (err) {
        logger.warn({ err }, "Session lookup failed");
      }
    }
  }

  if (!providedKey || !keys.has(providedKey)) {
    return res.status(401).json({ error: "Invalid or missing API key" });
  }

  next();
}
