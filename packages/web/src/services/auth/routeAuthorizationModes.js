// Source-derived authorization-mode classification for protected HTTP routes.
// D0-04 keeps the source-derived route list separate from the declaration
// inventory. W1-02 reuses the central authorization mode vocabulary so route
// classification cannot drift from runtime control semantics.

import { AuthorizationMode } from "./authorizationMode.js";

export const RouteAuthorizationMode = AuthorizationMode;

export const ENFORCED_ROUTE_SURFACE_IDS = Object.freeze([
  "route:POST:/api/triage/failures/:jobId/disposition",
  "route:POST:/api/triage/failures/:jobId/retry",
]);

const ENFORCED_ROUTE_SURFACE_SET = new Set(ENFORCED_ROUTE_SURFACE_IDS);

export function routeAuthorizationMode(surfaceId) {
  return ENFORCED_ROUTE_SURFACE_SET.has(surfaceId)
    ? RouteAuthorizationMode.ENFORCED
    : RouteAuthorizationMode.OBSERVE;
}
