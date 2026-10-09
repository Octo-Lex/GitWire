// src/middleware/rateLimiter.js
// Simple sliding-window rate limiter backed by Redis.
// Limits API requests per IP (or per API key when available).

import { redis } from "../lib/queue.js";
import { logger } from "../lib/logger.js";

const WINDOW_MS = 60_000;   // 1 minute window
const MAX_REQUESTS = 120;   // 120 req/min per identity (~2 req/sec)

// Identity derivation, isolated from the handler so the middleware reads
// like the throttle it is (CodeQL's missing-rate-limiting model pairs
// credential reads inside a route handler with recognized limiter sinks;
// the derivation here IS the limiter's own identity selection).
//
// Contract:
// - A properly formed Bearer token (apiKeyAuth-EXACT recognition:
//   case-sensitive "Bearer " prefix, single space, slice(7).trim()) is the
//   identity on ordinary paths. Anything looser re-opens the rotation
//   bypass ("Bearer\t<x>" / "bearer <x>" are NOT Bearer for auth, so they
//   must not mint buckets either) — reproduced in
//   rate-limiter-behavior.test.js, pinned in rate-limiter-identity.test.js.
// - PRE-AUTHENTICATION endpoints (/api/auth/login, which authenticates by
//   request-body password while the limiter runs before auth) ALWAYS key on
//   the request IP: an unverified token must never become their throttle
//   identity. Trailing-slash and case variants are tolerated because
//   Express's default non-strict, case-insensitive-to-route matching
//   serves them to the same handler.
// - Everything else falls back to the request IP.
export function deriveLimiterIdentity(req) {
  const authHeader = req.headers.authorization;
  const isPreAuthPath = typeof req.path === "string"
    && /^\/api\/auth\/login\/?$/i.test(req.path);
  const bearerToken = !isPreAuthPath && typeof authHeader === "string" && authHeader.slice(0, 7) === "Bearer "
    ? authHeader.slice(7).trim()
    : "";
  return bearerToken || req.ip || "unknown";
}

/**
 * Rate limiter middleware using Redis INCR + EXPIRE.
 * Falls back to allowing all requests if Redis is unavailable.
 */
export function rateLimiter(req, res, next) {
  // Skip for health and webhooks
  if (req.path === "/health" || req.path.startsWith("/webhooks")) {
    return next();
  }

  const identity = deriveLimiterIdentity(req);
  const key = `ratelimit:${identity}`;

  redis
    .incr(key)
    .then((count) => {
      if (count === 1) {
        // First request in window — set TTL
        redis.pexpire(key, WINDOW_MS);
      }

      // Set rate limit headers
      res.setHeader("X-RateLimit-Limit", MAX_REQUESTS);
      res.setHeader("X-RateLimit-Remaining", Math.max(0, MAX_REQUESTS - count));
      res.setHeader("X-RateLimit-Reset", Date.now() + WINDOW_MS);

      if (count > MAX_REQUESTS) {
        res.setHeader("Retry-After", Math.ceil(WINDOW_MS / 1000));
        return res.status(429).json({
          error: "Too many requests",
          retry_after_seconds: Math.ceil(WINDOW_MS / 1000),
        });
      }

      next();
    })
    .catch((err) => {
      // Redis unavailable — allow request but log
      logger.error({ err }, "Rate limiter Redis error — allowing request");
      next();
    });
}
