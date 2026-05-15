// src/middleware/auth.js
// Simple API key authentication for REST API routes.
// Reads API_KEYS from env (comma-separated) or falls back to a single API_KEY.
// Skips auth for /health and /webhooks (those handle their own verification).

import { config } from "../../config/index.js";
import { logger } from "../lib/logger.js";

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
export function apiKeyAuth(req, res, next) {
  // Skip auth for health checks and webhook endpoint
  if (req.path === "/health" || req.path.startsWith("/webhooks")) {
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

  if (!providedKey || !keys.has(providedKey)) {
    return res.status(401).json({ error: "Invalid or missing API key" });
  }

  next();
}
