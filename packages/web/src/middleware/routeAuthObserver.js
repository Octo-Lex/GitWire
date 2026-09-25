// Declaration-driven observe-only route authorization observer (Wave 2 / #94).

import * as authorization from "../services/auth/authorize.js";
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

async function authorizeForObservation(opts) {
  if (typeof authorization.authorizeWithPersistence === "function") {
    return authorization.authorizeWithPersistence(opts);
  }

  // Compatibility for focused unit tests that intentionally provide the
  // established authorize()-only module mock. Production always exports the
  // persistence-aware interface; an authorize-only fallback is conservatively
  // treated as unpersisted so it can never suppress route-local observation.
  const decision = await authorization.authorize(opts);
  return { decision, persisted: false };
}

/**
 * Record one declaration-driven Wave-2 authorization observation.
 *
 * The declaration seam suppresses a later route-local observation only after
 * its base decision evidence (and disagreement evidence on deny) is confirmed
 * persisted. Otherwise the request stays unmarked so the existing route-local
 * observe-only path remains available as a non-fatal fallback.
 */
export async function observeDeclarationAuthorization(req, { permission, resource, surfaceId = null }) {
  const principal = req.auth || null;
  const { decision, persisted: basePersisted } = await authorizeForObservation({
    principal,
    permission,
    resource,
  });

  if (!basePersisted) {
    logger.warn(
      {
        permission,
        code: decision.code,
        principalId: principal?.principalId ?? null,
        surface: surfaceId,
        resource: resource?.type ?? null,
      },
      "routeAuthObserver: base decision evidence was not persisted; preserving route-local fallback",
    );
    return decision;
  }

  const legacyExpected = true; // request reached this observer through the legacy-authorized path
  const disagreement = legacyExpected && !decision.allowed;
  if (disagreement) {
    const disagreementPersisted = await logDecision(decision, principal, { legacyExpected, disagreement });
    if (!disagreementPersisted) {
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

  // Cache the declaration-driven result so explicitly adopted route handlers
  // can reuse it instead of recording a second decision for the same surface.
  req._wave2Observed = true;
  req._wave2DeclarationObserved = true;
  req._wave2DeclarationDecision = decision;
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
