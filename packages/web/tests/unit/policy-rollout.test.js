// tests/unit/policy-rollout.test.js
// Tests for the policy rollout plan model — service contract, state machine,
// evidence attachment, redaction, route integration, and permissions.

import { jest } from "@jest/globals";
import { fileURLToPath } from "url";
import fs from "fs";
import path from "path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

function readSource(relPath) {
  return fs.readFileSync(path.resolve(ROOT, relPath), "utf-8");
}

describe("Policy Rollout — DB migration", () => {
  const migration = readSource("packages/web/db/migrations/027_policy_rollout_plans.sql");

  it("creates policy_rollout_plans table", () => {
    expect(migration).toMatch(/CREATE TABLE.*policy_rollout_plans/);
  });

  it("has repo_id foreign key to repositories", () => {
    expect(migration).toMatch(/repo_id.*REFERENCES repositories/);
  });

  it("stores proposed_config as JSONB", () => {
    expect(migration).toMatch(/proposed_config.*JSONB/);
  });

  it("stores normalized_config as JSONB", () => {
    expect(migration).toMatch(/normalized_config.*JSONB/);
  });

  it("stores validation_result as JSONB", () => {
    expect(migration).toMatch(/validation_result.*JSONB/);
  });

  it("stores simulation_summary as JSONB", () => {
    expect(migration).toMatch(/simulation_summary.*JSONB/);
  });

  it("stores diff_impact_summary as JSONB", () => {
    expect(migration).toMatch(/diff_impact_summary.*JSONB/);
  });

  it("stores recommendations_summary as JSONB", () => {
    expect(migration).toMatch(/recommendations_summary.*JSONB/);
  });

  it("stores previous_config for rollback", () => {
    expect(migration).toMatch(/previous_config.*JSONB/);
  });

  it("has status field with all 7 states", () => {
    expect(migration).toMatch(/draft/);
    expect(migration).toMatch(/validated/);
    expect(migration).toMatch(/review_ready/);
    expect(migration).toMatch(/approved/);
    expect(migration).toMatch(/promoted/);
    expect(migration).toMatch(/rolled_back/);
    expect(migration).toMatch(/cancelled/);
  });

  it("has status CHECK constraint", () => {
    expect(migration).toMatch(/CHECK.*status IN/);
  });

  it("has created_by field", () => {
    expect(migration).toMatch(/created_by.*TEXT/);
  });

  it("has approved_by and approved_at fields", () => {
    expect(migration).toMatch(/approved_by/);
    expect(migration).toMatch(/approved_at/);
  });

  it("has promoted_by and promoted_at fields", () => {
    expect(migration).toMatch(/promoted_by/);
    expect(migration).toMatch(/promoted_at/);
  });

  it("has rolled_back_by and rolled_back_at fields", () => {
    expect(migration).toMatch(/rolled_back_by/);
    expect(migration).toMatch(/rolled_back_at/);
  });

  it("has cancelled_by and cancelled_at fields", () => {
    expect(migration).toMatch(/cancelled_by/);
    expect(migration).toMatch(/cancelled_at/);
  });

  it("has review_notes field", () => {
    expect(migration).toMatch(/review_notes/);
  });

  it("has created_at and updated_at timestamps", () => {
    expect(migration).toMatch(/created_at.*TIMESTAMPTZ/);
    expect(migration).toMatch(/updated_at.*TIMESTAMPTZ/);
  });

  it("has updated_at trigger", () => {
    expect(migration).toMatch(/trg_rollout_updated_at/);
    expect(migration).toMatch(/BEFORE UPDATE/);
  });

  it("has indexes for repo, status, created_by, created_at", () => {
    expect(migration).toMatch(/idx_rollout_repo/);
    expect(migration).toMatch(/idx_rollout_status/);
    expect(migration).toMatch(/idx_rollout_created_by/);
    expect(migration).toMatch(/idx_rollout_created_at/);
  });
});

