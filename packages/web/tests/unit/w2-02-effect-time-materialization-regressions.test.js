// W2-02 effect-time materialization source regressions.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../../..");
const migration = readFileSync(
  path.join(repoRoot, "packages/web/db/migrations/046_w2_policy_promotion.sql"),
  "utf8",
);

describe("W2-02 promotion effect-time materialization", () => {
  test("rollout audit clocks inherit immutable promotion time only for governed promotion", () => {
    expect(migration).toContain("OLD.status IS DISTINCT FROM 'promoted'");
    expect(migration).toContain("FROM policy_promotion_records");
    expect(migration).toContain("NEW.promoted_at := v_promotion_time");
    expect(migration).toContain("NEW.updated_at := v_promotion_time");
    expect(migration).toContain("NEW.updated_at := NOW()");
  });

  test("finalization validates immutable audit identity before stamping compatibility rows", () => {
    expect(migration).toContain("NEW.promoted_at IS DISTINCT FROM v_promotion.promoted_at");
    expect(migration).toContain("NEW.promoted_by IS DISTINCT FROM v_promotion.promoter_principal_id::text");
    expect(migration).toContain("'policy-promotion:%s:%s'");
  });

  test("repo config and config history receive the exact immutable effect time", () => {
    expect(migration).toMatch(/UPDATE repo_config[\s\S]*SET updated_at = v_promotion\.promoted_at/);
    expect(migration).toMatch(/UPDATE config_history[\s\S]*SET changed_at = v_promotion\.promoted_at/);
    expect(migration).toContain("v_repo_config_rows <> 1");
    expect(migration).toContain("v_history_rows <> 1");
  });

  test("materialization finalizer is limited to the first transition into promoted", () => {
    expect(migration).toContain("trg_rollout_w2_promotion_effect_time");
    expect(migration).toContain("WHEN (NEW.status = 'promoted' AND OLD.status IS DISTINCT FROM 'promoted')");
    expect(migration).toContain("IF NOT FOUND THEN\n    RETURN NEW;");
  });
});
