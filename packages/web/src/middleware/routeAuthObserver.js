// Declaration-driven observe-only route authorization observer (Wave 2 / #94).

import { authorize } from "../services/auth/authorize.js";
import { logDecision } from "../services/auth/decisionLog.js";
import { logger } from "../lib/logger.js";
import {
  resolveRouteResource,
  SUPPORTED_ROUTE_RESOURCE_RESOLVERS,
} from "../services/routeResourceResolver.js";

export { SUPPORTED_ROUTE_RESOURCE_RESOLVERS };
export const resolveResource = resolveRouteResource;

let _routeMap = null;
let _initStarted = false;

async function ensureRouteMap() {
  if (_routeMap) return _routeMap;
  if (_initStarted) return _routeMap;
  _initStarted = true;

  const mod = await import("../services/auth/declarations.js");
  mod.registerAllProtectedSurfaces();
  const { listProtectedSurfaces } = await import("../services/auth/protectedSurfaces.js");

  _routeMap = listProtectedSurfaces()
    .filter((surface) => surface.kind === "route")
    .map((surface) => {
      const parts = surface.id.split(":");
      const pathPattern = parts.slice(2).join(":");
      const paramNames = [];
      const regexStr = pathPattern.replace(
        /:([A-Za-z_$][\w$]*)(?:\(([^)]*)\))?/g,
        (_, name, constraint) => {
          paramNames.push(name);
          return constraint ? `(${constraint})` : "([^/]+)";
        },
      );
      return {
        id: surface.id,
        method: parts[1],
        regex: new RegExp(`^${regexStr}$`),
        paramNames,
        permission: surface.permission,
        resourceType: surface.resourceType,
        resourceResolver: surface.resourceResolver ?? null,
      };
    });
  return _routeMap;
}

/**
 * Record one declaration-driven Wave-2 authorization observation.
 *
 * authorize() records the authoritative decision. When that decision denies,
 * preserve the same legacy-vs-authoritative disagreement evidence that
 * observeAuthorize() records on route-local adoption paths. Mark the request
 * observed only after that evidence is confirmed persisted so route-local
 * observation remains available as a non-fatal fallback if persistence fails.
 */
export async function observeDeclarationAuthorization(req, { permission, resource, surfaceId = null }) {
  const principal = req.auth || null;
  const decision = await authorize({ principal, permission, resource });

  const legacyExpected = true; // request reached this observer through the legacy-authorized path
  const disagreement = legacyExpected && !decision.allowed;
  if (disagreement) {
    const persisted = await logDecision(decision, principal, { legacyExpected, disagreement });
    if (!persisted) {
      logger.warn(
        {
          permission,
          code: decision.code,
          principalId: principal?.principalId ?? null,
          surface: surfaceId,
          resource: resource?.type ?? null,
        },
        "routeAuthObserver: disagreement evidence was not persisted; preserving route-local fallback",
      );
      return decision;
    }
    logger.info(
      {
        permission,
        code: decision.code,
        principalId: principal?.principalId ?? null,
        surface: surfaceId,
        resource: resource?.type ?? null,
      },
      "observe-only: authoritative decision disagrees with legacy behavior",
    );
  }

  req._wave2Observed = true;
  return decision;
}

/** Observe authorization without blocking the request (Wave 2 contract). */
export async function routeAuthObserver(req, res, next) {
  if (
    !req.path.startsWith("/api") ||
    req.path.startsWith("/api/auth") ||
    req.path.startsWith("/api/bootstrap") ||
    req.path.startsWith("/api/setup")
  ) return next();

  let routeMap;
  try {
    routeMap = await ensureRouteMap();
  } catch (err) {
    logger.warn({ err }, "routeAuthObserver: failed to build route map (non-fatal)");
    return next();
  }

  const match = routeMap.find((entry) => entry.method === req.method && entry.regex.test(req.path));
  if (match) {
    const pathMatch = req.path.match(match.regex);
    const params = {};
    if (pathMatch) {
      match.paramNames.forEach((name, index) => {
        params[name] = decodeURIComponent(pathMatch[index + 1]);
      });
    }

    if (!req._wave2Observed) {
      try {
        const resource = await resolveRouteResource(
          match.resourceType,
          params,
          match.resourceResolver,
          req.body ?? {},
        );
        await observeDeclarationAuthorization(req, {
          permission: match.permission,
          resource,
          surfaceId: match.id,
        });
      } catch (err) {
        logger.warn(
          { err, path: req.path, surface: match.id },
          "routeAuthObserver: authorize failed (non-fatal)",
        );
      }
    }
  }

  return next();
}
