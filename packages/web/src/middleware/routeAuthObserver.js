// src/middleware/routeAuthObserver.js
//
// Declaration-driven observe-only route authorization observer (Wave 2 / #94).
//
// Matches each incoming request against the protected-surface registry by
// method + path pattern. For matched surfaces that are NOT already explicitly
// adopted (req._wave2Observed), it:
//   1. resolves the declared permission from the registry (NOT a generic token);
//   2. resolves the declared resource from trusted server-side DB lookup
//      (installation_id + repository_id from the repositories table by name,
//      NOT from request body/path);
//   3. calls authorize() exactly once with the declared permission + resource;
//   4. records one observe-only evidence row.
//
// Explicitly adopted routes (maintainer, config, rollouts) call observeAuthorize()
// directly with richer context and set req._wave2Observed — this middleware skips
// them to avoid duplicate evidence.
//
// Every protected GET, POST, PATCH, PUT, DELETE surface is classified.

import { authorize } from "../services/auth/authorize.js";
import { db } from "../lib/db.js";
import { logger } from "../lib/logger.js";

// Route pattern → declaration mapping. Built lazily on first request.
let _routeMap = null;
let _initStarted = false;

async function ensureRouteMap() {
  if (_routeMap) return _routeMap;
  if (_initStarted) return _routeMap; // race guard (single-threaded JS)
  _initStarted = true;

  const mod = await import("../services/auth/declarations.js");
  mod.registerAllProtectedSurfaces();
  const { listProtectedSurfaces } = await import("../services/auth/protectedSurfaces.js");

  // Build a lookup of route surfaces by (method, path-pattern).
  // Path patterns like 'route:POST:/api/maintainer/:owner/:repo/collaborators'
  // are parsed into a matcher.
  const surfaces = listProtectedSurfaces().filter((s) => s.kind === "route");
  _routeMap = surfaces.map((s) => {
    // Parse the surface id: 'route:METHOD:/api/path/:param'
    const parts = s.id.split(":");
    const method = parts[1];
    const pathPattern = parts.slice(2).join(":");
    // Convert Express-style :param to a regex + param-name list
    const paramNames = [];
    const regexStr = pathPattern.replace(/:([^/]+)/g, (_, name) => {
      paramNames.push(name);
      return "([^/]+)";
    });
    return {
      id: s.id,
      method,
      regex: new RegExp(`^${regexStr}$`),
      paramNames,
      permission: s.permission,
      resourceType: s.resourceType,
    };
  });
  return _routeMap;
}

/**
 * Resolve the trusted resource for a matched route surface.
 * Uses server-side DB lookup by owner/repo name — NEVER trusts request body
 * for installation_id/repository_id.
 */
async function resolveResource(resourceType, params) {
  if (resourceType === "repository" && params.owner && params.repo) {
    const { rows } = await db.query(
      "SELECT github_id, installation_id FROM repositories WHERE full_name = $1",
      [`${params.owner}/${params.repo}`]
    );
    if (rows.length === 0) return { type: "repository", organization: params.owner, repository: params.repo };
    return {
      type: "repository",
      installationId: rows[0].installation_id,
      repositoryId: rows[0].github_id,
      organization: params.owner,
      repository: params.repo,
    };
  }
  if (resourceType === "installation") {
    return { type: "installation" };
  }
  if (resourceType === "policy_rollout_plan" && params.id) {
    return { type: "policy_rollout_plan", resourceId: params.id };
  }
  if (resourceType === "policy_definition") {
    return { type: "policy_definition" };
  }
  return { type: resourceType || "unknown" };
}

/**
 * Declaration-driven observe-only route authorization observer.
 * Runs BEFORE the route handler. Calls authorize() once if the route matches
 * a declaration and hasn't been explicitly observed. Does NOT block (observe-
 * only).
 */
export async function routeAuthObserver(req, res, next) {
  // Skip anonymous paths.
  if (
    !req.path.startsWith("/api") ||
    req.path.startsWith("/api/auth") ||
    req.path.startsWith("/api/bootstrap") ||
    req.path.startsWith("/api/setup")
  ) {
    return next();
  }

  // Ensure the route map is built.
  let routeMap;
  try {
    routeMap = await ensureRouteMap();
  } catch (err) {
    logger.warn({ err }, "routeAuthObserver: failed to build route map (non-fatal)");
    return next();
  }

  // Match the request against declared route surfaces.
  const match = routeMap.find(
    (r) => r.method === req.method && r.regex.test(req.path)
  );

  if (match) {
    // Extract path params from the regex match.
    const m = req.path.match(match.regex);
    const params = {};
    if (m) {
      match.paramNames.forEach((name, i) => {
        params[name] = decodeURIComponent(m[i + 1]);
      });
    }

    // If already explicitly observed, skip (no double-record).
    if (!req._wave2Observed) {
      try {
        const resource = await resolveResource(match.resourceType, params);
        // Call authorize() once with the DECLARED permission (not generic).
        // Observe-only: record the decision, do not block.
        await authorize({
          principal: req.auth || null,
          permission: match.permission,
          resource,
        });
        req._wave2Observed = true;
      } catch (err) {
        logger.warn({ err, path: req.path, surface: match.id }, "routeAuthObserver: authorize failed (non-fatal)");
      }
    }
  }

  return next();
}
