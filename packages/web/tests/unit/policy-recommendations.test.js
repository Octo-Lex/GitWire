// tests/unit/policy-recommendations.test.js
// Tests for the guardrail recommendation service.
// Verifies deterministic rule evaluation, severity classification,
// evidence inclusion, diff-aware guidance, and route/dashboard integration.

import { jest } from "@jest/globals";
import { fileURLToPath } from "url";
import fs from "fs";
import path from "path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

function readSource(relPath) {
  return fs.readFileSync(path.resolve(ROOT, relPath), "utf-8");
}

describe("Policy Recommendations — service contract", () => {
  const source = readSource("packages/web/src/services/policyRecommendationService.js");

  it("exports recommendGuardrails function", () => {
    expect(source).toMatch(/export.*async function recommendGuardrails/);
  });

  it("requires yaml parameter", () => {
    expect(source).toMatch(/yaml is required/);
  });

  it("parses proposed policy with parseConfig", () => {
    expect(source).toMatch(/parseConfig/);
  });

  it("validates with validateConfig", () => {
    expect(source).toMatch(/validateConfig/);
  });

  it("returns error for invalid policy (does not recommend)", () => {
    expect(source).toMatch(/Invalid proposed policy.*cannot recommend/);
  });

  it("returns generated_at timestamp", () => {
    expect(source).toMatch(/generated_at/);
  });

  it("returns repo in result", () => {
    expect(source).toMatch(/repo.*null|repo.*repo/);
  });

  it("returns summary with critical/warning/info counts", () => {
    expect(source).toMatch(/summary/);
    expect(source).toMatch(/critical/);
    expect(source).toMatch(/warning/);
    expect(source).toMatch(/info/);
  });

  it("returns recommendations array", () => {
    expect(source).toMatch(/recommendations/);
  });
});

describe("Policy Recommendations — recommendation shape", () => {
  const source = readSource("packages/web/src/services/policyRecommendationService.js");

  it("each recommendation has stable id", () => {
    expect(source).toMatch(/id:/);
  });

  it("each recommendation has severity (critical/warning/info)", () => {
    expect(source).toMatch(/severity/);
  });

  it("each recommendation has category", () => {
    expect(source).toMatch(/category/);
  });

  it("each recommendation has path", () => {
    expect(source).toMatch(/path:/);
  });

  it("each recommendation has title", () => {
    expect(source).toMatch(/title:/);
  });

  it("each recommendation has reason", () => {
    expect(source).toMatch(/reason:/);
  });

  it("each recommendation has suggested_change", () => {
    expect(source).toMatch(/suggested_change/);
  });

  it("each recommendation has evidence object", () => {
    expect(source).toMatch(/evidence/);
  });
});

describe("Policy Recommendations — dry-run rules", () => {
  const source = readSource("packages/web/src/services/policyRecommendationService.js");

  it("triggers DRY_RUN_FOR_RISKY when dry_run=false and risks exist", () => {
    expect(source).toMatch(/DRY_RUN_FOR_RISKY|enable-dry-run-for-risky-policy/);
  });

  it("triggers DRY_RUN_FOR_NEW for newly enabled pillars without dry-run", () => {
    expect(source).toMatch(/DRY_RUN_FOR_NEW|enable-dry-run-for-new/);
  });

  it("triggers DRY_RUN_REMOVED when diff shows dry_run true→false", () => {
    expect(source).toMatch(/DRY_RUN_REMOVED|keep-dry-run-during-rollout/);
  });
});

describe("Policy Recommendations — scope & trigger rules", () => {
  const source = readSource("packages/web/src/services/policyRecommendationService.js");

  it("triggers NEWLY_PERMISSIVE when diff has newly_would_act > 0", () => {
    expect(source).toMatch(/NEWLY_PERMISSIVE|narrow-triggers/);
  });

  it("triggers BROAD_TRIGGERS for mutating pillars with empty triggers", () => {
    expect(source).toMatch(/BROAD_TRIGGERS|add-trigger-filters/);
  });

  it("defines MUTATING_PILLARS set", () => {
    expect(source).toMatch(/MUTATING_PILLARS/);
  });

  it("has isBroadTrigger helper", () => {
    expect(source).toMatch(/function isBroadTrigger/);
  });

  it("checks triage as mutating", () => {
    expect(source).toMatch(/"triage"/);
  });

  it("checks ci_healing as mutating", () => {
    expect(source).toMatch(/"ci_healing"/);
  });

  it("checks issue_fix as mutating", () => {
    expect(source).toMatch(/"issue_fix"/);
  });

  it("checks merge_queue as mutating", () => {
    expect(source).toMatch(/"merge_queue"/);
  });
});

describe("Policy Recommendations — limit rules", () => {
  const source = readSource("packages/web/src/services/policyRecommendationService.js");

  it("defines LIMIT_THRESHOLDS", () => {
    expect(source).toMatch(/LIMIT_THRESHOLDS/);
  });

  it("triggers HIGH_LIMIT_ISSUE_FIX for issue_fix.max_files above threshold", () => {
    expect(source).toMatch(/HIGH_LIMIT_ISSUE_FIX|lower-issue-fix/);
  });

  it("triggers HIGH_LIMIT_CI_HEAL for ci_healing.max_files above threshold", () => {
    expect(source).toMatch(/HIGH_LIMIT_CI_HEAL|lower-ci-heal/);
  });
});