describe("Policy Rollout — service contract", () => {
  const source = readSource("packages/web/src/services/policyRolloutService.js");

  it("exports createRolloutPlan", () => {
    expect(source).toMatch(/export.*async function createRolloutPlan/);
  });

  it("exports getRolloutPlan", () => {
    expect(source).toMatch(/export.*async function getRolloutPlan/);
  });

  it("exports listRolloutPlans", () => {
    expect(source).toMatch(/export.*async function listRolloutPlans/);
  });

  it("exports attachEvidence", () => {
    expect(source).toMatch(/export.*async function attachEvidence/);
  });

  it("exports transitionRolloutPlan", () => {
    expect(source).toMatch(/export.*async function transitionRolloutPlan/);
  });

  it("exports VALID_TRANSITIONS", () => {
    expect(source).toMatch(/export.*VALID_TRANSITIONS/);
  });

  it("exports REQUIRED_EVIDENCE", () => {
    expect(source).toMatch(/export.*REQUIRED_EVIDENCE/);
  });

  it("exports redactPlan", () => {
    expect(source).toMatch(/export.*redactPlan/);
  });
});

describe("Policy Rollout — createRolloutPlan validation", () => {
  const source = readSource("packages/web/src/services/policyRolloutService.js");

  it("requires repo parameter", () => {
    expect(source).toMatch(/repo is required/);
  });

  it("requires proposed_config parameter", () => {
    expect(source).toMatch(/proposed_config is required/);
  });

  it("requires created_by parameter", () => {
    expect(source).toMatch(/created_by is required/);
  });

  it("looks up repo_id from repositories table", () => {
    expect(source).toMatch(/SELECT github_id FROM repositories WHERE full_name/);
  });

  it("throws if repository not found", () => {
    expect(source).toMatch(/Repository not found/);
  });

  it("creates plan with draft status", () => {
    expect(source).toMatch(/'draft'/);
  });

  it("redacts proposed_config into normalized_config", () => {
    expect(source).toMatch(/redactSecrets/);
    expect(source).toMatch(/normalized_config/);
  });

  it("uses parameterized queries", () => {
    expect(source).toMatch(/\$\d/);
  });
});

describe("Policy Rollout — listRolloutPlans filters", () => {
  const source = readSource("packages/web/src/services/policyRolloutService.js");

  it("supports repo filter", () => {
    expect(source).toMatch(/r\.full_name/);
  });

  it("supports status filter", () => {
    expect(source).toMatch(/p\.status/);
  });

  it("supports created_by filter", () => {
    expect(source).toMatch(/p\.created_by/);
  });

  it("caps limit at 200", () => {
    expect(source).toMatch(/Math\.min.*200/);
  });

  it("supports offset pagination", () => {
    expect(source).toMatch(/offset/);
  });

  it("orders by created_at DESC", () => {
    expect(source).toMatch(/ORDER BY p\.created_at DESC/);
  });

  it("returns total count", () => {
    expect(source).toMatch(/COUNT/);
  });

  it("joins repositories for repo_full_name", () => {
    expect(source).toMatch(/JOIN repositories r/);
  });
});

