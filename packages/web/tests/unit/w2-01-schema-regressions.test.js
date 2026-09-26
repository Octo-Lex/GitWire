// Focused schema regressions discovered during W2-01 first-party review.

import { jest } from "@jest/globals";
import { fileURLToPath } from "url";
import fs from "fs";
import path from "path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const migration = fs.readFileSync(
  path.resolve(ROOT, "packages/web/db/migrations/045_w2_policy_authority.sql"),
  "utf-8",
);

describe("W2-01 schema exactness regressions", () => {
  test("rollout authority foreign key matches legacy BIGSERIAL width", () => {
    expect(migration).toMatch(/rollout_plan_id\s+BIGINT NOT NULL/);
    expect(migration).not.toMatch(/rollout_plan_id\s+INTEGER NOT NULL/);
  });

  test("approved evidence manifest contains exactly the four required entries", () => {
    expect(migration).toMatch(/jsonb_array_length\(NEW\.evidence_manifest\) <> 4/);
    expect(migration).toMatch(/v_evidence_count <> 4/);
  });

  test("policy version cannot name itself as its base", () => {
    expect(migration).toMatch(/base_policy_version_id IS NULL OR base_policy_version_id <> id/);
  });

  test("all W2-01 trigger functions pin deterministic search paths", () => {
    const functionCount = (migration.match(/CREATE FUNCTION (?:prepare_w2_policy_|enforce_w2_policy_)/g) || []).length;
    const searchPathCount = (migration.match(/SET search_path = public, pg_catalog, pg_temp/g) || []).length;
    expect(functionCount).toBe(4);
    expect(searchPathCount).toBe(4);
  });
});
