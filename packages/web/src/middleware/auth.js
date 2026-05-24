// src/middleware/auth.js
// API key + session cookie authentication for REST API routes.
// Accepts:
//   1. Authorization: Bearer <key> header
//   2. ?api_key=<key> query parameter
//   3. gitwire-session cookie (Redis-backed session)
// Skips auth for /health, /webhooks, and /api/auth/*.

import { config } from "../../config/index.js";
import { logger } from "../lib/logger.js";
import { redis } from "../lib/queue.js";

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

// If no keys configured, generate a random one and log it once
if (keys.size === 0) {
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
 *   - ?api_key=<key> query parameter
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

  // Extract key from header or query param
  let providedKey = null;

  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith("Bearer ")) {
    providedKey = authHeader.slice(7).trim();
  }

  if (!providedKey && req.query?.api_key) {
    providedKey = req.query.api_key;
  }

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