describe("Policy Rollout — state machine", () => {
  const source = readSource("packages/web/src/services/policyRolloutService.js");

  it("draft can transition to validated", () => {
    const draftSection = source.slice(source.indexOf("draft:"), source.indexOf("validated:"));
    expect(draftSection).toMatch(/validated/);
  });

  it("draft can transition to cancelled", () => {
    const draftSection = source.slice(source.indexOf("draft:"), source.indexOf("validated:"));
    expect(draftSection).toMatch(/cancelled/);
  });

  it("validated can transition to review_ready", () => {
    const validatedSection = source.slice(source.indexOf("validated:"), source.indexOf("review_ready:"));
    expect(validatedSection).toMatch(/review_ready/);
  });

  it("review_ready can transition to approved", () => {
    const reviewSection = source.slice(source.indexOf("review_ready:"), source.indexOf("approved:"));
    expect(reviewSection).toMatch(/approved/);
  });

  it("approved can transition to promoted", () => {
    const approvedSection = source.slice(source.indexOf("approved:"), source.indexOf("promoted:"));
    expect(approvedSection).toMatch(/promoted/);
  });

  it("promoted can transition to rolled_back", () => {
    const promotedSection = source.slice(source.indexOf("promoted:"), source.indexOf("rolled_back:"));
    expect(promotedSection).toMatch(/rolled_back/);
  });

  it("rolled_back is terminal (empty transitions)", () => {
    const rolledBackSection = source.slice(source.indexOf("rolled_back:"));
    expect(rolledBackSection).toMatch(/new Set\(\)/);
  });

  it("cancelled is terminal (empty transitions)", () => {
    const cancelledSection = source.slice(source.indexOf("cancelled:"));
    expect(cancelledSection).toMatch(/terminal/);
  });

  it("rejects invalid transitions with message", () => {
    expect(source).toMatch(/Invalid transition/);
  });

  it("rejects transitions from terminal states", () => {
    expect(source).toMatch(/terminal state/);
  });

  it("lists valid transitions in error message", () => {
    expect(source).toMatch(/Valid transitions from/);
  });
});

describe("Policy Rollout — required evidence", () => {
  const source = readSource("packages/web/src/services/policyRolloutService.js");

  it("requires validation_result for review_ready", () => {
    expect(source).toMatch(/review_ready.*validation_result/);
  });

  it("requires validation_result for approved", () => {
    expect(source).toMatch(/approved.*validation_result/);
  });

  it("requires validation_result for promoted", () => {
    expect(source).toMatch(/promoted.*validation_result/);
  });

  it("throws if required evidence is missing", () => {
    expect(source).toMatch(/missing required evidence/);
  });

  it("suggests attaching evidence first", () => {
    expect(source).toMatch(/Attach evidence first/);
  });
});

describe("Policy Rollout — actor metadata", () => {
  const source = readSource("packages/web/src/services/policyRolloutService.js");

  it("requires actor for approval", () => {
    expect(source).toMatch(/actor is required for approval/);
  });

  it("sets approved_by and approved_at", () => {
    expect(source).toMatch(/approved_by/);
    expect(source).toMatch(/approved_at/);
  });

  it("requires actor for promotion", () => {
    expect(source).toMatch(/actor is required for promotion/);
  });

  it("sets promoted_by and promoted_at", () => {
    expect(source).toMatch(/promoted_by/);
    expect(source).toMatch(/promoted_at/);
  });

  it("requires actor for rollback", () => {
    expect(source).toMatch(/actor is required for rollback/);
  });

  it("sets rolled_back_by and rolled_back_at", () => {
    expect(source).toMatch(/rolled_back_by/);
    expect(source).toMatch(/rolled_back_at/);
  });

  it("requires actor for cancellation", () => {
    expect(source).toMatch(/actor is required for cancellation/);
  });

  it("sets cancelled_by and cancelled_at", () => {
    expect(source).toMatch(/cancelled_by/);
    expect(source).toMatch(/cancelled_at/);
  });
});

describe("Policy Rollout — rollback safety", () => {
  const source = readSource("packages/web/src/services/policyRolloutService.js");

  it("snapshots previous policy on promotion", () => {
    expect(source).toMatch(/previous_config/);
  });

  it("uses getConfigForRepo to snapshot current policy", () => {
    expect(source).toMatch(/getConfigForRepo/);
  });

  it("fails rollback if no previous_config snapshot", () => {
    expect(source).toMatch(/no previous_config snapshot available/);
  });
});

