// D0-04: source-verified authorization modes prevent already-enforced routes
// from being misclassified as observe-only disagreements.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { jest } from "@jest/globals";

const mockAuthorize = jest.fn();
const mockAuthorizeWithPersistence = jest.fn();
const mockResolveRouteResource = jest.fn();

jest.unstable_mockModule("../../src/services/auth/authorize.js", () => ({
  authorize: mockAuthorize,
  authorizeWithPersistence: mockAuthorizeWithPersistence,
}));
jest.unstable_mockModule("../../src/services/routeResourceResolver.js", () => ({
  resolveRouteResource: mockResolveRouteResource,
  SUPPORTED_ROUTE_RESOURCE_RESOLVERS: Object.freeze([]),
}));
jest.unstable_mockModule("../../src/services/auth/decisionLog.js", () => ({
  logDecision: jest.fn(),
}));
jest.unstable_mockModule("../../src/lib/logger.js", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const {
  ENFORCED_ROUTE_SURFACE_IDS,
  RouteAuthorizationMode,
  routeAuthorizationMode,
} = await import("../../src/services/auth/routeAuthorizationModes.js");
const { routeAuthObserver } = await import("../../src/middleware/routeAuthObserver.js");
const { registerAllProtectedSurfaces } = await import("../../src/services/auth/declarations.js");
const { getProtectedSurface } = await import("../../src/services/auth/protectedSurfaces.js");

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.resolve(TEST_DIR, "../..");

function directEnforcedTriageSurfaceIds() {
  const source = fs.readFileSync(path.join(WEB_ROOT, "src/routes/triageOperations.js"), "utf8");
  const starts = [...source.matchAll(/triageOperationsRouter\.(post|put|patch|delete)\(\s*"([^"]+)"/g)];
  const ids = [];
  for (let index = 0; index < starts.length; index += 1) {
    const current = starts[index];
    const end = index + 1 < starts.length ? starts[index + 1].index : source.length;
    const segment = source.slice(current.index, end);
    if (/await\s+authorize\s*\(\s*\{/.test(segment) && /res\.status\(403\)/.test(segment)) {
      ids.push(`route:${current[1].toUpperCase()}:/api/triage${current[2]}`);
    }
  }
  return ids.sort();
}

describe("D0-04 route authorization mode", () => {
  beforeAll(() => {
    registerAllProtectedSurfaces();
  });

  beforeEach(() => {
    mockAuthorize.mockReset();
    mockAuthorizeWithPersistence.mockReset();
    mockResolveRouteResource.mockReset();
  });

  test("source-derived route-local enforcement exactly matches the enforced inventory", () => {
    expect(directEnforcedTriageSurfaceIds()).toEqual([...ENFORCED_ROUTE_SURFACE_IDS].sort());
  });

  test("protected triage declarations expose enforced authorization mode", () => {
    for (const surfaceId of ENFORCED_ROUTE_SURFACE_IDS) {
      expect(routeAuthorizationMode(surfaceId)).toBe(RouteAuthorizationMode.ENFORCED);
      expect(getProtectedSurface(surfaceId)).toMatchObject({
        id: surfaceId,
        authorizationMode: RouteAuthorizationMode.ENFORCED,
      });
    }
    expect(routeAuthorizationMode("route:POST:/api/actions/:id/retry"))
      .toBe(RouteAuthorizationMode.OBSERVE);
  });

  test("declaration observer defers to an enforced triage handler without recording disagreement evidence", async () => {
    const req = {
      path: "/api/triage/failures/job-42/retry",
      method: "POST",
      auth: { principalId: "principal-1", authenticationMethod: "api_key" },
      body: { reason: "retry" },
    };
    const next = jest.fn();

    await routeAuthObserver(req, {}, next);

    expect(mockResolveRouteResource).not.toHaveBeenCalled();
    expect(mockAuthorizeWithPersistence).not.toHaveBeenCalled();
    expect(mockAuthorize).not.toHaveBeenCalled();
    expect(req._wave2Observed).toBeUndefined();
    expect(next).toHaveBeenCalledTimes(1);
  });
});
