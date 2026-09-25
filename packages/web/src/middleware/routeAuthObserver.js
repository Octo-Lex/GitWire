// Declaration-driven route authorization observer / W1-03 enforcement seam.

import * as authorization from "../services/auth/authorize.js";
import { logDecision } from "../services/auth/decisionLog.js";
import { createAuthorityContext } from "../services/auth/context.js";
import { logger } from "../lib/logger.js";
import {
  resolveRouteResource,
  SUPPORTED_ROUTE_RESOURCE_RESOLVERS,
} from "../services/routeResourceResolver.js";
import {
  CENTRALLY_ENFORCED_ROUTE_SURFACE_IDS,
  RouteAuthorizationMode,
  isCentrallyEnforcedRouteSurface,
  isHandlerEnforcedRouteSurface,
} from "../services/auth/routeAuthorizationModes.js";

export { SUPPORTED_ROUTE_RESOURCE_RESOLVERS };
export const resolveResource = resolveRouteResource;

let _routeMap = null;
let _initStarted = false;

function compileRouteSurfaceId(surfaceId) {
  const parts = surfaceId.split(":");
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
    id: surfaceId,
    method: parts[1],
    // Express 4 defaults to case-insensitive, non-strict routing, so a
    // declaration must observe/enforce the same case and trailing-slash forms.
    regex: new RegExp(`^${regexStr}/?$`, "i"),
    paramNames,
  };
}

const CENTRAL_ROUTE_MATCHERS = CENTRALLY_ENFORCED_ROUTE_SURFACE_IDS.map(compileRouteSurfaceId);

function isCentrallyEnforcedRequest(req) {
  return CENTRAL_ROUTE_MATCHERS.some(
    (entry) => entry.method === req.method && entry.regex.test(req.path),
  );
}

function authorizationUnavailable(res) {
  return res.status(503).json({ error: "Authorization unavailable" });
}

async function ensureRouteMap() {
  if (_routeMap) return _routeMap;
  if (_initStarted) return _routeMap;
  _initStarted = true;

  const mod = await import("../services/auth/declarations.js");
  mod.registerAllProtectedSurfaces();
  const { listProtectedSurfaces } = await import("../services/auth/protectedSurfaces.js");

  _routeMap = listProtectedSurfaces()
    .filter((surface) => surface.kind === "route")
    .map((surface) => ({
      ...compileRouteSurfaceId(surface.id),
      permission: surface.permission,
      resourceType: surface.resourceType,
      resourceResolver: surface.resourceResolver ?? null,
      authorizationMode: surface.authorizationMode ?? RouteAuthorizationMode.OBSERVE,
    }));
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
 * Record one declaration-driven observe-mode authorization decision.
 *
 * W1-01 additionally binds the already server-resolved principal and resource
 * into req.authority. Evidence persistence still controls observation de-dupe,
 * but does not erase the canonical request authority context.
 */
export async function observeDeclarationAuthorization(req, { permission, resource, surfaceId = null }) {
  const principal = req.auth || null;
  req.authority = createAuthorityContext({
    principal,
    resource,
    surfaceId,
  });

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

  const legacyExpected = true;
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

  req._wave2Observed = true;
  req._wave2DeclarationObserved = true;
  req._wave2DeclarationDecision = decision;
  return decision;
}

/**
 * Execute the W1-03 central gate. An allowed policy decision is not sufficient
 * to reach the mutation handler unless its enforced decision evidence was also
 * durably persisted.
 */
export async function enforceDeclarationAuthorization(req, { permission, resource, surfaceId }) {
  const principal = req.auth || null;
  req.authority = createAuthorityContext({
    principal,
    resource,
    surfaceId,
  });

  const outcome = await authorization.authorizeControlled({
    principal,
    permission,
    resource,
    mode: RouteAuthorizationMode.ENFORCED,
  });

  if (
    !outcome?.decision ||
    outcome.mode !== RouteAuthorizationMode.ENFORCED ||
    typeof outcome.blocked !== "boolean" ||
    outcome.blocked !== !outcome.decision.allowed
  ) {
    throw new Error("routeAuthObserver: invalid enforced authorization outcome");
  }

  if (!outcome.persisted) {
    logger.warn(
      {
        permission,
        code: outcome.decision.code,
        principalId: principal?.principalId ?? null,
        surface: surfaceId,
        resource: resource?.type ?? null,
      },
      "routeAuthObserver: enforced decision evidence was not persisted; failing closed",
    );
    return { ...outcome, evidenceUnavailable: true };
  }

  // Preserve the established route-local adoption contract. Existing handlers
  // may still call observeAuthorize(); exact permission/resource identity lets
  // them reuse this already-persisted central decision without re-evaluation.
  req._wave2Observed = true;
  req._wave2DeclarationObserved = true;
  req._wave2DeclarationDecision = outcome.decision;
  return outcome;
}

function extractRouteParams(req, match) {
  const pathMatch = req.path.match(match.regex);
  const params = {};
  if (pathMatch) {
    match.paramNames.forEach((name, index) => {
      params[name] = decodeURIComponent(pathMatch[index + 1]);
    });
  }
  return params;
}

/** Declaration-driven route authorization: observe by default, block W1-03. */
export async function routeAuthObserver(req, res, next) {
  const normalizedPath = req.path.toLowerCase();
  if (
    !normalizedPath.startsWith("/api") ||
    normalizedPath.startsWith("/api/auth") ||
    normalizedPath.startsWith("/api/bootstrap") ||
    normalizedPath.startsWith("/api/setup")
  ) return next();

  let routeMap;
  try {
    routeMap = await ensureRouteMap();
    if (!routeMap) throw new Error("routeAuthObserver: route map initialization incomplete");
  } catch (err) {
    if (isCentrallyEnforcedRequest(req)) {
      logger.error({ err, path: req.path }, "routeAuthObserver: failed to build route map for centrally enforced request");
      return authorizationUnavailable(res);
    }
    logger.warn({ err }, "routeAuthObserver: failed to build route map (non-fatal for non-central route)");
    return next();
  }

  const match = routeMap.find((entry) => entry.method === req.method && entry.regex.test(req.path));
  if (!match) {
    if (isCentrallyEnforcedRequest(req)) {
      logger.error(
        { path: req.path, method: req.method },
        "routeAuthObserver: centrally enforced request has no protected declaration; failing closed",
      );
      return authorizationUnavailable(res);
    }
    return next();
  }

  // Handler-owned enforced routes (the two triage mutations) keep their
  // existing local gate and must not be evaluated a second time here.
  if (isHandlerEnforcedRouteSurface(match.id)) {
    return next();
  }

  if (isCentrallyEnforcedRouteSurface(match.id)) {
    try {
      const params = extractRouteParams(req, match);
      const resource = await resolveRouteResource(
        match.resourceType,
        params,
        match.resourceResolver,
        req.body ?? {},
      );
      const outcome = await enforceDeclarationAuthorization(req, {
        permission: match.permission,
        resource,
        surfaceId: match.id,
      });

      if (outcome.evidenceUnavailable) {
        return authorizationUnavailable(res);
      }
      if (outcome.blocked) {
        return res.status(403).json({
          error: "Forbidden",
          code: outcome.decision.code,
        });
      }
      return next();
    } catch (err) {
      logger.error(
        { err, path: req.path, surface: match.id },
        "routeAuthObserver: central enforcement failed closed",
      );
      return authorizationUnavailable(res);
    }
  }

  // Observe-only declarations retain their historical non-blocking behavior.
  if (!req._wave2Observed) {
    try {
      const params = extractRouteParams(req, match);
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

  return next();
}
