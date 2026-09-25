// W1-03: exact high-authority HTTP route cutover classification.

import {
  CENTRALLY_ENFORCED_ROUTE_SURFACE_IDS,
  ENFORCED_ROUTE_SURFACE_IDS,
  HANDLER_ENFORCED_ROUTE_SURFACE_IDS,
  RouteAuthorizationMode,
  isCentrallyEnforcedRouteSurface,
  isHandlerEnforcedRouteSurface,
  routeAuthorizationMode,
} from "../../src/services/auth/routeAuthorizationModes.js";
import { registerAllProtectedSurfaces } from "../../src/services/auth/declarations.js";
import { getProtectedSurface, listProtectedSurfaces } from "../../src/services/auth/protectedSurfaces.js";

const EXPECTED_CENTRAL = Object.freeze([
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

const EXPECTED_HANDLER = Object.freeze([
  "route:POST:/api/triage/failures/:jobId/disposition",
  "route:POST:/api/triage/failures/:jobId/retry",
]);

describe("W1-03 high-authority route classification", () => {
  beforeAll(() => {
    registerAllProtectedSurfaces();
  });

  test("central enforcement is exactly the independently frozen 27-route set", () => {
    expect(CENTRALLY_ENFORCED_ROUTE_SURFACE_IDS).toEqual(EXPECTED_CENTRAL);
    expect(CENTRALLY_ENFORCED_ROUTE_SURFACE_IDS).toHaveLength(27);
    expect(new Set(CENTRALLY_ENFORCED_ROUTE_SURFACE_IDS).size).toBe(27);
  });

  test("handler enforcement remains exactly the two triage mutations", () => {
    expect(HANDLER_ENFORCED_ROUTE_SURFACE_IDS).toEqual(EXPECTED_HANDLER);
    expect(HANDLER_ENFORCED_ROUTE_SURFACE_IDS).toHaveLength(2);
  });

  test("the enforced union is disjoint, complete, and reports canonical enforced mode", () => {
    const expectedUnion = [...EXPECTED_HANDLER, ...EXPECTED_CENTRAL];
    expect(ENFORCED_ROUTE_SURFACE_IDS).toEqual(expectedUnion);
    expect(new Set(ENFORCED_ROUTE_SURFACE_IDS).size).toBe(29);

    for (const id of EXPECTED_HANDLER) {
      expect(isHandlerEnforcedRouteSurface(id)).toBe(true);
      expect(isCentrallyEnforcedRouteSurface(id)).toBe(false);
    }
    for (const id of EXPECTED_CENTRAL) {
      expect(isCentrallyEnforcedRouteSurface(id)).toBe(true);
      expect(isHandlerEnforcedRouteSurface(id)).toBe(false);
    }
    for (const id of expectedUnion) {
      expect(routeAuthorizationMode(id)).toBe(RouteAuthorizationMode.ENFORCED);
      expect(getProtectedSurface(id)).toMatchObject({
        id,
        authorizationMode: RouteAuthorizationMode.ENFORCED,
      });
    }
  });

  test("every other protected HTTP declaration remains observe-only", () => {
    const enforced = new Set(ENFORCED_ROUTE_SURFACE_IDS);
    const remainingRoutes = listProtectedSurfaces()
      .filter((surface) => surface.kind === "route" && !enforced.has(surface.id));

    expect(remainingRoutes.length).toBeGreaterThan(0);
    for (const surface of remainingRoutes) {
      expect(surface.authorizationMode).toBe(RouteAuthorizationMode.OBSERVE);
      expect(routeAuthorizationMode(surface.id)).toBe(RouteAuthorizationMode.OBSERVE);
    }
  });
});
