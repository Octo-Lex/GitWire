// W2-03 direct-policy writer shutdown proofs.
//
// Keep source checks cheap and deterministic while exercising the production
// compatibility API guard directly. The real PostgreSQL workflow proves the
// storage boundary and full governed lifecycle.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { directPolicyWriteGuard } from "../../src/middleware/directPolicyWriteGuard.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const read = (relativePath) => fs.readFileSync(path.join(repoRoot, relativePath), "utf8");

function runGuard(method, requestPath) {
  let statusCode = null;
  let body = null;
  let nextCalled = false;
  const res = {
    status(code) {
      statusCode = code;
      return this;
    },
    json(value) {
      body = value;
      return value;
    },
  };

  directPolicyWriteGuard(
    { method, path: requestPath },
    res,
    () => { nextCalled = true; },
  );

  return { statusCode, body, nextCalled };
}

describe("W2-03 direct config API guard", () => {
  test.each(["PUT", "PATCH", "DELETE"])("%s direct config mutation fails closed", (method) => {
    const result = runGuard(method, "/owner/repo");
    expect(result.nextCalled).toBe(false);
    expect(result.statusCode).toBe(409);
    expect(result.body).toEqual({
      error: "direct_policy_write_disabled",
      message: "Live policy changes must use the governed rollout workflow.",
    });
  });

  test("config-history restore fails closed", () => {
    const result = runGuard("POST", "/owner/repo/restore/42");
    expect(result.nextCalled).toBe(false);
    expect(result.statusCode).toBe(409);
    expect(result.body?.error).toBe("direct_policy_write_disabled");
  });

  // Express routing is case-insensitive and decodes path parameters, so the
  // guard's restore check must match every encoding/casing the route matches.
  test.each([
    ["/owner/repo/RESTORE/42", "uppercase segment"],
    ["/owner/repo/Restore/42", "mixed-case segment"],
    ["/owner/repo/restore/42/", "trailing slash"],
    ["/owner/repo/restore/42?dry_run=1", "query string"],
    ["/owner/repo/restore%2F42", "percent-encoded id separator"],
    ["/owner/repo/restore/%77", "percent-encoded id body"],
    ["/owner/repo/restore/%", "malformed percent-encoding fails closed"],
  ])("POST %s (%s) cannot bypass the restore block", (requestPath) => {
    const result = runGuard("POST", requestPath);
    expect(result.nextCalled).toBe(false);
    expect(result.statusCode).toBe(409);
    expect(result.body?.error).toBe("direct_policy_write_disabled");
  });

  test("malformed percent-encoding on a read path still reaches the router", () => {
    const result = runGuard("GET", "/owner/repo/history%");
    expect(result.nextCalled).toBe(true);
    expect(result.statusCode).toBeNull();
  });

  test.each([
    ["GET", "/owner/repo"],
    ["GET", "/owner/repo/history"],
    ["POST", "/validate"],
    ["POST", "/simulate"],
    ["POST", "/diff-impact"],
    ["POST", "/recommendations"],
    ["POST", "/playground"],
  ])("%s %s remains available to the compatibility router", (method, requestPath) => {
    const result = runGuard(method, requestPath);
    expect(result.nextCalled).toBe(true);
    expect(result.statusCode).toBeNull();
    expect(result.body).toBeNull();
  });
});

describe("W2-03 governed policy writer cutover", () => {
  test("public rollout routes use governed W2-01-backed writers and fail legacy rollback closed", () => {
    const source = read("packages/web/src/routes/rollouts.js");

    expect(source).toContain('from "../services/governedPolicyWriterService.js"');
    expect(source).toContain("createGovernedRolloutPlan");
    expect(source).toContain("attachGovernedRolloutEvidence");
    expect(source).toContain("transitionGovernedRolloutPlan");
    expect(source).toContain("approveGovernedRolloutPlan");
    expect(source).toContain("rejectGovernedRolloutPlan");
    expect(source).not.toMatch(/\bpromoteRolloutPlan\s*\(/);
    expect(source).not.toMatch(/\brollbackRolloutPlan\s*\(/);
    expect(source).toContain('error: "legacy_policy_rollback_disabled"');
  });

  test("direct config mutation guard is mounted router-level before the compatibility routes", () => {
    const appSource = read("packages/web/src/app.js");
    const configSource = read("packages/web/src/routes/config.js");
    const guardMount = configSource.indexOf("configRouter.use(directPolicyWriteGuard)");
    const firstRoute = configSource.indexOf("configRouter.get(");
    const guardSource = read("packages/web/src/middleware/directPolicyWriteGuard.js");

    // Router-level mount keeps app.js limited to scanner-parseable route mounts.
    expect(guardMount).toBeGreaterThan(-1);
    expect(firstRoute).toBeGreaterThan(guardMount);
    expect(configSource).toContain('from "../middleware/directPolicyWriteGuard.js"');
    expect(appSource).not.toContain("directPolicyWriteGuard");
    expect(guardSource).toContain('method === "PUT"');
    expect(guardSource).toContain('method === "PATCH"');
    expect(guardSource).toContain('method === "DELETE"');
    expect(guardSource).toContain("restore");
    expect(guardSource).toContain('error: "direct_policy_write_disabled"');
  });

  test("dashboard config surface is read-only and points to governed rollouts", () => {
    const source = read("packages/web-dashboard/src/app/config/page.tsx");

    expect(source).toContain("Governed live policy — read only");
    expect(source).toContain('href="/rollouts"');
    expect(source).not.toContain("patchRepoConfig");
    expect(source).not.toContain("resetRepoConfig");
    expect(source).not.toContain("restoreConfigVersion");
    expect(source).not.toContain("handleRestore");
    expect(source).not.toContain("handleReset");
  });

  test("storage backstop is deferred and validates the complete governed effect bundle", () => {
    const source = read("packages/web/db/migrations/047_governed_policy_writers.sql");

    expect(source).toContain("DEFERRABLE INITIALLY DEFERRED");
    expect(source).toContain("active_policy_bindings");
    expect(source).toContain("policy_promotion_records");
    expect(source).toContain("policy_versions");
    expect(source).toContain("policy_rollout_plans");
    expect(source).toContain("config_history");
    expect(source).toContain("live policy materialization lacks governed active-policy authority");
    expect(source).toContain("direct live-policy deletion is disabled");
  });

  test("governed rollout creation derives base from active binding server-side", () => {
    const source = read("packages/web/src/services/governedPolicyWriterService.js");

    expect(source).toContain("FROM active_policy_bindings");
    expect(source).toContain("FOR SHARE");
    expect(source).toContain("basePolicyVersionId: active?.policy_version_id ?? null");
    expect(source).toContain("createPolicyChangeRequestForRollout");
    expect(source).toContain("appendPolicyEvidenceForRollout");
    expect(source).toContain("recordPolicyApprovalForRollout");
  });
});
