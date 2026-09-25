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
const BOT_ROOT = path.resolve(WEB_ROOT, "../bot");
const MUTATING_HTTP_METHOD_RE = /\bmethod\s*:\s*"(POST|PUT|PATCH|DELETE)"/g;

function parseDoubleQuotedRouteLiteral(raw) {
  return JSON.parse(`"${raw}"`);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function joinRoute(mountPath, routePath) {
  if (routePath === "/") return mountPath;
  if (mountPath === "/") return routePath;
  return mountPath.replace(/\/$/, "") + routePath;
}

function discoverModuleRouterBinding(source, sourcePath) {
  const routerFactoryCandidates = [
    ...source.matchAll(/\b(?:express\s*\.\s*)?Router\s*\(\s*\)/g),
  ];
  const declarationRe = /(?:^|\n)\s*(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:express\s*\.\s*)?Router\s*\(\s*\)\s*;/g;
  const declarations = [...source.matchAll(declarationRe)];

  if (declarations.length !== routerFactoryCandidates.length) {
    throw new Error(
      `Unsupported Router() construction syntax in ${sourcePath}: discovered ${routerFactoryCandidates.length} factories but parsed ${declarations.length} declarations`,
    );
  }
  if (declarations.length !== 1) {
    throw new Error(
      `Mounted route module ${sourcePath} must expose exactly one parseable Router() instance; found ${declarations.length}`,
    );
  }

  return declarations[0][1];
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
    const [, mountPath, appBinding] = match;
    const fileName = imports.get(appBinding);
    if (!fileName) {
      throw new Error(`Path-mounted identifier ${appBinding} is not mapped to a parseable route-module import`);
    }
    mounted.push({ mountPath, fileName, appBinding });
  }

  const discovered = [];
  for (const { mountPath, fileName } of mounted) {
    const sourcePath = `src/routes/${fileName}`;
    const source = fs.readFileSync(path.join(SRC_ROOT, "routes", fileName), "utf8");
    const routerName = discoverModuleRouterBinding(source, sourcePath);
    const escapedRouter = escapeRegExp(routerName);
    const candidateRe = new RegExp(`\\b${escapedRouter}\\s*\\.\\s*(post|put|patch|delete)\\s*\\(`, "g");
    const routeRe = new RegExp(
      `\\b${escapedRouter}\\s*\\.\\s*(post|put|patch|delete)\\s*\\(\\s*"((?:\\\\.|[^"\\\\])*)"`,
      "gms",
    );
    const candidateCount = [...source.matchAll(candidateRe)].length;
    const matches = [...source.matchAll(routeRe)];
    const chainedRouteRe = new RegExp(`\\b${escapedRouter}\\s*\\.\\s*route\\s*\\(`, "g");
    const bracketMutationRe = new RegExp(`\\b${escapedRouter}\\s*\\[\\s*["'](?:post|put|patch|delete)["']\\s*\\]`, "g");

    if (chainedRouteRe.test(source) || bracketMutationRe.test(source)) {
      throw new Error(`Unsupported mounted-router mutation syntax in ${sourcePath}`);
    }

    if (matches.length !== candidateCount) {
      throw new Error(
        `Unsupported mutating-route syntax in ${sourcePath}: discovered ${candidateCount} candidates but parsed ${matches.length}`,
      );
    }

    for (const match of matches) {
      const method = match[1].toUpperCase();
      const routePath = parseDoubleQuotedRouteLiteral(match[2]);
      discovered.push({
        surfaceId: `route:${method}:${joinRoute(mountPath, routePath)}`,
        sourcePath,
      });
    }
  }

  return discovered.sort((a, b) => a.surfaceId.localeCompare(b.surfaceId));
}

