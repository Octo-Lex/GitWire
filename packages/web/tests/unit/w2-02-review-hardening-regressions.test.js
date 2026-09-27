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
const authorize = readFileSync(
  path.join(repoRoot, "packages/web/src/services/auth/authorize.js"),
  "utf8",
);
const principalResolver = readFileSync(
  path.join(repoRoot, "packages/web/src/services/auth/principalResolver.js"),
  "utf8",
);
const promotionWorkflow = readFileSync(
  path.join(repoRoot, ".github/workflows/w2-policy-promotion-db.yml"),
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

  test("approval expiry uses wall-clock authority in service and storage backstop", () => {
    expect(migration46).toContain("Approval expiry uses clock_timestamp(), PostgreSQL wall-clock time");
    expect(migration46).toMatch(/v_expires_at <= clock_timestamp\(\)/);
    expect(service).toMatch(/expires_at > clock_timestamp\(\)\) AS temporally_valid/);
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

  test("central authorization holds active role authority through an effect transaction", () => {
    expect(principalResolver).toContain('lockAuthorityRows ? " FOR SHARE" : ""');
    expect(authorize).toContain('lockAuthorityRows ? " FOR SHARE OF apr, ar, arp" : ""');
    expect(authorize).toContain("JOIN gitwire_auth.auth_roles ar ON ar.id = apr.role_id AND ar.status = 'active'");
    expect(authorize).toContain("authority_lock_requires_transaction_queryable");
    expect(authorize).toMatch(/getPrincipalById\(principal\.principalId, \{[\s\S]*queryable,[\s\S]*lockAuthorityRows/);
  });

  test("promotion authorizes promoter and approver under the repository mutex and same transaction", () => {
    const txStart = service.indexOf("const result = await db.transaction");
    const repositoryLock = service.indexOf("await lockActivePolicyState", txStart);
    const promoterAuthorization = service.indexOf('label: "promoter"', txStart);
    const envelopeRead = service.indexOf("const envelope = await loadPromotionEnvelope", txStart);

    expect(txStart).toBeGreaterThanOrEqual(0);
    expect(repositoryLock).toBeGreaterThan(txStart);
    expect(promoterAuthorization).toBeGreaterThan(repositoryLock);
    expect(envelopeRead).toBeGreaterThan(promoterAuthorization);

    const transactionSection = service.slice(txStart);
    expect(transactionSection).toMatch(
      /label: "promoter",[\s\S]*queryable: tx,[\s\S]*lockAuthorityRows: true/,
    );
    expect(transactionSection).toMatch(
      /selectCurrentAuthorizedApproval\(\{[\s\S]*queryable: tx,[\s\S]*lockAuthorityRows: true/,
    );
  });

  test("dedicated Postgres evidence reruns when production promotion dependencies change", () => {
    for (const watchedPath of [
      "packages/web/src/services/policyPromotionService.js",
      "packages/web/src/routes/rollouts.js",
      "packages/web/src/services/auth/authorize.js",
      "packages/web/src/services/auth/principalResolver.js",
      "packages/web/src/services/configService.js",
      "packages/web/src/services/policyRolloutService.js",
      "packages/web/tests/integration/w2-02-policy-promotion-authority-races-db.mjs",
    ]) {
      expect(promotionWorkflow).toContain(`- '${watchedPath}'`);
    }
  });
});
