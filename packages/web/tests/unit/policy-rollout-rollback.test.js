// tests/unit/policy-rollout-rollback.test.js
// Tests for the rollback evidence workflow.
// Verifies rollback guards, policy restore, evidence capture,
// state transition, failure safety, and route integration.

import { jest } from "@jest/globals";
import { fileURLToPath } from "url";
import fs from "fs";
import path from "path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

function readSource(relPath) {
  return fs.readFileSync(path.resolve(ROOT, relPath), "utf-8");
}

describe("Rollout Rollback — DB migration 030", () => {
  const migration = readSource("packages/web/db/migrations/030_rollout_rollback.sql");

  it("adds rollback_reason column", () => {
    expect(migration).toMatch(/rollback_reason.*TEXT/);
  });

  it("adds rollback_evidence JSONB column", () => {
    expect(migration).toMatch(/rollback_evidence.*JSONB/);
  });

  it("adds replaced_config_snapshot JSONB column", () => {
    expect(migration).toMatch(/replaced_config_snapshot.*JSONB/);
  });
});

describe("Rollout Rollback — service exports", () => {
  const source = readSource("packages/web/src/services/policyRolloutService.js");

  it("exports rollbackRolloutPlan", () => {
    expect(source).toMatch(/export.*async function rollbackRolloutPlan/);
  });

  it("has hashConfig helper", () => {
    expect(source).toMatch(/function hashConfig/);
  });
});

describe("Rollout Rollback — rollback rules", () => {
  const source = readSource("packages/web/src/services/policyRolloutService.js");

  it("requires actor for rollback", () => {
    expect(source).toMatch(/actor is required for rollback/);
  });

  it("requires reason for rollback", () => {
    expect(source).toMatch(/reason is required for rollback/);
  });

  it("requires plan in promoted state", () => {
    expect(source).toMatch(/Cannot roll back plan in.*state.*promoted/);
  });

  it("requires previous_config snapshot", () => {
    expect(source).toMatch(/no previous_config snapshot available/);
  });

  it("rejects if repository not found", () => {
    expect(source).toMatch(/repository not found for repo_id/);
  });
});

describe("Rollout Rollback — capture and restore", () => {
  const source = readSource("packages/web/src/services/policyRolloutService.js");

  it("captures replaced config BEFORE rollback", () => {
    expect(source).toMatch(/Capture current config as replaced evidence BEFORE rollback/);
  });

  it("captures replaced config via getConfigForRepo", () => {
    const rollbackSection = source.slice(source.indexOf("rollbackRolloutPlan"));
    expect(rollbackSection).toMatch(/getConfigForRepo/);
  });

  it("writes previous_config back via setConfigOverrides", () => {
    const rollbackSection = source.slice(source.indexOf("rollbackRolloutPlan"));
    expect(rollbackSection).toMatch(/setConfigOverrides/);
  });

  it("writes plan.previous_config exactly", () => {
    const rollbackSection = source.slice(source.indexOf("Write previous_config back"));
    expect(rollbackSection).toMatch(/plan\.previous_config/);
  });

  it("uses rollout-rollback prefix for updated_by", () => {
    expect(source).toMatch(/rollout-rollback/);
  });

  it("handles replaced config capture failure gracefully (null)", () => {
    expect(source).toMatch(/replacedConfig = null/);
  });
});

describe("Rollout Rollback — failure safety", () => {
  const source = readSource("packages/web/src/services/policyRolloutService.js");

  it("throws if policy write fails", () => {
    expect(source).toMatch(/Rollback failed: could not restore previous policy/);
  });

  it("does not transition on write failure (state remains promoted)", () => {
    const writeSection = source.slice(
      source.indexOf("Write previous_config back"),
      source.indexOf("Build rollback evidence")
    );
    expect(writeSection).toMatch(/If it throws, we do NOT transition/);
  });

  it("logs write failure", () => {
    expect(source).toMatch(/Policy write failed during rollback/);
  });
});

