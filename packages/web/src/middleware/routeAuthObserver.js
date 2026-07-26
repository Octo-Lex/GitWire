// src/middleware/routeAuthObserver.js
//
// Route-level observe-only authorization observer (Wave 2 / issue #94).
//
// Automatically records observe-only authorization decisions for mutation
// routes that are not already explicitly adopted via observeAuthorize().
// This ensures NO protected mutation surface goes unobserved.
//
// Runs as a post-response hook (on res 'finish') to avoid any impact on the
// legacy path. Non-blocking, best-effort. Routes that call observeAuthorize()
// explicitly set req._wave2Observed = true, which this middleware checks.
//
// For explicitly-adopted routes (maintainer, config, rollouts), this is a
// no-op. For all other mutation routes, it records a coarse-grained decision
// with permission 'route:access' so the decision log covers every surface.

import { authorize } from "../services/auth/authorize.js";
import { logger } from "../lib/logger.js";

/**
 * Express middleware that records observe-only decisions for mutation routes
 * not already explicitly adopted. Non-blocking, best-effort.
 */
export function routeAuthObserver(req, res, next) {
  // Skip anonymous paths and non-API routes.
  if (
    !req.path.startsWith("/api") ||
    req.path.startsWith("/api/auth") ||
    req.path.startsWith("/api/bootstrap") ||
    req.path.startsWith("/api/setup")
  ) {
    return next();
  }

  // After the response finishes, record an observe-only decision if the route
  // wasn't already explicitly observed.
  res.on("finish", () => {
    if (req._wave2Observed) return; // explicitly adopted — skip

    // Only observe mutation methods.
    if (!["POST", "PUT", "DELETE", "PATCH"].includes(req.method)) return;

    const principal = req.auth;
    if (!principal || !principal.principalId) return; // unauthenticated

    // Fire-and-forget: record a coarse-grained observe-only decision.
    authorize({
      principal,
      permission: "route:access",
      resource: { type: "route", resourceId: `${req.method}:${req.path}` },
    }).catch((err) => {
      logger.warn({ err, path: req.path }, "routeAuthObserver: observe decision failed (non-fatal)");
    });
  });

  next();
}
