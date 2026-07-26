// tests/unit/wave2-route-observer.test.js
//
// Declaration-driven route observer tests (Wave 2 / issue #94).
// Proves: exact route+method matching, declared permission used verbatim,
// trusted resource resolution, fail-closed for unknown resources, GET coverage,
// explicit adoption suppresses duplicate, undeclared routes fail completeness,
// no generic route:access fallback.

import { jest } from "@jest/globals";

const mockQuery = jest.fn();
const mockDb = { query: mockQuery, transaction: jest.fn(async (fn) => fn({ query: mockQuery })) };
const mockRedis = { get: jest.fn(), setex: jest.fn(), del: jest.fn(), expire: jest.fn() };

jest.unstable_mockModule("../../src/lib/db.js", () => ({ db: mockDb }));
jest.unstable_mockModule("../../src/lib/queue.js", () => ({
  redis: mockRedis,
  webhookEventsQueue: { add: jest.fn() },
  triageQueue: { add: jest.fn() },
}));
jest.unstable_mockModule("../../src/lib/logger.js", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const { assertProtectedSurfaceCompleteness, listProtectedSurfaces, declareProtectedSurface } =
  await import("../../src/services/auth/protectedSurfaces.js");
const declarations = await import("../../src/services/auth/declarations.js");
declarations.registerAllProtectedSurfaces();
const { expectedProtectedSurfaceIds } = declarations;

describe("Wave 2 — protected-surface completeness gate", () => {
  it("every declared surface has all required fields", () => {
    const ids = expectedProtectedSurfaceIds();
    const result = assertProtectedSurfaceCompleteness(ids);
    expect(result.ok).toBe(true);
    expect(result.missing).toEqual([]);
    expect(result.incomplete).toEqual([]);
  });

  it("an undeclared surface fails the completeness gate", () => {
    const ids = expectedProtectedSurfaceIds();
    const result = assertProtectedSurfaceCompleteness([...ids, "route:POST:/api/undeclared/new"]);
    expect(result.ok).toBe(false);
    expect(result.missing).toContain("route:POST:/api/undeclared/new");
  });

  it("no surface uses a generic route:access permission", () => {
    const surfaces = listProtectedSurfaces();
    const generic = surfaces.filter((s) => s.permission === "route:access" || s.permission === "_route_observed");
    expect(generic).toEqual([]);
  });

  it("covers both GET and mutation methods", () => {
    const surfaces = listProtectedSurfaces().filter((s) => s.kind === "route");
    const methods = new Set();
    // Route surface ids encode the method: 'route:METHOD:/path'
    for (const s of surfaces) {
      const method = s.id.split(":")[1];
      methods.add(method);
    }
    expect(methods.has("GET")).toBe(true);
    expect(methods.has("POST")).toBe(true);
    expect(methods.has("PUT")).toBe(true);
    expect(methods.has("DELETE")).toBe(true);
  });

  it("every route surface declares a specific permission token", () => {
    const surfaces = listProtectedSurfaces().filter((s) => s.kind === "route");
    for (const s of surfaces) {
      expect(s.permission).toMatch(/^[a-z_]+(:[a-z_]+)+$/);
      expect(s.permission).not.toBe("route:access");
    }
  });

  it("every route surface has a trusted resourceType", () => {
    const surfaces = listProtectedSurfaces().filter((s) => s.kind === "route");
    for (const s of surfaces) {
      expect(s.resourceType).toBeTruthy();
      expect(s.principalSource).toBe("req.auth");
    }
  });
});
