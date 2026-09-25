// D0-04: fail closed if Express application wiring introduces a mutation path
// that the mounted-router source scanner cannot classify.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.resolve(TEST_DIR, "../..");
const APP_PATH = path.join(WEB_ROOT, "src", "app.js");
const ROUTE_IMPORT_CANDIDATE_RE = /from\s+"\.\/routes\/[^"]+\.js";/g;
const SCANNER_ROUTE_IMPORT_RE = /import\s+(?:\{\s*([A-Za-z_$][\w$]*)\s*\}|([A-Za-z_$][\w$]*))\s+from\s+"\.\/routes\/([^"]+\.js)";/g;

function scannerRouteImportBindings(source) {
  const bindings = new Set();
  for (const match of source.matchAll(SCANNER_ROUTE_IMPORT_RE)) {
    bindings.add(match[1] || match[2]);
  }
  return bindings;
}

describe("D0-04 application entrypoint guard", () => {
  const appSource = fs.readFileSync(APP_PATH, "utf8");

  test("mutating HTTP entry points stay in mounted route modules", () => {
    expect([...appSource.matchAll(/\bapp\s*\.\s*(post|put|patch|delete)\s*\(/g)]).toEqual([]);
  });

  test("route-module imports stay compatible with the mounted-router scanner", () => {
    const candidateCount = [...appSource.matchAll(ROUTE_IMPORT_CANDIDATE_RE)].length;
    const parsedCount = [...appSource.matchAll(SCANNER_ROUTE_IMPORT_RE)].length;
    expect(parsedCount).toBe(candidateCount);
  });

  test("every path-mounted identifier is visible to the mounted-router scanner", () => {
    const routeBindings = scannerRouteImportBindings(appSource);
    const mounts = [...appSource.matchAll(/app\.use\(\s*"[^"]+"\s*,\s*([A-Za-z_$][\w$]*)\s*\);/g)];

    for (const mount of mounts) {
      expect(routeBindings.has(mount[1])).toBe(true);
    }
  });
});