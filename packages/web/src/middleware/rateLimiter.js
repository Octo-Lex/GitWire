// src/middleware/rateLimiter.js
// Simple sliding-window rate limiter backed by Redis.
// Limits API requests per IP (or per API key when available).

import { redis } from "../lib/queue.js";
import { logger } from "../lib/logger.js";

const WINDOW_MS = 60_000;   // 1 minute window
const MAX_REQUESTS = 120;   // 120 req/min per identity (~2 req/sec)

/**
 * Rate limiter middleware using Redis INCR + EXPIRE.
 * Falls back to allowing all requests if Redis is unavailable.
 */
export function rateLimiter(req, res, next) {
  // Skip for health and webhooks
  if (req.path === "/health" || req.path.startsWith("/webhooks")) {
    return next();
  }

  // Identity: a properly formed Bearer token, else the request IP. The
  // recognition is EXACTLY apiKeyAuth's ("Bearer " prefix, case-sensitive,
  // single space): anything looser re-opens the rotation bypass (e.g.
  // "Bearer\t<rotating>" or "bearer <rotating>" are NOT Bearer for auth,
  // so they must not mint limiter buckets either). Reproduced end-to-end
  // in rate-limiter-behavior.test.js; remediation pinned in
  // rate-limiter-identity.test.js.
  //
  // PRE-AUTHENTICATION ENDPOINTS are the exception: the limiter runs before
  // authentication, so a syntactically valid Bearer token has NOT been
  // validated at this point. On endpoints that authenticate by OTHER means
  // (the login route validates the request-body password), an
  // unauthenticated caller can rotate random Bearer values to mint a fresh
  // bucket per password-guess. Those endpoints always key on the request
  // IP — an unverified token must never become their throttle identity.
  const PRE_AUTH_IP_IDENTITY_PATHS = ["/api/auth/login"];
  const useIpIdentity = PRE_AUTH_IP_IDENTITY_PATHS.includes(req.path);

  const authHeader = req.headers.authorization;
  const bearerToken = !useIpIdentity && typeof authHeader === "string" && authHeader.startsWith("Bearer ")
    ? authHeader.slice(7).trim()
    : "";
  const identity = bearerToken || req.ip || "unknown";

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
