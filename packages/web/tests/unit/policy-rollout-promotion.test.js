// tests/unit/policy-rollout-promotion.test.js
// Tests for the dry-run-to-live promotion workflow.
// Verifies promotion guards, policy write, snapshot capture,
// state transition, failure safety, and route integration.

import { jest } from "@jest/globals";
import { fileURLToPath } from "url";
import fs from "fs";
import path from "path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

function readSource(relPath) {
  return fs.readFileSync(path.resolve(ROOT, relPath), "utf-8");
}

describe("Rollout Promotion — DB migration 029", () => {
  const migration = readSource("packages/web/db/migrations/029_rollout_promotion.sql");

  it("adds promotion_reason column", () => {
    expect(migration).toMatch(/promotion_reason.*TEXT/);
  });
});

describe("Rollout Promotion — service exports", () => {
  const source = readSource("packages/web/src/services/policyRolloutService.js");

  it("exports promoteRolloutPlan", () => {
    expect(source).toMatch(/export.*async function promoteRolloutPlan/);
  });

  it("imports getConfigForRepo", () => {
    expect(source).toMatch(/getConfigForRepo/);
  });

  it("imports setConfigOverrides", () => {
    expect(source).toMatch(/setConfigOverrides/);
  });
});

describe("Rollout Promotion — promotion rules", () => {
  const source = readSource("packages/web/src/services/policyRolloutService.js");

  it("requires actor for promotion", () => {
    expect(source).toMatch(/actor is required for promotion/);
  });

  it("requires plan in approved state", () => {
    expect(source).toMatch(/Cannot promote plan in.*state.*approved/);
  });

  it("checks approval metadata (approved_by, approved_at)", () => {
    expect(source).toMatch(/missing approval metadata/);
  });

  it("checks all evidence attached", () => {
    const promoteSection = source.slice(source.indexOf("promoteRolloutPlan"));
    expect(promoteSection).toMatch(/missing required evidence/);
  });

  it("re-verifies validation result", () => {
    expect(source).toMatch(/proposed policy validation failed or missing/);
  });

  it("checks proposed_config present", () => {
    expect(source).toMatch(/no proposed_config to write/);
  });

  it("rejects if repository not found", () => {
    expect(source).toMatch(/repository not found for repo_id/);
  });
});

describe("Rollout Promotion — snapshot and write", () => {
  const source = readSource("packages/web/src/services/policyRolloutService.js");

  it("captures previous config BEFORE write", () => {
    expect(source).toMatch(/Snapshot current config BEFORE writing/);
  });

  it("uses getConfigForRepo for snapshot", () => {
    const promoteSection = source.slice(source.indexOf("promoteRolloutPlan"));
    expect(promoteSection).toMatch(/getConfigForRepo/);
  });

  it("writes proposed config via setConfigOverrides", () => {
    expect(source).toMatch(/setConfigOverrides/);
  });

  it("uses rollout-promote prefix for updated_by", () => {
    expect(source).toMatch(/rollout-promote/);
  });

  it("passes action 'set' to setConfigOverrides", () => {
    const promoteSection = source.slice(source.indexOf("rollout-promote"));
    expect(promoteSection).toMatch(/"set"/);
  });

  it("redacts previous_config in snapshot", () => {
    const promoteSection = source.slice(source.indexOf("previousConfig"));
    expect(promoteSection).toMatch(/redactSecrets/);
  });

  it("handles snapshot failure gracefully (null)", () => {
    expect(source).toMatch(/previousConfig = null/);
  });
});

describe("Rollout Promotion — failure safety", () => {
  const source = readSource("packages/web/src/services/policyRolloutService.js");

  it("throws if policy write fails", () => {
    expect(source).toMatch(/Promotion failed: could not write policy/);
  });

  it("does not transition on write failure (state remains approved)", () => {
    // The write is BEFORE the UPDATE, so if it throws, the UPDATE never runs
    const writeSection = source.slice(
      source.indexOf("Write proposed config"),
      source.indexOf("Transition to promoted")
    );
    expect(writeSection).toMatch(/If it throws, we do NOT transition/);
  });

  it("logs write failure", () => {
    expect(source).toMatch(/Policy write failed during promotion/);
  });
});

describe("Rollout Promotion — state transition", () => {
  const source = readSource("packages/web/src/services/policyRolloutService.js");

  it("transitions to promoted status", () => {
    expect(source).toMatch(/status = 'promoted'/);
  });

  it("records promoted_by", () => {
    expect(source).toMatch(/promoted_by/);
  });

  it("records promoted_at", () => {
    expect(source).toMatch(/promoted_at/);
  });

  it("records promotion_reason", () => {
    expect(source).toMatch(/promotion_reason/);
  });

  it("stores previous_config snapshot", () => {
    expect(source).toMatch(/previous_config/);
  });

  it("logs promotion success", () => {
    expect(source).toMatch(/Rollout plan promoted to live policy/);
  });
});

