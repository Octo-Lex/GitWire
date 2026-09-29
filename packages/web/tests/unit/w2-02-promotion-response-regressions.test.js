// W2-02 post-commit response and conflict-semantics regressions.

import { fileURLToPath } from "url";
import fs from "fs";
import path from "path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

function readSource(relPath) {
  return fs.readFileSync(path.resolve(ROOT, relPath), "utf-8");
}

describe("W2-02 governed promotion acknowledgment", () => {
  const routeSource = readSource("packages/web/src/routes/rollouts.js");
  const promoteStart = routeSource.indexOf('rolloutRouter.post("/:id/promote"');
  const rollbackStart = routeSource.indexOf("POST /api/rollouts/:id/rollback");
  const promoteSection = routeSource.slice(promoteStart, rollbackStart);

  test("does not report a durable promotion as failed when the post-commit response refresh fails", () => {
    expect(promoteSection).toMatch(/const committed = await promotePolicyRollout/);
    expect(promoteSection).toMatch(/try\s*\{[\s\S]*const plan = await getRolloutPlan\(id\)/);
    expect(promoteSection).toMatch(/catch \(readErr\)[\s\S]*Governed promotion committed but rollout response refresh failed/);
    expect(promoteSection).toMatch(/return res\.json\(committed\.rollout\)/);
  });

  test("maps replay and stale-state promotion failures to HTTP 409", () => {
    expect(routeSource).toMatch(/POLICY_PROMOTION_CONFLICT_REASONS = new Set/);
    for (const reason of [
      "rollout_state_disallows_promotion",
      "rollout_state_changed_during_promotion",
      "stale_policy_base",
      "first_governed_promotion_requires_null_base",
      "active_policy_materialization_drift",
      "repository_binding_changed",
    ]) {
      expect(routeSource).toContain(`"${reason}"`);
    }
    expect(promoteSection).toMatch(/stateConflict \? 409 : 400/);
  });
});

describe("W2-02 cache convergence boundary", () => {
  const configSource = readSource("packages/web/src/services/configService.js");

  test("config cache is bounded to five minutes and invalidation exceptions are non-fatal", () => {
    expect(configSource).toMatch(/const CACHE_TTL = 300/);
    const invalidateStart = configSource.indexOf("export async function invalidateConfigCache");
    const historyStart = configSource.indexOf("export async function getConfigHistory");
    const invalidateSection = configSource.slice(invalidateStart, historyStart);
    expect(invalidateSection).toMatch(/try\s*\{[\s\S]*await redis\.del/);
    expect(invalidateSection).toMatch(/catch \(err\)[\s\S]*Failed to invalidate config cache/);
  });
});
