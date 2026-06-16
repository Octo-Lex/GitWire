// src/routes/auth.js
// Dashboard authentication — login/logout with Redis-backed sessions.
//
// POST /api/auth/login   — validate API key, create session, set cookie
// POST /api/auth/logout  — destroy session, clear cookie
// GET  /api/auth/check   — verify session is still valid

import { Router } from "express";
import { redis } from "../lib/queue.js";
import { logger } from "../lib/logger.js";

const router = Router();

// ── Cookie parser utility ──────────────────────────────────────────────────
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

// ── Redis client for sessions (uses existing connection) ───────────────────
const SESSION_PREFIX = "gitwire:session:";
const SESSION_TTL = 7 * 24 * 60 * 60; // 7 days

// ── Resolve allowed API keys ────────────────────────────────────────────────
const apiKeys = new Set();
if (process.env.API_KEY) apiKeys.add(process.env.API_KEY);
if (process.env.API_KEYS) {
  for (const k of process.env.API_KEYS.split(",")) {
    const t = k.trim();
    if (t) apiKeys.add(t);
  }
}

// ── POST /api/auth/login ────────────────────────────────────────────────────
router.post("/login", async (req, res) => {
  try {
    const { password } = req.body || {};

    if (!password || !apiKeys.has(password)) {
      logger.warn({ ip: req.ip }, "Failed login attempt");
      return res.status(401).json({ error: "Invalid password" });
    }

    // Generate session token
    const token = crypto.randomUUID();
    const sessionKey = SESSION_PREFIX + token;

    // Store in Redis
    await redis.setex(sessionKey, SESSION_TTL, JSON.stringify({
      created: new Date().toISOString(),
      ip: req.ip || "unknown",
    }));

    // Set httpOnly cookie — 7 days
    // Secure flag only in production (HTTPS). Local dev uses HTTP.
    const secureFlag = process.env.NODE_ENV === "production" ? "; Secure" : "";
    res.setHeader("Set-Cookie", [
      `gitwire-session=${token}; HttpOnly${secureFlag}; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL}`,
    ]);

    logger.info({ ip: req.ip }, "Dashboard login successful");
    res.json({ ok: true });
  } catch (err) {
    logger.error({ err }, "Login error");
    res.status(500).json({ error: "Login failed" });
  }
});

// ── POST /api/auth/logout ──────────────────────────────────────────────────
router.post("/logout", async (req, res) => {
  try {
    const cookies = parseCookies(req);
    const token = cookies["gitwire-session"];
    if (token) {
      await redis.del(SESSION_PREFIX + token).catch(() => {});
    }

    res.setHeader("Set-Cookie", [
      "gitwire-session=; HttpOnly" + (process.env.NODE_ENV === "production" ? "; Secure" : "") + "; SameSite=Strict; Path=/; Max-Age=0",
    ]);

    res.json({ ok: true });
  } catch (err) {
    logger.error({ err }, "Logout error");
    res.status(500).json({ error: "Logout failed" });
  }
});

// ── GET /api/auth/check ────────────────────────────────────────────────────
router.get("/check", async (req, res) => {
  try {
    const cookies = parseCookies(req);
    const token = cookies["gitwire-session"];
    if (!token) {
      return res.json({ authenticated: false });
    }

    const data = await redis.get(SESSION_PREFIX + token);
    if (!data) {
      return res.json({ authenticated: false });
    }

    res.json({ authenticated: true });
  } catch (err) {
    logger.error({ err }, "Auth check error");
    res.json({ authenticated: false });
  }
});

export default router;
export { SESSION_PREFIX, redis };