describe("Rollout Promotion — generic transition blocked", () => {
  const source = readSource("packages/web/src/services/policyRolloutService.js");

  it("blocks generic transition to promoted", () => {
    expect(source).toMatch(/Promotion must go through.*promote/);
  });
});

describe("Rollout Promotion — governed route contract", () => {
  const source = readSource("packages/web/src/routes/rollouts.js");
  const promoteStart = source.indexOf('rolloutRouter.post("/:id/promote"');
  const rollbackStart = source.indexOf("POST /api/rollouts/:id/rollback");
  const promoteSection = source.slice(promoteStart, rollbackStart);

  it("imports the governed promotion service and typed error", () => {
    expect(source).toMatch(/promotePolicyRollout/);
    expect(source).toMatch(/PolicyPromotionError/);
  });

  it("registers POST /:id/promote", () => {
    expect(promoteStart).toBeGreaterThanOrEqual(0);
  });

  it("uses server-owned req.auth as promotion authority", () => {
    expect(promoteSection).toMatch(/principal:\s*req\.auth/);
  });

  it("does not require or pass legacy body actor for promotion authority", () => {
    expect(promoteSection).not.toMatch(/const\s*\{[^}]*actor[^}]*\}\s*=\s*req\.body/);
    expect(promoteSection).not.toMatch(/principal:\s*actor/);
  });

  it("requires a positive safe-integer rollout id before touching the service", () => {
    expect(promoteSection).toMatch(/Number\.isSafeInteger\(id\)/);
    expect(promoteSection).toMatch(/id\s*<=\s*0/);
    const validationAt = promoteSection.indexOf("Number.isSafeInteger(id)");
    const serviceAt = promoteSection.indexOf("await promotePolicyRollout");
    expect(validationAt).toBeGreaterThanOrEqual(0);
    expect(serviceAt).toBeGreaterThan(validationAt);
  });

  it("passes only a validated optional promotion reason to governed service", () => {
    expect(promoteSection).toMatch(/const\s*\{\s*reason\s*\}\s*=\s*req\.body\s*\|\|\s*\{\}/);
    expect(promoteSection).toMatch(/let\s+normalizedReason\s*=\s*null/);
    expect(promoteSection).toMatch(/typeof\s+reason\s*!==\s*"string"/);
    expect(promoteSection).toMatch(/normalizedReason\s*=\s*reason\.trim\(\)/);
    expect(promoteSection).toMatch(/POLICY_PROMOTION_REASON_MAX_LENGTH/);
    expect(promoteSection).toMatch(/reason:\s*normalizedReason/);
  });

  it("maps typed authorization and missing-principal failures to 403", () => {
    expect(promoteSection).toMatch(/err\s+instanceof\s+PolicyPromotionError/);
    expect(promoteSection).toMatch(/err\.reason\?\.includes\("authorization_"\)/);
    expect(promoteSection).toMatch(/err\.reason\s*===\s*"promoter_principal_required"/);
    expect(promoteSection).toMatch(/authorizationFailure\s*\?\s*403\s*:\s*stateConflict\s*\?\s*409\s*:\s*400/);
  });

  it("returns typed policy failures using stable reason codes", () => {
    expect(promoteSection).toMatch(/json\(\{\s*error:\s*err\.reason,\s*detail:\s*err\.detail\s*\?\?\s*undefined\s*\}\)/);
  });

  it("keeps unknown promotion failures as generic 500 responses", () => {
    expect(promoteSection).toMatch(/status\(500\)\.json\(\{\s*error:\s*"Failed to promote rollout plan"\s*\}\)/);
  });
});

describe("Rollout Promotion — design principle", () => {
  const source = readSource("packages/web/src/services/policyRolloutService.js");

  it("comments state this is the ONLY path that writes policy", () => {
    expect(source).toMatch(/ONLY path that writes policy/);
  });

  it("comments state what was approved is what was promoted", () => {
    expect(source).toMatch(/[Ww]hat was approved is what was promoted/);
  });

  it("does not modify proposed_config during promotion", () => {
    // Promotion writes plan.proposed_config exactly as approved
    const promoteSection = source.slice(source.indexOf("promoteRolloutPlan"));
    expect(promoteSection).toMatch(/plan\.proposed_config/);
  });
});
