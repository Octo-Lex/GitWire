// tests/unit/d0-04-protected-surface-completeness.test.js
// D0-04 regression: completeness must be derived independently from actual
// consequential mutation sources, not from the declaration arrays themselves.

import { describe, expect, it, beforeAll } from "@jest/globals";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  CONSEQUENTIAL_SURFACE_MANIFEST,
  SOURCE_DERIVED_ROUTE_MODULES,
  expectedConsequentialSurfaceIds,
} from "../../src/services/auth/consequentialSurfaceManifest.js";
import {
  expectedProtectedSurfaceIds,
  registerAllProtectedSurfaces,
} from "../../src/services/auth/declarations.js";
import {
  assertProtectedSurfaceCompleteness,
  getProtectedSurface,
} from "../../src/services/auth/protectedSurfaces.js";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.resolve(TEST_DIR, "../..");

function joinRoute(mountPath, routePath) {
  return routePath === "/" ? mountPath : mountPath + routePath;
}

function normalizeSourceRoutePath(routePath) {
  // Express regex params are written with escaped backslashes in JS source.
  // The manifest stores the runtime route string, so collapse source escapes.
  return routePath.replaceAll("\\\\", "\\");
}

function extractMutationRouteIds({ sourcePath, mountPath }) {
  const source = fs.readFileSync(path.join(WEB_ROOT, sourcePath), "utf8");
  const ids = [];
  const pattern = /\b(?:router|[A-Za-z0-9_]+Router)\.(post|put|patch|delete)\(\s*"([^"]+)"/g;
  let match;
  while ((match = pattern.exec(source)) !== null) {
    const method = match[1].toUpperCase();
    const routePath = normalizeSourceRoutePath(match[2]);
    ids.push(`route:${method}:${joinRoute(mountPath, routePath)}`);
  }
  return ids.sort();
}

beforeAll(() => {
  registerAllProtectedSurfaces();
});

describe("D0-04 protected-surface completeness", () => {
  it("uses the independent consequential manifest as the expected set", () => {
    expect(expectedProtectedSurfaceIds()).toEqual(expectedConsequentialSurfaceIds());

    // A read-only declaration proves the expected set is no longer generated
    // by blindly mapping the declaration inventory.
    expect(getProtectedSurface("route:GET:/api/repos")).toBeDefined();
    expect(expectedProtectedSurfaceIds()).not.toContain("route:GET:/api/repos");
  });

  it("gives every consequential surface stable independent provenance", () => {
    const ids = CONSEQUENTIAL_SURFACE_MANIFEST.map((entry) => entry.surfaceId);
    expect(new Set(ids).size).toBe(ids.length);

    for (const entry of CONSEQUENTIAL_SURFACE_MANIFEST) {
      expect(entry.surfaceId).toBeTruthy();
      expect(entry.kind).toBeTruthy();
      expect(entry.permission).toBeTruthy();
      expect(entry.resourceType).toBeTruthy();
      expect(entry.resourceResolver).toBeTruthy();
      expect(entry.mutationIdentity).toBeTruthy();
    }
  });

  it("maps every independently inventoried surface to an explicit declaration", () => {
    const report = assertProtectedSurfaceCompleteness(expectedConsequentialSurfaceIds());
    expect(report).toEqual(expect.objectContaining({
      ok: true,
      missing: [],
      incomplete: [],
    }));

    for (const entry of CONSEQUENTIAL_SURFACE_MANIFEST) {
      const declaration = getProtectedSurface(entry.surfaceId);
      expect(declaration).toBeDefined();
      expect(declaration.permission).toBe(entry.permission);
      expect(declaration.resourceType).toBe(entry.resourceType);
      expect(declaration.principalSource).toBeTruthy();
      expect(declaration.authMethod).toBeTruthy();
      expect(declaration.observeHandling).toBe("record");
    }
  });

  it("derives mutation routes from the source-verified omission modules", () => {
    const manifestedRouteIds = new Set(
      CONSEQUENTIAL_SURFACE_MANIFEST
        .filter((entry) => entry.kind === "route")
        .map((entry) => entry.surfaceId)
    );

    for (const module of SOURCE_DERIVED_ROUTE_MODULES) {
      const actualRouteIds = extractMutationRouteIds(module);
      expect(actualRouteIds.length).toBeGreaterThan(0);
      for (const id of actualRouteIds) {
        expect(manifestedRouteIds).toContain(id);
      }
    }
  });

  it("fails closed when an actual consequential surface lacks a declaration", () => {
    const sentinel = "route:POST:/api/d0-04-unregistered-sentinel";
    const report = assertProtectedSurfaceCompleteness([
      ...expectedConsequentialSurfaceIds(),
      sentinel,
    ]);

    expect(report.ok).toBe(false);
    expect(report.missing).toContain(sentinel);
  });

  it("pins the source-verified D0-04 omissions", () => {
    expect(expectedConsequentialSurfaceIds()).toEqual(expect.arrayContaining([
      "route:POST:/api/waivers",
      "route:DELETE:/api/waivers/:id",
      "route:POST:/api/duplicates/:id(\\d+)/confirm",
      "route:POST:/api/duplicates/:id(\\d+)/dismiss",
      "route:POST:/api/gates/:owner/:repo",
      "route:DELETE:/api/gates/:owner/:repo/:name",
      "route:POST:/api/enforcement/policies",
      "route:PUT:/api/enforcement/policies/:id",
      "route:DELETE:/api/enforcement/policies/:id",
      "route:POST:/api/enforcement/violations/:id/suppress",
      "route:POST:/api/phase3/flaky/:id/graduate",
      "route:POST:/api/phase3/flaky/:id/dismiss",
      "route:PUT:/api/phase3/reconciler/repos/:owner/:repo",
      "route:POST:/api/phase3/dependencies/:owner/:repo/batch-pr",
      "route:POST:/api/phase3/dependencies/vuln/:id/dismiss",
      "route:PUT:/api/maintainer/collaborators/:owner/:repo/:login",
      "route:PATCH:/api/maintainer/:owner/:repo/settings",
    ]));
  });
});