function discoverStartupRuntimeSources() {
  const source = fs.readFileSync(path.join(SRC_ROOT, "index.js"), "utf8");
  const imports = new Map();
  const importRe = /import\s*\{([^}]+)\}\s*from\s*"\.\/workers\/([^"]+\.js)";/gms;
  const importCandidates = [...source.matchAll(/from\s+"\.\/workers\/[^"]+\.js";/g)].length;
  const importMatches = [...source.matchAll(importRe)];

  if (importMatches.length !== importCandidates) {
    throw new Error(`Unsupported worker import syntax in src/index.js: found ${importCandidates} imports but parsed ${importMatches.length}`);
  }

  for (const match of importMatches) {
    const sourceIdentity = `src/workers/${match[2]}`;
    for (const rawSpecifier of match[1].split(",")) {
      const specifier = rawSpecifier.trim();
      if (!specifier) continue;
      const alias = specifier.match(/^([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/);
      if (!alias) throw new Error(`Unsupported worker import specifier in src/index.js: ${specifier}`);
      imports.set(alias[2] || alias[1], sourceIdentity);
    }
  }

  const workersMatch = /const\s+workers\s*=\s*\[([\s\S]*?)\];/.exec(source);
  if (!workersMatch) throw new Error("Unable to derive worker consumers from src/index.js");

  const consumerNames = [...workersMatch[1].matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/g)].map((match) => match[1]);
  for (const name of consumerNames) {
    if (!imports.has(name)) throw new Error(`Worker array contains non-worker call ${name}`);
  }

  const arrayStart = workersMatch.index;
  const arrayEnd = arrayStart + workersMatch[0].length;
  const outsideWorkersArray = source.slice(0, arrayStart) + source.slice(arrayEnd);
  const consumerSet = new Set(consumerNames);
  const scheduledNames = [];

  for (const name of imports.keys()) {
    if (consumerSet.has(name)) continue;
    const calls = [...outsideWorkersArray.matchAll(new RegExp(`\\b${escapeRegExp(name)}\\s*\\(`, "g"))];
    if (calls.length > 0) scheduledNames.push(name);
  }

  const wiredNames = new Set([...consumerNames, ...scheduledNames]);
  const unusedImports = [...imports.keys()].filter((name) => !wiredNames.has(name));
  if (unusedImports.length > 0) {
    throw new Error(`Imported worker entry points are not wired in src/index.js: ${unusedImports.join(", ")}`);
  }

  return {
    workers: consumerNames.map((name) => imports.get(name)).sort(),
    scheduled: scheduledNames.map((name) => imports.get(name)).sort(),
  };
}

function discoverTelegramMutationSurfaces() {
  const apiSource = fs.readFileSync(path.join(BOT_ROOT, "src", "api.js"), "utf8");
  const commandSource = fs.readFileSync(path.join(BOT_ROOT, "src", "commands.js"), "utf8");
  const mutatingApiFunctions = new Set();
  const exportStarts = [...apiSource.matchAll(/export\s+function\s+([A-Za-z_$][\w$]*)\s*\(/g)];

  for (let i = 0; i < exportStarts.length; i += 1) {
    const current = exportStarts[i];
    const end = i + 1 < exportStarts.length ? exportStarts[i + 1].index : apiSource.length;
    const segment = apiSource.slice(current.index, end);
    const methodCandidates = [...segment.matchAll(/\bmethod\s*:/g)].length;
    const literalMethods = [...segment.matchAll(MUTATING_HTTP_METHOD_RE)];
    if (methodCandidates !== literalMethods.length) {
      throw new Error(`Unsupported API mutation method syntax in packages/bot/src/api.js export ${current[1]}`);
    }
    if (literalMethods.length > 0) mutatingApiFunctions.add(current[1]);
  }

  const candidateCount = [...commandSource.matchAll(/\bbot\.command\s*\(/g)].length;
  const registrations = [...commandSource.matchAll(/\bbot\.command\s*\(\s*"((?:\\.|[^"\\])*)"/g)];
  if (registrations.length !== candidateCount) {
    throw new Error(`Unsupported Telegram command registration syntax: found ${candidateCount} registrations but parsed ${registrations.length}`);
  }

  const surfaces = [];
  for (let i = 0; i < registrations.length; i += 1) {
    const current = registrations[i];
    const end = i + 1 < registrations.length ? registrations[i + 1].index : commandSource.length;
    const segment = commandSource.slice(current.index, end);
    const methodCandidates = [...segment.matchAll(/\bmethod\s*:/g)].length;
    const literalMethods = [...segment.matchAll(MUTATING_HTTP_METHOD_RE)];
    if (methodCandidates !== literalMethods.length) {
      throw new Error(`Unsupported Telegram mutation method syntax near command ${current[1]}`);
    }

    const invokesMutatingWrapper = [...mutatingApiFunctions].some((name) =>
      new RegExp(`\\b${escapeRegExp(name)}\\s*\\(`).test(segment),
    );
    if (literalMethods.length === 0 && !invokesMutatingWrapper) continue;

    const command = JSON.parse(`"${current[1]}"`);
    surfaces.push({
      surfaceId: `telegram:${command}`,
      sourceIdentity: `../bot/src/commands.js#${command}`,
    });
  }

  return surfaces.sort((a, b) => a.surfaceId.localeCompare(b.surfaceId));
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

  test("worker and scheduler declarations exactly match executable startup wiring", () => {
    const discovered = discoverStartupRuntimeSources();
    const manifestWorkers = CONSEQUENTIAL_SURFACE_MANIFEST
      .filter((surface) => surface.kind === "worker")
      .map((surface) => surface.sourceIdentity)
      .sort();
    const manifestScheduled = CONSEQUENTIAL_SURFACE_MANIFEST
      .filter((surface) => surface.kind === "scheduled")
      .map((surface) => surface.sourceIdentity)
      .sort();

    expect(manifestWorkers).toEqual(discovered.workers);
    expect(manifestScheduled).toEqual(discovered.scheduled);
  });

  test("Telegram mutation commands exactly match executable command/API wiring", () => {
    const discovered = discoverTelegramMutationSurfaces();
    const manifest = CONSEQUENTIAL_SURFACE_MANIFEST
      .filter((surface) => surface.kind === "telegram")
      .map((surface) => ({ surfaceId: surface.surfaceId, sourceIdentity: surface.sourceIdentity }))
      .sort((a, b) => a.surfaceId.localeCompare(b.surfaceId));

    expect(manifest).toEqual(discovered);
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
