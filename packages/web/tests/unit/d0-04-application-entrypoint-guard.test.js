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
const ROUTE_MODULE_REFERENCE_RE = /["']\.\/routes\/[^"']+\.js["']/g;
const ROUTE_IMPORT_CANDIDATE_RE = /from\s+["']\.\/routes\/[^"']+\.js["']/g;
const SCANNER_ROUTE_IMPORT_RE = /import\s+(?:\{\s*([A-Za-z_$][\w$]*)\s*\}|([A-Za-z_$][\w$]*))\s+from\s+"\.\/routes\/([^"]+\.js)";/g;
const PATH_MOUNT_CANDIDATE_RE = /app\.use\(\s*["'][^"']+["']\s*,\s*([A-Za-z_$][\w$]*)\s*\)/g;
const SCANNER_PATH_MOUNT_RE = /app\.use\(\s*"[^"]+"\s*,\s*([A-Za-z_$][\w$]*)\s*\);/g;

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function scannerRouteImportBindings(source) {
  const bindings = new Set();
  for (const match of source.matchAll(SCANNER_ROUTE_IMPORT_RE)) {
    bindings.add(match[1] || match[2]);
  }
  return bindings;
}

function scannerMountedBindings(source) {
  return new Set([...source.matchAll(SCANNER_PATH_MOUNT_RE)].map((match) => match[1]));
}

