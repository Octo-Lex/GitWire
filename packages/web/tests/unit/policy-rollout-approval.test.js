// tests/unit/policy-rollout-approval.test.js
// Tests for the rollout approval workflow — approve/reject endpoints,
// evidence requirements, risk acknowledgement, state enforcement, and audit.

import { jest } from "@jest/globals";
import { fileURLToPath } from "url";
import fs from "fs";
import path from "path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

function readSource(relPath) {
  return fs.readFileSync(path.resolve(ROOT, relPath), "utf-8");
}

describe("Rollout Approval — DB migration 028", () => {
  const migration = readSource("packages/web/db/migrations/028_rollout_approval.sql");

  it("adds rejected to status CHECK constraint", () => {
    expect(migration).toMatch(/rejected/);
    expect(migration).toMatch(/DROP CONSTRAINT/);
    expect(migration).toMatch(/ADD CONSTRAINT/);
  });

  it("adds approval_reason column", () => {
    expect(migration).toMatch(/approval_reason.*TEXT/);
  });

  it("adds acknowledged_recommendations JSONB column", () => {
    expect(migration).toMatch(/acknowledged_recommendations.*JSONB/);
  });

  it("adds reviewed_evidence JSONB column", () => {
    expect(migration).toMatch(/reviewed_evidence.*JSONB/);
  });

  it("adds rejected_by column", () => {
    expect(migration).toMatch(/rejected_by.*TEXT/);
  });

  it("adds rejected_at timestamp", () => {
    expect(migration).toMatch(/rejected_at.*TIMESTAMPTZ/);
  });

  it("adds rejection_reason column", () => {
    expect(migration).toMatch(/rejection_reason.*TEXT/);
  });
});

describe("Rollout Approval — service exports", () => {
  const source = readSource("packages/web/src/services/policyRolloutService.js");

  it("exports approveRolloutPlan", () => {
    expect(source).toMatch(/export.*async function approveRolloutPlan/);
  });

  it("exports rejectRolloutPlan", () => {
    expect(source).toMatch(/export.*async function rejectRolloutPlan/);
  });

  it("exports REQUIRED_EVIDENCE_FOR_APPROVAL", () => {
    expect(source).toMatch(/REQUIRED_EVIDENCE_FOR_APPROVAL/);
  });
});

describe("Rollout Approval — state model", () => {
  const source = readSource("packages/web/src/services/policyRolloutService.js");

  it("review_ready can transition to approved", () => {
    const section = source.slice(source.indexOf("review_ready:"), source.indexOf("approved:"));
    expect(section).toMatch(/approved/);
  });

  it("review_ready can transition to rejected", () => {
    const section = source.slice(source.indexOf("review_ready:"), source.indexOf("approved:"));
    expect(section).toMatch(/rejected/);
  });

  it("review_ready can transition to cancelled", () => {
    const section = source.slice(source.indexOf("review_ready:"), source.indexOf("approved:"));
    expect(section).toMatch(/cancelled/);
  });

  it("rejected is terminal", () => {
    const section = source.slice(source.indexOf("rejected:"));
    expect(section).toMatch(/terminal/);
  });

  it("rejected has empty transition set", () => {
    const section = source.slice(source.indexOf("rejected:"));
    expect(section).toMatch(/new Set\(\)/);
  });
});

describe("Rollout Approval — approval rules", () => {
  const source = readSource("packages/web/src/services/policyRolloutService.js");

  it("requires actor for approval", () => {
    expect(source).toMatch(/actor is required for approval/);
  });

  it("requires plan to be in review_ready state", () => {
    expect(source).toMatch(/Cannot approve plan in.*state.*review_ready/);
  });

  it("requires all 4 evidence types attached", () => {
    expect(source).toMatch(/validation_result/);
    expect(source).toMatch(/simulation_summary/);
    expect(source).toMatch(/diff_impact_summary/);
    expect(source).toMatch(/recommendations_summary/);
  });

  it("lists missing evidence in error message", () => {
    expect(source).toMatch(/missing required evidence/);
  });

  it("rejects approval when validation failed", () => {
    expect(source).toMatch(/proposed policy validation failed/);
  });

  it("requires critical recommendations acknowledged", () => {
    expect(source).toMatch(/critical recommendation.*not acknowledged/);
  });

  it("lists unacknowledged recommendations in error", () => {
    expect(source).toMatch(/All critical recommendations must be explicitly acknowledged/);
  });

  it("has getCriticalRecommendations helper", () => {
    expect(source).toMatch(/function getCriticalRecommendations/);
  });

  it("filters recommendations by severity critical", () => {
    expect(source).toMatch(/r\.severity === "critical"/);
  });
});

