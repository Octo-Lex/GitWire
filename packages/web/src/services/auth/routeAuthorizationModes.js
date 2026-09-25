// Source-derived authorization-mode classification for protected HTTP routes.
// D0-04 keeps the source-derived route list separate from the declaration
// inventory. W1-02 reuses the central authorization mode vocabulary so route
// classification cannot drift from runtime control semantics.
//
// W1-03 separates authorization mode from enforcement ownership. The two
// triage mutations remain handler-enforced; the exact high-authority HTTP
// cutover set is enforced centrally by routeAuthObserver.

import { AuthorizationMode } from "./authorizationMode.js";

export const RouteAuthorizationMode = AuthorizationMode;

export const HANDLER_ENFORCED_ROUTE_SURFACE_IDS = Object.freeze([
  "route:POST:/api/triage/failures/:jobId/disposition",
  "route:POST:/api/triage/failures/:jobId/retry",
]);

export const CENTRALLY_ENFORCED_ROUTE_SURFACE_IDS = Object.freeze([
  "route:PUT:/api/maintainer/collaborators/:owner/:repo/:login",
  "route:DELETE:/api/maintainer/collaborators/:owner/:repo/:login",
  "route:PUT:/api/maintainer/branch-rules/:owner/:repo/:pattern",
  "route:PATCH:/api/maintainer/:owner/:repo/settings",
  "route:POST:/api/waivers",
  "route:DELETE:/api/waivers/:id",
  "route:POST:/api/enforcement/policies",
  "route:PUT:/api/enforcement/policies/:id",
  "route:DELETE:/api/enforcement/policies/:id",
  "route:POST:/api/enforcement/violations/:id/suppress",
  "route:POST:/api/enforcement/run",
  "route:POST:/api/gates/:owner/:repo",
  "route:DELETE:/api/gates/:owner/:repo/:name",
  "route:POST:/api/gates/:owner/:repo/evaluate",
  "route:POST:/api/phase2/queue/:owner/:repo/config",
  "route:POST:/api/phase2/queue/:owner/:repo/:pr/admit",
  "route:POST:/api/phase2/queue/:owner/:repo/:pr/remove",
  "route:POST:/api/phase2/feedback",
  "route:PUT:/api/phase2/feedback/:id",
  "route:DELETE:/api/phase2/feedback/:id",
  "route:POST:/api/phase3/flaky/:id/graduate",
  "route:POST:/api/phase3/flaky/:id/dismiss",
  "route:POST:/api/phase3/reconciler/run",
  "route:PUT:/api/phase3/reconciler/repos/:owner/:repo",
  "route:POST:/api/phase3/dependencies/:owner/:repo/scan",
  "route:POST:/api/phase3/dependencies/:owner/:repo/batch-pr",
  "route:POST:/api/phase3/dependencies/vuln/:id/dismiss",
]);

export const ENFORCED_ROUTE_SURFACE_IDS = Object.freeze([
  ...HANDLER_ENFORCED_ROUTE_SURFACE_IDS,
  ...CENTRALLY_ENFORCED_ROUTE_SURFACE_IDS,
]);

const HANDLER_ENFORCED_ROUTE_SURFACE_SET = new Set(HANDLER_ENFORCED_ROUTE_SURFACE_IDS);
const CENTRALLY_ENFORCED_ROUTE_SURFACE_SET = new Set(CENTRALLY_ENFORCED_ROUTE_SURFACE_IDS);
const ENFORCED_ROUTE_SURFACE_SET = new Set(ENFORCED_ROUTE_SURFACE_IDS);

export function isHandlerEnforcedRouteSurface(surfaceId) {
  return HANDLER_ENFORCED_ROUTE_SURFACE_SET.has(surfaceId);
}

export function isCentrallyEnforcedRouteSurface(surfaceId) {
  return CENTRALLY_ENFORCED_ROUTE_SURFACE_SET.has(surfaceId);
}

export function routeAuthorizationMode(surfaceId) {
  return ENFORCED_ROUTE_SURFACE_SET.has(surfaceId)
    ? RouteAuthorizationMode.ENFORCED
    : RouteAuthorizationMode.OBSERVE;
}
