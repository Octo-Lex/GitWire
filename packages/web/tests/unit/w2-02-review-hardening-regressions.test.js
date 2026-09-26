// W2-02 exact-head review hardening regressions.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../../..");
const migration45 = readFileSync(
  path.join(repoRoot, "packages/web/db/migrations/045_w2_policy_authority.sql"),
  "utf8",
);
const migration46 = readFileSync(
  path.join(repoRoot, "packages/web/db/migrations/046_w2_policy_promotion.sql"),
  "utf8",
);
const service = readFileSync(
  path.join(repoRoot, "packages/web/src/services/policyPromotionService.js"),
  "utf8",
);

describe("W2-02 review hardening", () => {
  test("database binds each promotion to the rollout plan owned by its change request", () => {
    expect(migration46).toContain("uq_policy_change_requests_rollout_binding");
    expect(migration46).toMatch(/UNIQUE \(id, rollout_plan_id\)/);
    expect(migration46).toContain("fk_policy_promotion_change_rollout");
    expect(migration46).toMatch(
      /FOREIGN KEY \(change_request_id, rollout_plan_id\)[\s\S]*REFERENCES policy_change_requests\(id, rollout_plan_id\)/,
    );
  });

  test("duplicate promotion records remain storage-blocked", () => {
    expect(migration46).toMatch(/UNIQUE \(change_request_id\)/);
    expect(migration46).toMatch(/UNIQUE \(policy_version_id\)/);
  });

  test("approval expiry uses one explicit transaction-start authority snapshot", () => {
    expect(migration46).toContain("Approval expiry intentionally uses NOW(), PostgreSQL's transaction-start");
    expect(migration46).toMatch(/v_expires_at <= NOW\(\)/);
  });

  test("promotion and approval insertion serialize on the same change-request row", () => {
    const envelopeStart = service.indexOf("async function loadPromotionEnvelope");
    const envelopeEnd = service.indexOf("async function loadAuthorityEvidenceAndApprovals");
    const envelopeSection = service.slice(envelopeStart, envelopeEnd);
    expect(envelopeSection).toMatch(/FROM policy_change_requests cr[\s\S]*FOR UPDATE OF cr, p/);

    const approvalStart = migration45.indexOf("CREATE FUNCTION prepare_w2_policy_approval_insert");
    const approvalEnd = migration45.indexOf("CREATE TRIGGER trg_policy_approvals_prepare_insert");
    const approvalSection = migration45.slice(approvalStart, approvalEnd);
    expect(approvalSection).toMatch(/FROM policy_change_requests[\s\S]*FOR UPDATE/);
  });
});