function assertScannerCompatibleAppWiring(source) {
  const routeModuleReferences = [...source.matchAll(ROUTE_MODULE_REFERENCE_RE)].length;
  const routeImportCandidates = [...source.matchAll(ROUTE_IMPORT_CANDIDATE_RE)].length;
  const parsedRouteImports = [...source.matchAll(SCANNER_ROUTE_IMPORT_RE)].length;
  if (routeModuleReferences !== routeImportCandidates || parsedRouteImports !== routeImportCandidates) {
    throw new Error(
      `Scanner-incompatible route import syntax: found ${routeModuleReferences} route references, ${routeImportCandidates} import candidates, and ${parsedRouteImports} parsed imports`,
    );
  }

  const pathMountCandidates = [...source.matchAll(PATH_MOUNT_CANDIDATE_RE)].length;
  const parsedPathMounts = [...source.matchAll(SCANNER_PATH_MOUNT_RE)].length;
  if (parsedPathMounts !== pathMountCandidates) {
    throw new Error(
      `Scanner-incompatible path mount syntax: found ${pathMountCandidates} candidates but parsed ${parsedPathMounts}`,
    );
  }

  const importedBindings = [...scannerRouteImportBindings(source)].sort();
  const mountedBindings = [...scannerMountedBindings(source)].sort();
  if (importedBindings.length !== mountedBindings.length || importedBindings.some((binding, i) => binding !== mountedBindings[i])) {
    throw new Error(
      `Scanner-incompatible route mounting: imported [${importedBindings.join(", ")}] but mounted [${mountedBindings.join(", ")}]`,
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

function siblingRouteModuleBindings(source, sourcePath) {
  const bindings = new Set();
  const siblingImportRe = /import\s+(?:\{([^}]+)\}|([A-Za-z_$][\w$]*))\s+from\s+["']((?:\.\/|\.\.\/routes\/)[^"']+\.js)["'];?/gms;

  for (const match of source.matchAll(siblingImportRe)) {
    if (match[2]) {
      bindings.add(match[2]);
      continue;
    }

    for (const rawSpecifier of match[1].split(",")) {
      const specifier = rawSpecifier.trim();
      if (!specifier) continue;
      const parsed = specifier.match(/^([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/);
      if (!parsed) {
        throw new Error(`Unsupported sibling route import specifier in ${sourcePath}: ${specifier}`);
      }
      bindings.add(parsed[2] || parsed[1]);
    }
  }

  return bindings;
}

function hiddenChildRouterBindings(source, sourcePath) {
  const sites = [];
  const siblingBindings = siblingRouteModuleBindings(source, sourcePath);
  const routerDeclarations = [...source.matchAll(/(?:^|\n)\s*(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:express\s*\.\s*)?Router\s*\(\s*\)/g)];

  for (const declaration of routerDeclarations) {
    const routerBinding = escapeRegExp(declaration[1]);
    for (const childBinding of siblingBindings) {
      const child = escapeRegExp(childBinding);
      if (new RegExp(`\\b${routerBinding}\\s*\\.\\s*use\\s*\\([^;]*\\b${child}\\b`, "gms").test(source)) {
        sites.push(childBinding);
      }
    }

    if (new RegExp(`\\b${routerBinding}\\s*\\.\\s*use\\s*\\([^;]*\\bimport\\s*\\(\\s*["'](?:\\.\\/|\\.\\.\\/routes\\/)`, "gms").test(source)) {
      sites.push("dynamic-import");
    }
  }

  return sites;
}

function routeModuleCompositionSites() {
  const sites = [];
  for (const fileName of fs.readdirSync(ROUTES_ROOT).filter((name) => name.endsWith(".js"))) {
    const sourcePath = `src/routes/${fileName}`;
    const source = fs.readFileSync(path.join(ROUTES_ROOT, fileName), "utf8");
    for (const site of hiddenChildRouterBindings(source, sourcePath)) {
      sites.push(`${fileName}:${site}`);
    }
  }
  return sites;
}

describe("D0-04 application entrypoint guard", () => {
  const appSource = fs.readFileSync(APP_PATH, "utf8");

  test("mutating HTTP entry points stay in mounted route modules", () => {
    expect(unsupportedDirectAppMutationSyntax(appSource)).toEqual([]);
  });

  test("route references, imports, and mounts stay exactly compatible with the source scanner", () => {
    expect(() => assertScannerCompatibleAppWiring(appSource)).not.toThrow();
  });

  test("mounted route modules do not compose hidden child routers", () => {
    expect(routeModuleCompositionSites()).toEqual([]);
  });

  test("composition guard allows middleware but rejects sibling and dynamic child routers", () => {
    const middleware = [
      'import { Router } from "express";',
      'import { paginationMiddleware } from "../middleware/pagination.js";',
      "const router = Router();",
      "router.use(paginationMiddleware);",
    ].join("\n");
    expect(hiddenChildRouterBindings(middleware, "src/routes/synthetic.js")).toEqual([]);

    const sibling = [
      'import { Router } from "express";',
      'import childRouter from "./child.js";',
      "const router = Router();",
      'router.use("/child", childRouter);',
    ].join("\n");
    expect(hiddenChildRouterBindings(sibling, "src/routes/synthetic.js")).toEqual(["childRouter"]);

    const dynamic = [
      'import { Router } from "express";',
      "const router = Router();",
      'router.use("/child", (await import("./child.js")).default);',
    ].join("\n");
    expect(hiddenChildRouterBindings(dynamic, "src/routes/synthetic.js")).toContain("dynamic-import");
  });

  test("single-quoted, semicolonless, dynamic, or variable-mounted route wiring fails closed", () => {
    const variants = [
      ["import router from './routes/new.js';", "app.use('/api/new', router);"],
      ["import router from \"./routes/new.js\"", "app.use(\"/api/new\", router)"],
      ["const mod = await import(\"./routes/new.js\");", "app.use(\"/api/new\", mod.default);"],
      ["import router from \"./routes/new.js\";", "app.use(prefix, router);"],
    ];

    for (const lines of variants) {
      expect(() => assertScannerCompatibleAppWiring(lines.join("\n"))).toThrow(/Scanner-incompatible/);
    }
  });

  test("alternate direct Express mutation syntax is rejected", () => {
    expect(unsupportedDirectAppMutationSyntax('app["post"]("/x", handler);')).not.toEqual([]);
    expect(unsupportedDirectAppMutationSyntax('app.route("/x").post(handler);')).not.toEqual([]);
  });
});
