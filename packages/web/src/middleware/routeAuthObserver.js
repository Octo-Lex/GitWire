// src/middleware/routeAuthObserver.js
//
// Declaration-driven observe-only route authorization observer (Wave 2 / #94).
//
// Matches each incoming request against the protected-surface registry by
// method + path pattern. For matched surfaces that are NOT already explicitly
// adopted (req._wave2Observed), it:
//   1. resolves the declared permission from the registry (NOT a generic token);
//   2. resolves the declared resource from trusted server-side DB lookup;
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
  const surfaces = listProtectedSurfaces().filter((s) => s.kind === "route");
  _routeMap = surfaces.map((s) => {
    const parts = s.id.split(":");
    const method = parts[1];
    const pathPattern = parts.slice(2).join(":");
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

async function lookupRepositoryByName(owner, repo) {
  const { rows } = await db.query(
    "SELECT github_id, installation_id, owner, name FROM repositories WHERE full_name = $1",
    [`${owner}/${repo}`]
  );
  return rows[0] ?? null;
}

async function lookupRepositoryByRunId(runId) {
  const { rows } = await db.query(
    `SELECT r.github_id, r.installation_id, r.owner, r.name
       FROM ci_runs cr
       JOIN repositories r ON r.github_id = cr.repo_id
      WHERE cr.id = $1`,
    [runId]
  );
  return rows[0] ?? null;
}

/**
 * Resolve the trusted resource for a matched route surface.
 * Request body/query identity fields are never accepted as authority.
 */
export async function resolveResource(resourceType, params) {
  if (resourceType === "repository") {
    let row = null;
    if (params.owner && params.repo) {
      row = await lookupRepositoryByName(params.owner, params.repo);
    } else if (params.runId) {
      row = await lookupRepositoryByRunId(params.runId);
    }

    if (!row) {
      return {
        type: "repository",
        organization: params.owner ?? null,
        repository: params.repo ?? null,
      };
    }
    return {
      type: "repository",
      installationId: row.installation_id,
      repositoryId: row.github_id,
      organization: row.owner,
      repository: row.name,
    };
  }

  if (resourceType === "installation") {
    if (params.owner && params.repo) {
      const row = await lookupRepositoryByName(params.owner, params.repo);
      if (row) {
        return {
          type: "installation",
          installationId: row.installation_id,
          organization: row.owner,
          repository: row.name,
        };
      }
    }
    return { type: "installation" };
  }

  if (resourceType === "fleet") {
    return { type: "fleet" };
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
 * a declaration and hasn't been explicitly observed. Does NOT block.
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

  let routeMap;
  try {
    routeMap = await ensureRouteMap();
  } catch (err) {
    logger.warn({ err }, "routeAuthObserver: failed to build route map (non-fatal)");
    return next();
  }

  const match = routeMap.find(
    (r) => r.method === req.method && r.regex.test(req.path)
  );

  if (match) {
    const m = req.path.match(match.regex);
    const params = {};
    if (m) {
      match.paramNames.forEach((name, i) => {
        params[name] = decodeURIComponent(m[i + 1]);
      });
    }

    if (!req._wave2Observed) {
      try {
        const resource = await resolveResource(match.resourceType, params);
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