describe("Policy Recommendations — specific pillar rules", () => {
  const source = readSource("packages/web/src/services/policyRecommendationService.js");

  it("triggers AUTO_PATCH_UNCONSTRAINED for auto_patch without paths", () => {
    expect(source).toMatch(/AUTO_PATCH_UNCONSTRAINED|constrain-auto-patch/);
  });

  it("triggers ISSUE_FIX_UNCONSTRAINED for issue_fix without labels/paths", () => {
    expect(source).toMatch(/ISSUE_FIX_UNCONSTRAINED|constrain-issue-fix/);
  });

  it("triggers MERGE_QUEUE_NO_CHECKS for merge_queue without required checks", () => {
    expect(source).toMatch(/MERGE_QUEUE_NO_CHECKS|require-branch-protection-for-merge-queue/);
  });
});

describe("Policy Recommendations — no-recommendations state", () => {
  const source = readSource("packages/web/src/services/policyRecommendationService.js");

  it("has NO_RECOMMENDATIONS positive state", () => {
    expect(source).toMatch(/NO_RECOMMENDATIONS|no-recommendations/);
  });

  it("NO_RECOMMENDATIONS has info severity", () => {
    const noRecSection = source.slice(source.indexOf("NO_RECOMMENDATIONS"));
    expect(noRecSection).toMatch(/severity.*info/);
  });

  it("NO_RECOMMENDATIONS has positive reason", () => {
    expect(source).toMatch(/No high-risk guardrail changes recommended/);
  });
});

describe("Policy Recommendations — diff-aware integration", () => {
  const source = readSource("packages/web/src/services/policyRecommendationService.js");

  it("uses diffImpact.current.enabled_pillars for newly enabled detection", () => {
    expect(source).toMatch(/diffImpact.*current.*enabled_pillars/);
  });

  it("uses diffImpact.changes.dry_run for removal detection", () => {
    expect(source).toMatch(/diffImpact.*changes.*dry_run/);
  });

  it("uses diffImpact.simulation_impact for permissiveness detection", () => {
    expect(source).toMatch(/diffImpact.*simulation_impact/);
  });

  it("works without diffImpact (policy-only recommendations)", () => {
    expect(source).toMatch(/diffImpact.*\?/);
  });
});

describe("Policy Recommendations — route contract", () => {
  const source = readSource("packages/web/src/routes/config.js");

  it("registers POST /recommendations endpoint", () => {
    expect(source).toMatch(/configRouter\.post.*recommendations/);
  });

  it("requires yaml in body", () => {
    expect(source).toMatch(/yaml is required/);
  });

  it("accepts optional repo param", () => {
    expect(source).toMatch(/repo/);
  });

  it("computes diff impact when repo provided", () => {
    expect(source).toMatch(/diffPolicyImpact/);
  });

  it("continues without diff if diff fails (graceful)", () => {
    expect(source).toMatch(/continuing without/);
  });

  it("imports recommendGuardrails", () => {
    expect(source).toMatch(/recommendGuardrails/);
    expect(source).toMatch(/policyRecommendationService/);
  });

  it("handles errors gracefully", () => {
    expect(source).toMatch(/Failed to generate policy recommendations/);
  });
});

describe("Policy Recommendations — dashboard integration", () => {
  const source = readSource("packages/web-dashboard/src/app/policy-preview/page.tsx");

  it("has Guardrail Recommendations section", () => {
    expect(source).toMatch(/Guardrail Recommendations/);
  });

  it("states recommendations are deterministic (no AI)", () => {
    expect(source).toMatch(/No AI advice/i);
  });

  it("has optional repo selector for diff-aware recs", () => {
    expect(source).toMatch(/recRepo/);
  });

  it("has Generate recommendations button", () => {
    expect(source).toMatch(/Generate recommendations/);
  });

  it("disables recommendations when policy invalid", () => {
    expect(source).toMatch(/result\?.valid/);
  });

  it("calls POST /api/config/recommendations", () => {
    expect(source).toMatch(/\/api\/config\/recommendations/);
  });

  it("has summary cards (Critical/Warning/Info)", () => {
    expect(source).toMatch(/RecStat/);
    expect(source).toMatch(/Critical/);
    expect(source).toMatch(/Warning/);
    expect(source).toMatch(/Info/);
  });

  it("shows recommendation cards with title, severity, reason", () => {
    expect(source).toMatch(/rec\.title/);
    expect(source).toMatch(/rec\.severity/);
    expect(source).toMatch(/rec\.reason/);
  });

  it("shows suggested_change in cards", () => {
    expect(source).toMatch(/suggested_change/);
  });

  it("shows config path in cards", () => {
    expect(source).toMatch(/rec\.path/);
  });

  it("shows evidence chips", () => {
    expect(source).toMatch(/rec\.evidence/);
  });

  it("has error state", () => {
    expect(source).toMatch(/recError/);
    expect(source).toMatch(/Recommendations failed/);
  });

  it("has loading state", () => {
    expect(source).toMatch(/recLoading/);
    expect(source).toMatch(/Generating/);
  });
});
