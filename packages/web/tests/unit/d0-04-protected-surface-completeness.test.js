// tests/unit/d0-04-protected-surface-completeness.test.js
// D0-04 regression: protected-surface completeness is source-derived, not a
// declaration inventory checking itself.

import { beforeAll, describe, expect, it } from "@jest/globals";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  CONSEQUENTIAL_SURFACE_MANIFEST,
  NON_CONSEQUENTIAL_MUTATION_SURFACE_IDS,
  expectedConsequentialSurfaceIds,
  expectedProtectedSurfaceIdsFromManifest,
} from "../../src/services/auth/consequentialSurfaceManifest.js";
import { expectedProtectedSurfaceIds, registerAllProtectedSurfaces } from "../../src/services/auth/declarations.js";
import { assertProtectedSurfaceCompleteness, getProtectedSurface } from "../../src/services/auth/protectedSurfaces.js";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.resolve(TEST_DIR, "../..");

function joinRoute(mountPath, routePath) {
  return routePath === "/" ? mountPath : mountPath + routePath;
}

function normalizeSourceRoutePath(routePath) {
  return routePath.replaceAll("\\\\", "\\");
}

function routeImports(appSource) {
  const bindings = new Map();
  const named = /import\s+\{\s*([A-Za-z0-9_]+)\s*\}\s+from\s+["']\.\/routes\/([^"']+\.js)["'];/g;
  const defaults = /import\s+([A-Za-z0-9_]+)\s+from\s+["']\.\/routes\/([^"']+\.js)["'];/g;
  let match;
  while ((match = named.exec(appSource)) !== null) bindings.set(match[1], `src/routes/${match[2]}`);
  while ((match = defaults.exec(appSource)) !== null) bindings.set(match[1], `src/routes/${match[2]}`);
  return bindings;
}

function protectedRouteModulesFromApp() {
  const appSource = fs.readFileSync(path.join(WEB_ROOT, "src/app.js"), "utf8");
  const observerOffset = appSource.indexOf("app.use(routeAuthObserver)");
  expect(observerOffset).toBeGreaterThanOrEqual(0);
  const protectedSource = appSource.slice(observerOffset);
  const imports = routeImports(appSource);
  const modules = [];
  const uses = /app\.use\(\s*["']([^"']+)["']\s*,\s*([A-Za-z0-9_]+)\s*\);/g;
  let match;
  while ((match = uses.exec(protectedSource)) !== null) {
    const mountPath = match[1];
    const binding = match[2];
    const sourcePath = imports.get(binding);
    if (!sourcePath || !mountPath.startsWith("/api") || mountPath.startsWith("/api/setup")) continue;
    modules.push({ mountPath, sourcePath });
  }
  return modules;
}

function mutationRouteIdsForModule({ sourcePath, mountPath }) {
  const source = fs.readFileSync(path.join(WEB_ROOT, sourcePath), "utf8");
  const ids = [];
  const pattern = /\b(?:router|[A-Za-z0-9_]+Router)\.(post|put|patch|delete)\(\s*["']([^"']+)["']/g;
  let match;
  while ((match = pattern.exec(source)) !== null) {
    ids.push(`route:${match[1].toUpperCase()}:${joinRoute(mountPath, normalizeSourceRoutePath(match[2]))}`);
  }
  return ids;
}

beforeAll(() => registerAllProtectedSurfaces());

describe("D0-04 protected-surface completeness", () => {
  it("derives the expected protected set outside declarations", () => {
    expect(expectedProtectedSurfaceIds()).toEqual(expectedProtectedSurfaceIdsFromManifest());
    expect(expectedProtectedSurfaceIds()).toContain("route:GET:/api/repos");
    expect(expectedConsequentialSurfaceIds()).not.toContain("route:GET:/api/repos");
  });

  it("gives every consequential surface stable independent provenance", () => {
    const ids = CONSEQUENTIAL_SURFACE_MANIFEST.map((entry) => entry.surfaceId);
    expect(new Set(ids).size).toBe(ids.length);
    for (const entry of CONSEQUENTIAL_SURFACE_MANIFEST) {
      expect(entry.surfaceId).toBeTruthy();
      expect(entry.kind).toBeTruthy();
      expect(entry.sourcePath).toBeTruthy();
      expect(entry.permission).toBeTruthy();
      expect(entry.resourceType).toBeTruthy();
      expect(entry.resourceResolver).toBeTruthy();
      expect(entry.mutationIdentity).toBeTruthy();
    }
  });

  it("maps every independently inventoried protected surface to a complete declaration", () => {
    const report = assertProtectedSurfaceCompleteness(expectedProtectedSurfaceIds());
    expect(report).toEqual(expect.objectContaining({ ok: true, missing: [], incomplete: [] }));

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

  it("classifies every mutation-shaped route mounted behind the auth observer", () => {
    const consequential = new Set(expectedConsequentialSurfaceIds());
    const nonConsequential = new Set(NON_CONSEQUENTIAL_MUTATION_SURFACE_IDS);
    const candidates = protectedRouteModulesFromApp().flatMap(mutationRouteIdsForModule);

    expect(candidates.length).toBeGreaterThan(0);
    const unclassified = candidates.filter((id) => !consequential.has(id) && !nonConsequential.has(id));
    expect(unclassified).toEqual([]);
  });

  it("does not allow stale exception entries", () => {
    const candidates = new Set(protectedRouteModulesFromApp().flatMap(mutationRouteIdsForModule));
    for (const id of NON_CONSEQUENTIAL_MUTATION_SURFACE_IDS) {
      expect(candidates).toContain(id);
    }
  });

  it("fails closed when an independently expected surface lacks a declaration", () => {
    const sentinel = "route:POST:/api/d0-04-unregistered-sentinel";
    const report = assertProtectedSurfaceCompleteness([...expectedProtectedSurfaceIds(), sentinel]);
    expect(report.ok).toBe(false);
    expect(report.missing).toContain(sentinel);
  });

  it("pins the source-verified omission classes", () => {
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
