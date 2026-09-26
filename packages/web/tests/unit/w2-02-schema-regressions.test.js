// W2-02 migration/service contract regressions.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../../..");
const migration = readFileSync(
  path.join(repoRoot, "packages/web/db/migrations/046_w2_policy_promotion.sql"),
  "utf8",
);
const service = readFileSync(
  path.join(repoRoot, "packages/web/src/services/policyPromotionService.js"),
  "utf8",
);
const route = readFileSync(
  path.join(repoRoot, "packages/web/src/routes/rollouts.js"),
  "utf8",
);

describe("W2-02 storage contract", () => {
  test("creates immutable promotion records and one active binding per repository", () => {
    expect(migration).toMatch(/CREATE TABLE policy_promotion_records/);
    expect(migration).toMatch(/CREATE TABLE active_policy_bindings/);
    expect(migration).toMatch(/repo_id\s+BIGINT PRIMARY KEY/);
    expect(migration).toMatch(/UNIQUE \(change_request_id\)/);
    expect(migration).toMatch(/UNIQUE \(policy_version_id\)/);
  });

  test("promotion records bind exact W2-01 request, approval, principals and evidence", () => {
    expect(migration).toContain("fk_policy_promotion_change_binding");
    expect(migration).toContain("fk_policy_promotion_approval_binding");
    expect(migration).toContain("approver_principal_id");
    expect(migration).toContain("promoter_principal_id");
    expect(migration).toContain("evidence_set_hash");
  });

  test("database rejects stale bases, expired/rejected approval and non-valid validation evidence", () => {
    expect(migration).toContain("stale policy promotion base");
    expect(migration).toContain("promotion approval is expired");
    expect(migration).toContain("promotion is blocked by a rejection record");
    expect(migration).toContain("promotion validation evidence is not explicitly valid");
  });

  test("repository row is the storage-level promotion serialization point", () => {
    expect(migration).toMatch(
      /FROM repositories\s+WHERE github_id = NEW\.repo_id\s+FOR UPDATE/s,
    );
  });

  test("promotion history is append-only and active pointer cannot be deleted or truncated", () => {
    expect(migration).toContain("trg_policy_promotion_no_update");
    expect(migration).toContain("trg_policy_promotion_no_delete");
    expect(migration).toContain("trg_policy_promotion_no_truncate");
    expect(migration).toContain("trg_active_policy_binding_no_delete");
    expect(migration).toContain("trg_active_policy_binding_no_truncate");
  });

  test("trigger functions pin pg_catalog before mutable schemas", () => {
    const matches = migration.match(/SET search_path = pg_catalog, public, pg_temp/g) || [];
    expect(matches.length).toBeGreaterThanOrEqual(3);
  });
});

describe("W2-02 service boundary", () => {
  test("uses the central enforced authorization engine and does not seed permissions", () => {
    expect(service).toContain('permission: POLICY_PROMOTION_PERMISSION');
    expect(service).toContain('mode: "enforced"');
    expect(service).toContain("authorization_not_persisted");
    expect(service).not.toMatch(/INSERT INTO gitwire_auth\.auth_role_permissions/);
  });

  test("serializes on repository before the authority write and atomically materializes live policy", () => {
    const lockAt = service.indexOf("await lockActivePolicyState");
    const envelopeAt = service.indexOf("const envelope = await loadPromotionEnvelope", lockAt);
    const promotionAt = service.indexOf("INSERT INTO policy_promotion_records");
    const configAt = service.indexOf("INSERT INTO repo_config");
    const bindingAt = service.indexOf("INSERT INTO active_policy_bindings");
    const rolloutAt = service.indexOf("UPDATE policy_rollout_plans");
    expect(lockAt).toBeGreaterThan(0);
    expect(envelopeAt).toBeGreaterThan(lockAt);
    expect(promotionAt).toBeGreaterThan(envelopeAt);
    expect(configAt).toBeGreaterThan(promotionAt);
    expect(bindingAt).toBeGreaterThan(configAt);
    expect(rolloutAt).toBeGreaterThan(bindingAt);
  });

  test("does not call the legacy general config writer", () => {
    expect(service).not.toContain("setConfigOverrides");
    expect(service).toContain("active_policy_materialization_drift");
    expect(service).toContain("stale_policy_base");
  });

  test("promotion route derives authority from req.auth rather than body actor", () => {
    const promoteBlock = route.slice(
      route.indexOf('rolloutRouter.post("/:id/promote"'),
      route.indexOf('rolloutRouter.post("/:id/rollback"'),
    );
    expect(route).toContain('from "../services/policyPromotionService.js"');
    expect(promoteBlock).toContain("principal: req.auth");
    expect(promoteBlock).not.toContain("actor is required");
    expect(promoteBlock).not.toContain("promoteRolloutPlan(");
  });
});
