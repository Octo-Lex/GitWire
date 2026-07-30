// src/middleware/authContext.js
//
// Principal-hydrating auth middleware (Wave 2 / issue #94).
//
// This is the SINGLE HTTP middleware that resolves a server-owned principal
// onto `req.auth` for every request. It replaces the legacy binary
// apiKeyAuth gate with a principal-aware resolver that converges on the
// runtime identity layer (session / credential / legacy-key).
//
// Observe-only behavior (issue #94): this middleware resolves req.auth and
// records the decision, but does NOT globally block legacy-authorized
// production paths in Wave 2. A request that fails to resolve a Wave 2
// principal still proceeds (so existing API-key-authenticated behavior is
// not broken), with req.auth set to an unauthenticated sentinel + a
// structured observe-only decision recorded. Enforcement is a later wave.
//
// Anonymous paths (/health, /webhooks, /api/auth/*) are skipped entirely —
// they have no req.auth.

import { logger } from "../lib/logger.js";
import { unauthenticatedContext } from "../services/auth/context.js";
import { resolveSession } from "../services/auth/sessionResolver.js";
import { resolveCredential } from "../services/auth/credentialResolver.js";
import { resolveLegacyKey } from "../services/auth/legacyKeyAdapter.js";

const APP_AUDIENCE = "gitwire-app";

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

/**
 * Resolve req.auth for an incoming request. Observe-only: never blocks.
 *
 * Resolution order:
 *   1. Bearer credential (api_key transport) — service/legacy-key principals
 *   2. gitwire-session cookie (session transport) — user principals
 *   3. unauthenticated sentinel (legacy shared-key still proceeds via the
 *      observe-only fallback; the decision is recorded as unauthenticated
 *      against the Wave 2 model, surfacing the disagreement for review)
 */
export async function authContext(req, res, next) {
  // Anonymous paths — no principal resolution.
  if (
    req.path === "/health" ||
    req.path.startsWith("/webhooks") ||
    req.path.startsWith("/api/auth")
  ) {
    req.auth = null;
    return next();
  }

  try {
    // 1. Bearer credential
    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith("Bearer ")) {
      const presented = authHeader.slice(7).trim();
      // Try the Wave 2 credential resolver first (service principals).
      const cred = await resolveCredential(presented, APP_AUDIENCE);
      if (cred.code === "allowed" && cred.context) {
        req.auth = cred.context;
        req.authDecisionCode = "allowed";
        return next();
      }
      // Fall back to the legacy-key adapter (legacy-key principals).
      const legacy = await resolveLegacyKey(presented);
      if (legacy.code === "allowed" && legacy.context) {
        req.auth = legacy.context;
        req.authDecisionCode = "allowed";
        return next();
      }
      // Wave 2 could not resolve a principal from this credential. Observe-only:
      // do NOT block — record the code and proceed with an unauthenticated
      // sentinel so legacy shared-key behavior continues, but the disagreement
      // is observable via req.authDecisionCode + the decision log.
      req.auth = unauthenticatedContext("api_key");
      req.authDecisionCode = legacy.code || cred.code;
      return next();
    }

    // 2. Session cookie
    const cookies = parseCookies(req);
    const sessionToken = cookies["gitwire-session"];
    if (sessionToken) {
      const sess = await resolveSession(sessionToken);
      if (sess.code === "allowed" && sess.context) {
        req.auth = sess.context;
        req.authDecisionCode = "allowed";
        return next();
      }
      req.auth = unauthenticatedContext("session");
      req.authDecisionCode = sess.code;
      return next();
    }

    // 3. No credential presented — unauthenticated (observe-only proceeds).
    req.auth = unauthenticatedContext("unauthenticated");
    req.authDecisionCode = "unauthenticated";
    return next();
  } catch (err) {
    // Resolver errors fail closed for the *decision* (authorization_error) but
    // Wave 2 observe-only does not block the request; the disagreement is
    // recorded. Enforcement (Wave 5) will fail closed on the request itself.
    logger.error({ err, path: req.path }, "authContext: resolver error (observe-only)");
    req.auth = unauthenticatedContext("authorization_error");
    req.authDecisionCode = "authorization_error";
    return next();
  }
}
