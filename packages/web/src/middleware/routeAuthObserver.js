// src/middleware/routeAuthObserver.js
//
// Declaration-driven observe-only route authorization observer (Wave 2 / #94).
//
// Matches each incoming request against the protected-surface registry by
// method + path pattern. For matched surfaces that are NOT already explicitly
// adopted (req._wave2Observed), it resolves permission/resource from trusted
// server-side state, calls authorize(), and records observe-only evidence.

import { authorize } from "../services/auth/authorize.js";
import { db } from "../lib/db.js";
import { logger } from "../lib/logger.js";
import { resolveStoredCIRunIdentifier } from "../services/ciRunResolver.js";

let _routeMap = null;
let _initStarted = false;

async function ensureRouteMap() {
  if (_routeMap) return _routeMap;
  if (_initStarted) return _routeMap;
  _initStarted = true;

  const mod = await import("../services/auth/declarations.js");
  mod.registerAllProtectedSurfaces();
  const { listProtectedSurfaces } = await import("../services/auth/protectedSurfaces.js");

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
      resourceResolver: s.resourceResolver ?? null,
    };
  });
  return _routeMap;
}

async function lookupRepositoryByFullName(fullName) {
  if (typeof fullName !== "string" || !fullName.includes("/")) return null;

  const { rows } = await db.query(
    `SELECT r.github_id, r.installation_id, r.owner, r.name
       FROM repositories r
       JOIN installations i
         ON i.github_id = r.installation_id
        AND i.deleted_at IS NULL
      WHERE r.full_name = $1
        AND r.deleted_at IS NULL
      LIMIT 2`,
    [fullName]
  );
  return rows.length === 1 ? rows[0] : null;
}

async function lookupRepositoryByName(owner, repo) {
  // Resource ambiguity must never be resolved by row order. This keeps route
  // authorization aligned with the D0-02 issue-fix admission semantics and is
  // also safer for every other owner/repo protected route.
  return lookupRepositoryByFullName(`${owner}/${repo}`);
}

async function lookupRepositoryByActionId(actionId) {
  // Match src/routes/actions.js exactly: its lifecycle handlers use parseInt()
  // without a radix. Observe-only authorization must bind the same action ID
  // the handler will mutate, including noncanonical parseInt-valid strings.
  const numericId = parseInt(actionId);
  if (!Number.isSafeInteger(numericId) || numericId <= 0) return null;

  const { rows } = await db.query(
    `SELECT r.github_id, r.installation_id, r.owner, r.name
       FROM managed_actions a
       JOIN repositories r
         ON r.github_id = a.repo_id
       JOIN installations i
         ON i.github_id = r.installation_id
        AND i.deleted_at IS NULL
      WHERE a.id = $1
        AND r.deleted_at IS NULL
      LIMIT 2`,
    [numericId]
  );
  return rows.length === 1 ? rows[0] : null;
}

async function lookupRepositoryByWaiverId(waiverId) {
  // Match src/routes/waivers.js exactly: revokeWaiver receives
  // parseInt(req.params.id, 10).
  const numericId = parseInt(waiverId, 10);
  if (!Number.isSafeInteger(numericId) || numericId <= 0) return null;

  const { rows } = await db.query(
    `SELECT r.github_id, r.installation_id, r.owner, r.name
       FROM policy_waivers w
       JOIN repositories r
         ON r.github_id = w.repo_id
       JOIN installations i
         ON i.github_id = r.installation_id
        AND i.deleted_at IS NULL
      WHERE w.id = $1
        AND r.deleted_at IS NULL
      LIMIT 2`,
    [numericId]
  );
  return rows.length === 1 ? rows[0] : null;
}

/** Resolve the trusted resource for a matched route surface. */
export async function resolveResource(resourceType, params, resourceResolver = null, body = {}) {
  if (resourceType === "repository") {
    let row = null;
    if (params.owner && params.repo) {
      row = await lookupRepositoryByName(params.owner, params.repo);
    } else if (params.runId) {
      const resolution = await resolveStoredCIRunIdentifier(params.runId);
      if (resolution.status === "resolved") {
        row = {
          github_id: resolution.run.repo_github_id,
          installation_id: resolution.run.installation_id,
          owner: resolution.run.owner,
          name: resolution.run.name,
        };
      }
    } else if (
      resourceResolver === "action id -> managed_actions -> repository" &&
      params.id
    ) {
      row = await lookupRepositoryByActionId(params.id);
    } else if (
      resourceResolver === "body.repo -> repositories" &&
      body?.repo
    ) {
      row = await lookupRepositoryByFullName(body.repo);
    } else if (
      resourceResolver === "waiver id -> waivers.repo_id -> repositories" &&
      params.id
    ) {
      row = await lookupRepositoryByWaiverId(params.id);
    }

    if (!row) {
      return {
        type: "repository",
        organization: params.owner ?? null,
        repository: params.repo ?? body?.repo ?? null,
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

  if (resourceType === "fleet") return { type: "fleet" };
  if (resourceType === "policy_rollout_plan" && params.id) {
    return { type: "policy_rollout_plan", resourceId: params.id };
  }
  if (resourceType === "policy_definition") return { type: "policy_definition" };
  return { type: resourceType || "unknown" };
}

/**
 * Declaration-driven observe-only route authorization observer.
 * Runs BEFORE the route handler. Calls authorize() once if the route matches
 * a declaration and hasn't been explicitly observed. Does NOT block.
 */
export async function routeAuthObserver(req, res, next) {
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
        const resource = await resolveResource(
          match.resourceType,
          params,
          match.resourceResolver,
          req.body ?? {},
        );
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
