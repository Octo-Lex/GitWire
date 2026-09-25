// D0-04: fail closed if Express application wiring introduces a mutation path
// that the mounted-router source scanner cannot classify.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.resolve(TEST_DIR, "../..");
const SRC_ROOT = path.join(WEB_ROOT, "src");
const APP_PATH = path.join(SRC_ROOT, "app.js");
const ROUTES_ROOT = path.join(SRC_ROOT, "routes");
const ROUTE_IMPORT_CANDIDATE_RE = /from\s+["']\.\/routes\/[^"']+\.js["']/g;
const SCANNER_ROUTE_IMPORT_RE = /import\s+(?:\{\s*([A-Za-z_$][\w$]*)\s*\}|([A-Za-z_$][\w$]*))\s+from\s+"\.\/routes\/([^"]+\.js)";/g;
const PATH_MOUNT_CANDIDATE_RE = /app\.use\(\s*["'][^"']+["']\s*,\s*([A-Za-z_$][\w$]*)\s*\)/g;
const SCANNER_PATH_MOUNT_RE = /app\.use\(\s*"[^"]+"\s*,\s*([A-Za-z_$][\w$]*)\s*\);/g;

function scannerRouteImportBindings(source) {
  const bindings = new Set();
  for (const match of source.matchAll(SCANNER_ROUTE_IMPORT_RE)) {
    bindings.add(match[1] || match[2]);
  }
  return bindings;
}

function assertScannerCompatibleAppWiring(source) {
  const routeImportCandidates = [...source.matchAll(ROUTE_IMPORT_CANDIDATE_RE)].length;
  const parsedRouteImports = [...source.matchAll(SCANNER_ROUTE_IMPORT_RE)].length;
  if (parsedRouteImports !== routeImportCandidates) {
    throw new Error(
      `Scanner-incompatible route import syntax: found ${routeImportCandidates} candidates but parsed ${parsedRouteImports}`,
    );
  }

  const pathMountCandidates = [...source.matchAll(PATH_MOUNT_CANDIDATE_RE)].length;
  const parsedPathMounts = [...source.matchAll(SCANNER_PATH_MOUNT_RE)].length;
  if (parsedPathMounts !== pathMountCandidates) {
    throw new Error(
      `Scanner-incompatible path mount syntax: found ${pathMountCandidates} candidates but parsed ${parsedPathMounts}`,
    );
  }
}

function unsupportedDirectAppMutationSyntax(source) {
  return [
    ...source.matchAll(/\bapp\s*\.\s*(post|put|patch|delete)\s*\(/g),
    ...source.matchAll(/\bapp\s*\[\s*["'](?:post|put|patch|delete)["']\s*\]\s*\(/g),
    ...source.matchAll(/\bapp\s*\.\s*route\s*\(/g),
  ];
}

function routeModuleCompositionSites() {
  const sites = [];
  for (const fileName of fs.readdirSync(ROUTES_ROOT).filter((name) => name.endsWith(".js"))) {
    const source = fs.readFileSync(path.join(ROUTES_ROOT, fileName), "utf8");
    const routerDeclarations = [...source.matchAll(/(?:^|\n)\s*(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:express\s*\.\s*)?Router\s*\(\s*\)/g)];
    for (const declaration of routerDeclarations) {
      const binding = declaration[1].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (new RegExp(`\\b${binding}\\s*\\.\\s*use\\s*\\(`).test(source)) {
        sites.push(fileName);
      }
    }
  }
  return sites;
}

describe("D0-04 application entrypoint guard", () => {
  const appSource = fs.readFileSync(APP_PATH, "utf8");

  test("mutating HTTP entry points stay in mounted route modules", () => {
    expect(unsupportedDirectAppMutationSyntax(appSource)).toEqual([]);
  });

  test("route imports and path mounts stay compatible with the source scanner", () => {
    expect(() => assertScannerCompatibleAppWiring(appSource)).not.toThrow();
  });

  test("every path-mounted identifier is visible to the mounted-router scanner", () => {
    const routeBindings = scannerRouteImportBindings(appSource);
    const mounts = [...appSource.matchAll(SCANNER_PATH_MOUNT_RE)];

    for (const mount of mounts) {
      expect(routeBindings.has(mount[1])).toBe(true);
    }
  });

  test("mounted route modules do not compose hidden child routers", () => {
    expect(routeModuleCompositionSites()).toEqual([]);
  });

  test("single-quoted or semicolonless route wiring fails closed until explicitly supported", () => {
    const variants = [
      ["import router from './routes/new.js';", "app.use('/api/new', router);"],
      ["import router from \"./routes/new.js\"", "app.use(\"/api/new\", router)"],
    ];

    for (const lines of variants) {
      expect(() => assertScannerCompatibleAppWiring(lines.join("\n"))).toThrow(
        /Scanner-incompatible (route import|path mount) syntax/,
      );
    }
  });

  test("alternate direct Express mutation syntax is rejected", () => {
    expect(unsupportedDirectAppMutationSyntax('app["post"]("/x", handler);')).not.toEqual([]);
    expect(unsupportedDirectAppMutationSyntax('app.route("/x").post(handler);')).not.toEqual([]);
  });
});