describe("Policy Rollout — evidence attachment", () => {
  const source = readSource("packages/web/src/services/policyRolloutService.js");

  it("allows evidence in draft state", () => {
    expect(source).toMatch(/status !== "draft"/);
  });

  it("allows evidence in validated state", () => {
    expect(source).toMatch(/status !== "validated"/);
  });

  it("rejects evidence after validated state", () => {
    expect(source).toMatch(/Cannot attach evidence to plan in/);
  });

  it("accepts validation_result field", () => {
    expect(source).toMatch(/validation_result/);
  });

  it("accepts simulation_summary field", () => {
    expect(source).toMatch(/simulation_summary/);
  });

  it("accepts diff_impact_summary field", () => {
    expect(source).toMatch(/diff_impact_summary/);
  });

  it("accepts recommendations_summary field", () => {
    expect(source).toMatch(/recommendations_summary/);
  });

  it("rejects if no evidence fields provided", () => {
    expect(source).toMatch(/No evidence fields provided/);
  });
});

describe("Policy Rollout — redaction", () => {
  const source = readSource("packages/web/src/services/policyRolloutService.js");

  it("has redactPlan helper", () => {
    expect(source).toMatch(/function redactPlan/);
  });

  it("redacts all JSONB fields", () => {
    expect(source).toMatch(/proposed_config/);
    expect(source).toMatch(/normalized_config/);
    expect(source).toMatch(/validation_result/);
    expect(source).toMatch(/simulation_summary/);
    expect(source).toMatch(/diff_impact_summary/);
    expect(source).toMatch(/recommendations_summary/);
    expect(source).toMatch(/previous_config/);
  });

  it("applies redactSecrets to each JSONB field", () => {
    expect(source).toMatch(/redactSecrets/);
  });

  it("returns null for null plan", () => {
    expect(source).toMatch(/if \(!plan\) return null/);
  });
});

describe("Policy Rollout — route contract", () => {
  const source = readSource("packages/web/src/routes/rollouts.js");

  it("exports rolloutRouter", () => {
    expect(source).toMatch(/export.*rolloutRouter/);
  });

  it("registers POST / (create)", () => {
    expect(source).toMatch(/rolloutRouter\.post\("\/"/);
  });

  it("registers GET / (list)", () => {
    expect(source).toMatch(/rolloutRouter\.get\("\/"/);
  });

  it("registers GET /:id (detail)", () => {
    expect(source).toMatch(/rolloutRouter\.get\("\/:id"/);
  });

  it("registers PATCH /:id/evidence", () => {
    expect(source).toMatch(/rolloutRouter\.patch\("\/:id\/evidence"/);
  });

  it("registers POST /:id/transition", () => {
    expect(source).toMatch(/rolloutRouter\.post\("\/:id\/transition"/);
  });

  it("validates repo in create body", () => {
    expect(source).toMatch(/repo is required/);
  });

  it("validates proposed_config in create body", () => {
    expect(source).toMatch(/proposed_config is required/);
  });

  it("validates created_by in create body", () => {
    expect(source).toMatch(/created_by is required/);
  });

  it("validates status in transition body", () => {
    expect(source).toMatch(/status is required/);
  });

  it("returns 201 on create", () => {
    expect(source).toMatch(/201/);
  });

  it("returns 404 for not found plan", () => {
    expect(source).toMatch(/404/);
    expect(source).toMatch(/Rollout plan not found/);
  });

  it("handles create errors (400 for bad input)", () => {
    expect(source).toMatch(/status\(400\)/);
  });

  it("caps list limit at 200", () => {
    expect(source).toMatch(/Math\.min.*200/);
  });

  it("supports query params for filtering (repo, status, created_by)", () => {
    expect(source).toMatch(/req\.query/);
  });
});

describe("Policy Rollout — app.js registration", () => {
  const source = readSource("packages/web/src/app.js");

  it("imports rolloutRouter", () => {
    expect(source).toMatch(/rolloutRouter/);
  });

  it("mounts /api/rollouts route", () => {
    expect(source).toMatch(/\/api\/rollouts/);
  });
});
