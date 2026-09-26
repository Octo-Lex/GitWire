// W2-02 schema-contract regressions discovered during final exact-head review.

import { fileURLToPath } from "url";
import fs from "fs";
import path from "path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const migration = fs.readFileSync(
  path.resolve(ROOT, "packages/web/db/migrations/046_w2_policy_promotion.sql"),
  "utf-8",
);

describe("W2-02 schema contract regressions", () => {
  test("both new W2-02 tables include repository-standard created_at timestamps", () => {
    const promotionTable = migration.match(/CREATE TABLE policy_promotion_records \(([\s\S]*?)\n\);/);
    const activeBindingTable = migration.match(/CREATE TABLE active_policy_bindings \(([\s\S]*?)\n\);/);

    expect(promotionTable).not.toBeNull();
    expect(activeBindingTable).not.toBeNull();
    expect(promotionTable[1]).toMatch(/created_at\s+TIMESTAMPTZ NOT NULL DEFAULT NOW\(\)/);
    expect(activeBindingTable[1]).toMatch(/created_at\s+TIMESTAMPTZ NOT NULL DEFAULT NOW\(\)/);
  });

  test("authority identity exception preserves W2-01 UUID and repository-singleton key semantics", () => {
    expect(migration).toMatch(/id\s+UUID PRIMARY KEY DEFAULT gen_random_uuid\(\)/);
    expect(migration).toMatch(/repo_id\s+BIGINT PRIMARY KEY REFERENCES repositories\(github_id\)/);
    expect(migration).toMatch(/Authority identity exception to the general application-table BIGSERIAL/);
  });
});
