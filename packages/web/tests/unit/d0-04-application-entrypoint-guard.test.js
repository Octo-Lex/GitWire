// D0-04: fail closed if Express application wiring introduces a mutation path
// that the mounted-router source scanner cannot classify.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.resolve(TEST_DIR, "../..");
const APP_PATH = path.join(WEB_ROOT, "src", "app.js");
const ROUTE_IMPORT_CANDIDATE_RE = /from\s+["']\.\/routes\/[^"']+\.js["'];/g;
const SCANNER_ROUTE_IMPORT_RE = /import\s+(?:\{\s*([A-Za-z_$][\w$]*)\s*\}|([A-Za-z_$][\w$]*))\s+from\s+"\.\/routes\/([^"]+\.js)";/g;
const PATH_MOUNT_CANDIDATE_RE = /app\.use\(\s*["'][^"']+["']\s*,\s*([A-Za-z_$][\w$]*)\s*\);/g;
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

describe("D0-04 application entrypoint guard", () => {
  const appSource = fs.readFileSync(APP_PATH, "utf8");

  test("mutating HTTP entry points stay in mounted route modules", () => {
    expect([...appSource.matchAll(/\bapp\s*\.\s*(post|put|patch|delete)\s*\(/g)]).toEqual([]);
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

  test("single-quoted route wiring fails closed until the scanner explicitly supports it", () => {
    const singleQuoted = [
      "import router from './routes/new.js';",
      "app.use('/api/new', router);",
    ].join("\n");

    expect(() => assertScannerCompatibleAppWiring(singleQuoted)).toThrow(
      /Scanner-incompatible route import syntax/,
    );
  });
});