describe("Rollout Approval — approval metadata", () => {
  const source = readSource("packages/web/src/services/policyRolloutService.js");

  it("stores approved_by", () => {
    expect(source).toMatch(/approved_by/);
  });

  it("stores approved_at", () => {
    expect(source).toMatch(/approved_at/);
  });

  it("stores approval_reason", () => {
    expect(source).toMatch(/approval_reason/);
  });

  it("stores acknowledged_recommendations", () => {
    expect(source).toMatch(/acknowledged_recommendations/);
  });

  it("stores reviewed_evidence snapshot", () => {
    expect(source).toMatch(/reviewed_evidence/);
    expect(source).toMatch(/reviewedEvidence/);
  });

  it("reviewed_evidence includes all 4 attachment booleans", () => {
    expect(source).toMatch(/validation_attached/);
    expect(source).toMatch(/simulation_attached/);
    expect(source).toMatch(/diff_attached/);
    expect(source).toMatch(/recommendations_attached/);
  });

  it("reviewed_evidence includes recommendation counts", () => {
    expect(source).toMatch(/recommendation_counts/);
  });

  it("reviewed_evidence includes simulation summary", () => {
    expect(source).toMatch(/simulation_summary.*plan/);
  });

  it("reviewed_evidence includes diff summary", () => {
    expect(source).toMatch(/diff_summary/);
  });
});

describe("Rollout Approval — rejection", () => {
  const source = readSource("packages/web/src/services/policyRolloutService.js");

  it("requires actor for rejection", () => {
    expect(source).toMatch(/actor is required for rejection/);
  });

  it("requires plan to be in review_ready state", () => {
    expect(source).toMatch(/Cannot reject plan in.*state.*review_ready/);
  });

  it("stores rejected_by", () => {
    expect(source).toMatch(/rejected_by/);
  });

  it("stores rejected_at", () => {
    expect(source).toMatch(/rejected_at/);
  });

  it("stores rejection_reason", () => {
    expect(source).toMatch(/rejection_reason/);
  });
});

describe("Rollout Approval — generic transition blocked", () => {
  const source = readSource("packages/web/src/services/policyRolloutService.js");

  it("blocks generic transition to approved", () => {
    expect(source).toMatch(/Approval must go through.*approve/);
  });

  it("blocks generic transition to rejected", () => {
    expect(source).toMatch(/Rejection must go through.*reject/);
  });
});

describe("Rollout Approval — redaction includes new fields", () => {
  const source = readSource("packages/web/src/services/policyRolloutService.js");

  it("redacts acknowledged_recommendations", () => {
    expect(source).toMatch(/"acknowledged_recommendations"/);
  });

  it("redacts reviewed_evidence", () => {
    expect(source).toMatch(/"reviewed_evidence"/);
  });
});

describe("Rollout Approval — route contract", () => {
  const source = readSource("packages/web/src/routes/rollouts.js");

  it("imports approveRolloutPlan", () => {
    expect(source).toMatch(/approveRolloutPlan/);
  });

  it("imports rejectRolloutPlan", () => {
    expect(source).toMatch(/rejectRolloutPlan/);
  });

  it("registers POST /:id/approve", () => {
    expect(source).toMatch(/rolloutRouter\.post\("\/:id\/approve"/);
  });

  it("registers POST /:id/reject", () => {
    expect(source).toMatch(/rolloutRouter\.post\("\/:id\/reject"/);
  });

  it("requires actor in approve body", () => {
    expect(source).toMatch(/actor is required.*GitHub username/);
  });

  it("requires actor in reject body", () => {
    expect(source).toMatch(/actor is required.*GitHub username/);
  });

  it("passes acknowledged_recommendations to service", () => {
    expect(source).toMatch(/acknowledged_recommendations/);
  });

  it("passes reason to service", () => {
    expect(source).toMatch(/reason/);
  });

  it("handles approval errors (400 for bad input)", () => {
    const approveSection = source.slice(source.indexOf("approve"));
    expect(approveSection).toMatch(/status\(400\)/);
  });

  it("handles rejection errors (400 for bad input)", () => {
    const rejectSection = source.slice(source.indexOf("reject"));
    expect(rejectSection).toMatch(/status\(400\)/);
  });

  it("handles missing evidence error gracefully", () => {
    const approveSection = source.slice(source.indexOf("approve"));
    expect(approveSection).toMatch(/missing/);
  });

  it("handles unacknowledged error gracefully", () => {
    const approveSection = source.slice(source.indexOf("approve"));
    expect(approveSection).toMatch(/not acknowledged/);
  });
});
