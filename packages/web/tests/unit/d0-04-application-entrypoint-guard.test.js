// D0-04: fail closed if Express application wiring introduces a mutation path
// that the mounted-router source scanner cannot classify.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.resolve(TEST_DIR, "../..");
const APP_PATH = path.join(WEB_ROOT, "src", "app.js");

function routeImportBindings(source) {
  const bindings = new Set();
  const importRe = /import\s+(?:\{([^}]+)\}|([A-Za-z_$][\w$]*))\s+from\s+"\.\/routes\/[^\"]+\.js";/gms;

  for (const match of source.matchAll(importRe)) {
    if (match[2]) {
      bindings.add(match[2]);
      continue;
    }

    for (const rawSpecifier of match[1].split(",")) {
      const specifier = rawSpecifier.trim();
      if (!specifier) continue;
      const parsed = specifier.match(/^([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/);
      if (!parsed) throw new Error(`Unsupported route import specifier in src/app.js: ${specifier}`);
      bindings.add(parsed[2] || parsed[1]);
    }
  }

  return bindings;
}

describe("D0-04 application entrypoint guard", () => {
  const appSource = fs.readFileSync(APP_PATH, "utf8");

  test("mutating HTTP entry points stay in mounted route modules", () => {
    expect([...appSource.matchAll(/\bapp\s*\.\s*(post|put|patch|delete)\s*\(/g)]).toEqual([]);
  });

  test("every path-mounted identifier is sourced from a route module", () => {
    const routeBindings = routeImportBindings(appSource);
    const mounts = [...appSource.matchAll(/app\.use\(\s*"[^\"]+"\s*,\s*([A-Za-z_$][\w$]*)\s*\);/g)];

    for (const mount of mounts) {
      expect(routeBindings.has(mount[1])).toBe(true);
    }
  });
});
