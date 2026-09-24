// D0-04: protected-surface completeness must be derived independently from
// authorization declarations. This suite is CI-discovered by web-unit-tests.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import {
  CONSEQUENTIAL_SURFACE_MANIFEST,
  PROTECTED_READ_SURFACE_MANIFEST,
  ROUTE_CLASSIFICATION_EXCLUSIONS,
  expectedProtectedSurfaceIdsFromManifest,
} from "../../src/services/auth/consequentialSurfaceManifest.js";
import { registerAllProtectedSurfaces } from "../../src/services/auth/declarations.js";
import {
  assertProtectedSurfaceCompleteness,
  getProtectedSurface,
} from "../../src/services/auth/protectedSurfaces.js";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.resolve(TEST_DIR, "../..");
const SRC_ROOT = path.join(WEB_ROOT, "src");

function decodeRouteLiteral(raw) {
  return raw
    .replace(/\\\\/g, "\\")
    .replace(/\\"/g, "\"")
    .replace(/\\'/g, "'");
}

function joinRoute(mountPath, routePath) {
  if (routePath === "/") return mountPath;
  if (mountPath === "/") return routePath;
  return mountPath.replace(/\/$/, "") + routePath;
}

function discoverMountedMutatingRoutes() {
  const appSource = fs.readFileSync(path.join(SRC_ROOT, "app.js"), "utf8");
  const imports = new Map();

  const importRe = /import\s+(?:\{\s*([A-Za-z_$][\w$]*)\s*\}|([A-Za-z_$][\w$]*))\s+from\s+"\.\/routes\/([^"]+\.js)";/g;
  for (const match of appSource.matchAll(importRe)) {
    imports.set(match[1] || match[2], match[3]);
  }

  const mounted = [];
  const mountRe = /app\.use\(\s*"([^"]+)"\s*,\s*([A-Za-z_$][\w$]*)\s*\);/g;
  for (const match of appSource.matchAll(mountRe)) {
    const [, mountPath, routerName] = match;
    const fileName = imports.get(routerName);
    if (fileName) mounted.push({ mountPath, fileName });
  }

  const discovered = [];
  const routeRe = /\b[A-Za-z_$][\w$]*\.(post|put|patch|delete)\(\s*(["'])(.*?)\2/gms;
  for (const { mountPath, fileName } of mounted) {
    const sourcePath = `src/routes/${fileName}`;
    const source = fs.readFileSync(path.join(SRC_ROOT, "routes", fileName), "utf8");
    for (const match of source.matchAll(routeRe)) {
      const method = match[1].toUpperCase();
      const routePath = decodeRouteLiteral(match[3]);
      discovered.push({
        surfaceId: `route:${method}:${joinRoute(mountPath, routePath)}`,
        sourcePath,
      });
    }
  }

  return discovered.sort((a, b) => a.surfaceId.localeCompare(b.surfaceId));
}

function classifyUncovered(discoveredIds, manifestIds, exclusions) {
  const exclusionIds = new Set(exclusions.map((entry) => entry.surfaceId));
  return discoveredIds.filter((id) => !manifestIds.has(id) && !exclusionIds.has(id));
}

describe("D0-04 protected-surface completeness", () => {
  beforeAll(() => {
    registerAllProtectedSurfaces();
  });

  test("independent manifest is complete against the declaration registry", () => {
    const result = assertProtectedSurfaceCompleteness(
      expectedProtectedSurfaceIdsFromManifest(),
    );

    expect(result.ok).toBe(true);
    expect(result.missing).toEqual([]);
    expect(result.incomplete).toEqual([]);
  });

  test("every consequential surface declares matching authority and mutation metadata", () => {
    for (const expected of CONSEQUENTIAL_SURFACE_MANIFEST) {
      const declared = getProtectedSurface(expected.surfaceId);
      expect(declared).toBeDefined();
      expect(declared).toMatchObject({
        kind: expected.kind,
        permission: expected.permission,
        resourceType: expected.resourceType,
        principalSource: expected.principalSource,
        authMethod: expected.authMethod,
        observeHandling: expected.observeHandling,
      });
      expect(declared.resourceResolver).toEqual(expect.any(String));
      expect(declared.mutationIdentity).toEqual(expect.any(String));
    }
  });

  test("pre-existing protected read surfaces remain independently required", () => {
    for (const expected of PROTECTED_READ_SURFACE_MANIFEST) {
      expect(getProtectedSurface(expected.surfaceId)).toMatchObject({
        kind: expected.kind,
        permission: expected.permission,
        resourceType: expected.resourceType,
        principalSource: expected.principalSource,
        authMethod: expected.authMethod,
        observeHandling: expected.observeHandling,
      });
    }
  });

  test("every mounted mutating HTTP route is classified by source inventory", () => {
    const discovered = discoverMountedMutatingRoutes();
    const discoveredIds = discovered.map((entry) => entry.surfaceId);
    const manifestRouteIds = new Set(
      CONSEQUENTIAL_SURFACE_MANIFEST
        .filter((surface) => surface.kind === "route")
        .map((surface) => surface.surfaceId),
    );

    expect(
      classifyUncovered(
        discoveredIds,
        manifestRouteIds,
        ROUTE_CLASSIFICATION_EXCLUSIONS,
      ),
    ).toEqual([]);

    // Prevent stale exclusions from silently accumulating.
    const discoveredSet = new Set(discoveredIds);
    for (const exclusion of ROUTE_CLASSIFICATION_EXCLUSIONS) {
      expect(exclusion.reason).toEqual(expect.any(String));
      expect(exclusion.reason.length).toBeGreaterThan(15);
      expect(discoveredSet.has(exclusion.surfaceId)).toBe(true);
      expect(
        discovered.find((entry) => entry.surfaceId === exclusion.surfaceId)?.sourcePath,
      ).toBe(exclusion.sourcePath);
      if (exclusion.coveredBySurfaceId) {
        expect(getProtectedSurface(exclusion.coveredBySurfaceId)).toBeDefined();
      }
    }
  });

  test("every consequential route still exists at the source identity recorded by the manifest", () => {
    const discovered = discoverMountedMutatingRoutes();
    const byId = new Map(discovered.map((entry) => [entry.surfaceId, entry]));

    for (const surface of CONSEQUENTIAL_SURFACE_MANIFEST.filter((s) => s.kind === "route")) {
      expect(byId.get(surface.surfaceId)).toEqual({
        surfaceId: surface.surfaceId,
        sourcePath: surface.sourcePath,
      });
    }
  });

  test("a newly added mutating route is unclassified until explicitly inventoried or excluded", () => {
    const manifestIds = new Set(
      CONSEQUENTIAL_SURFACE_MANIFEST
        .filter((surface) => surface.kind === "route")
        .map((surface) => surface.surfaceId),
    );
    const synthetic = "route:POST:/api/synthetic/authority-write";

    expect(
      classifyUncovered(
        [synthetic],
        manifestIds,
        ROUTE_CLASSIFICATION_EXCLUSIONS,
      ),
    ).toEqual([synthetic]);
  });

  test("removing a required declaration is detected by the registry completeness check", () => {
    const syntheticMissing = "route:POST:/api/synthetic/missing-declaration";
    const result = assertProtectedSurfaceCompleteness([
      ...expectedProtectedSurfaceIdsFromManifest(),
      syntheticMissing,
    ]);

    expect(result.ok).toBe(false);
    expect(result.missing).toContain(syntheticMissing);
  });

  test("renaming or removing a consequential route without updating the manifest is detected", () => {
    const discovered = discoverMountedMutatingRoutes();
    const route = CONSEQUENTIAL_SURFACE_MANIFEST.find((surface) => surface.kind === "route");
    const simulatedSourceIds = new Set(
      discovered
        .map((entry) => entry.surfaceId)
        .filter((id) => id !== route.surfaceId),
    );
    const missingFromSource = CONSEQUENTIAL_SURFACE_MANIFEST
      .filter((surface) => surface.kind === "route")
      .map((surface) => surface.surfaceId)
      .filter((id) => !simulatedSourceIds.has(id));

    expect(missingFromSource).toContain(route.surfaceId);
  });
});
