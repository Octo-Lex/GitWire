// D0-04: mounted-route completeness must fail closed when a Router instance
// is aliased before mutation registration, otherwise the source scanner can
// miss consequential routes registered through the alias.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.resolve(TEST_DIR, "../..");
const ROUTES_ROOT = path.join(WEB_ROOT, "src", "routes");

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function routerBindings(source) {
  return [...source.matchAll(
    /(?:^|\n)\s*(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:express\s*\.\s*)?Router\s*\(\s*\)\s*;/g,
  )].map((match) => match[1]);
}

function routerAliasSites(source, sourcePath) {
  const sites = [];

  for (const routerName of routerBindings(source)) {
    const escapedRouter = escapeRegExp(routerName);

    const declarationAliasRe = new RegExp(
      `\\b(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*${escapedRouter}\\b`,
      "g",
    );
    for (const match of source.matchAll(declarationAliasRe)) {
      sites.push(`${sourcePath}:${routerName}->${match[1]}`);
    }

    const assignmentAliasRe = new RegExp(
      `(?:^|[;\\n])\\s*([A-Za-z_$][\\w$]*)\\s*=\\s*${escapedRouter}\\b`,
      "g",
    );
    for (const match of source.matchAll(assignmentAliasRe)) {
      if (match[1] !== routerName) {
        sites.push(`${sourcePath}:${routerName}->${match[1]}`);
      }
    }
  }

  return sites;
}

describe("D0-04 Router alias guard", () => {
  test("route modules do not alias Router instances before registering routes", () => {
    const sites = [];

    for (const fileName of fs.readdirSync(ROUTES_ROOT).filter((name) => name.endsWith(".js"))) {
      const sourcePath = `src/routes/${fileName}`;
      const source = fs.readFileSync(path.join(ROUTES_ROOT, fileName), "utf8");
      sites.push(...routerAliasSites(source, sourcePath));
    }

    expect(sites).toEqual([]);
  });

  test("detects declaration and assignment aliases that could hide mutations", () => {
    const declarationAlias = [
      'import { Router } from "express";',
      "const router = Router();",
      "const mutationRouter = router;",
      'mutationRouter.post("/danger", handler);',
    ].join("\n");

    expect(routerAliasSites(declarationAlias, "src/routes/synthetic.js"))
      .toEqual(["src/routes/synthetic.js:router->mutationRouter"]);

    const assignmentAlias = [
      'import { Router } from "express";',
      "const router = Router();",
      "let mutationRouter;",
      "mutationRouter = router;",
      'mutationRouter.delete("/danger", handler);',
    ].join("\n");

    expect(routerAliasSites(assignmentAlias, "src/routes/synthetic.js"))
      .toEqual(["src/routes/synthetic.js:router->mutationRouter"]);
  });
});
