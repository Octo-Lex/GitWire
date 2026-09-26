// W2-02 promotion ingress regressions from exact-head review.

import { fileURLToPath } from "url";
import fs from "fs";
import path from "path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const routeSource = fs.readFileSync(
  path.resolve(ROOT, "packages/web/src/routes/rollouts.js"),
  "utf8",
);
const promoteStart = routeSource.indexOf('rolloutRouter.post("/:id/promote"');
const rollbackStart = routeSource.indexOf("POST /api/rollouts/:id/rollback");
const promoteSection = routeSource.slice(promoteStart, rollbackStart);

describe("W2-02 promotion ingress hardening", () => {
  test("parses rollout plan IDs exactly and rejects values outside positive PostgreSQL BIGINT", () => {
    expect(promoteSection).toMatch(/BigInt\(req\.params\.id\)/);
    expect(promoteSection).toMatch(/parsedId <= 0n/);
    expect(promoteSection).toMatch(/parsedId > 9223372036854775807n/);
    expect(promoteSection).toMatch(/id = parsedId\.toString\(\)/);
    expect(promoteSection).toMatch(/status\(400\).*Valid plan ID is required/s);
  });

  test("keeps promotion reason optional but rejects non-string or oversized values", () => {
    expect(promoteSection).toMatch(/reason !== undefined && reason !== null && typeof reason !== "string"/);
    expect(promoteSection).toMatch(/reason must be a string when provided/);
    expect(promoteSection).toMatch(/reason\.length > 2000/);
    expect(promoteSection).toMatch(/reason must be 2000 characters or fewer/);
    expect(promoteSection).toMatch(/reason: reason \|\| null/);
  });
});
