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

  test("direct config mutation guard is mounted before the compatibility router", () => {
    const appSource = read("packages/web/src/app.js");
    const guardMount = appSource.indexOf('app.use("/api/config", directPolicyWriteGuard)');
    const routerMount = appSource.indexOf('app.use("/api/config",          configRouter)');
    const guardSource = read("packages/web/src/middleware/directPolicyWriteGuard.js");

    expect(guardMount).toBeGreaterThan(-1);
    expect(routerMount).toBeGreaterThan(guardMount);
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