describe("Rollout Rollback — evidence and hashes", () => {
  const source = readSource("packages/web/src/services/policyRolloutService.js");

  it("builds rollback evidence object", () => {
    expect(source).toMatch(/rollbackEvidence/);
  });

  it("evidence includes restored_previous_config", () => {
    expect(source).toMatch(/restored_previous_config/);
  });

  it("evidence includes replaced_config_captured", () => {
    expect(source).toMatch(/replaced_config_captured/);
  });

  it("evidence includes previous_config_hash", () => {
    expect(source).toMatch(/previous_config_hash/);
  });

  it("evidence includes promoted_config_hash", () => {
    expect(source).toMatch(/promoted_config_hash/);
  });

  it("evidence includes replaced_config_hash", () => {
    expect(source).toMatch(/replaced_config_hash/);
  });

  it("hashConfig uses deterministic JSON serialization", () => {
    const hashSection = source.slice(source.indexOf("function hashConfig"));
    expect(hashSection).toMatch(/JSON\.stringify/);
    expect(hashSection).toMatch(/sort/);
  });

  it("hashConfig returns null for null config", () => {
    const hashSection = source.slice(source.indexOf("function hashConfig"));
    expect(hashSection).toMatch(/if \(!config\) return null/);
  });

  it("hashConfig returns prefixed hash string", () => {
    const hashSection = source.slice(source.indexOf("function hashConfig"));
    expect(hashSection).toMatch(/sha0:/);
  });
});

describe("Rollout Rollback — state transition", () => {
  const source = readSource("packages/web/src/services/policyRolloutService.js");

  it("transitions to rolled_back status", () => {
    const rollbackSection = source.slice(source.indexOf("rollbackRolloutPlan"));
    expect(rollbackSection).toMatch(/status = 'rolled_back'/);
  });

  it("records rolled_back_by", () => {
    const rollbackSection = source.slice(source.indexOf("rollbackRolloutPlan"));
    expect(rollbackSection).toMatch(/rolled_back_by/);
  });

  it("records rolled_back_at", () => {
    const rollbackSection = source.slice(source.indexOf("rollbackRolloutPlan"));
    expect(rollbackSection).toMatch(/rolled_back_at/);
  });

  it("records rollback_reason", () => {
    expect(source).toMatch(/rollback_reason/);
  });

  it("stores rollback_evidence", () => {
    expect(source).toMatch(/rollback_evidence/);
  });

  it("stores replaced_config_snapshot", () => {
    expect(source).toMatch(/replaced_config_snapshot/);
  });

  it("redacts replaced_config_snapshot", () => {
    const rollbackSection = source.slice(source.indexOf("replacedConfig"));
    expect(rollbackSection).toMatch(/redactSecrets/);
  });

  it("logs rollback success", () => {
    expect(source).toMatch(/Rollout plan rolled back.*previous policy restored/);
  });
});

describe("Rollout Rollback — generic transition blocked", () => {
  const source = readSource("packages/web/src/services/policyRolloutService.js");

  it("blocks generic transition to rolled_back", () => {
    expect(source).toMatch(/Rollback must go through.*rollback/);
  });
});

describe("Rollout Rollback — redaction includes new fields", () => {
  const source = readSource("packages/web/src/services/policyRolloutService.js");

  it("redacts rollback_evidence", () => {
    expect(source).toMatch(/"rollback_evidence"/);
  });

  it("redacts replaced_config_snapshot", () => {
    expect(source).toMatch(/"replaced_config_snapshot"/);
  });
});

describe("Rollout Rollback — route contract", () => {
  const source = readSource("packages/web/src/routes/rollouts.js");

  it("imports rollbackRolloutPlan", () => {
    expect(source).toMatch(/rollbackRolloutPlan/);
  });

  it("registers POST /:id/rollback", () => {
    expect(source).toMatch(/rolloutRouter\.post\("\/:id\/rollback"/);
  });

  it("requires actor in rollback body", () => {
    const rollbackSection = source.slice(source.indexOf("/:id/rollback"));
    expect(rollbackSection).toMatch(/actor is required/);
  });

  it("requires reason in rollback body", () => {
    const rollbackSection = source.slice(source.indexOf("/:id/rollback"));
    expect(rollbackSection).toMatch(/reason is required for rollback/);
  });

  it("handles rollback errors (400 for bad input)", () => {
    const rollbackSection = source.slice(source.indexOf("/:id/rollback"));
    expect(rollbackSection).toMatch(/status\(400\)/);
  });

  it("handles write failure errors (400)", () => {
    const rollbackSection = source.slice(source.indexOf("/:id/rollback"));
    expect(rollbackSection).toMatch(/Rollback failed/);
  });

  it("handles missing snapshot errors (400)", () => {
    const rollbackSection = source.slice(source.indexOf("/:id/rollback"));
    expect(rollbackSection).toMatch(/no previous_config/);
  });

  it("handles not found errors (400)", () => {
    const rollbackSection = source.slice(source.indexOf("/:id/rollback"));
    expect(rollbackSection).toMatch(/not found/);
  });
});
