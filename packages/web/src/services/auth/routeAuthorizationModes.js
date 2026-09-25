// Source-derived authorization-mode classification for protected HTTP routes.
// D0-04 keeps this separate from the declaration inventory so runtime behavior
// can be checked against the handlers that actually enforce authorization.

export const RouteAuthorizationMode = Object.freeze({
  OBSERVE: "observe",
  ENFORCED: "enforced",
});

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
