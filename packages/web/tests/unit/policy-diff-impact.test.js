// tests/unit/policy-diff-impact.test.js
// Tests for the policy diff impact API.
// Verifies diff computation, impact classification, risk/warning diffs,
// simulation comparison, and route/dashboard integration.

import { jest } from "@jest/globals";
import { fileURLToPath } from "url";
import fs from "fs";
import path from "path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

function readSource(relPath) {
  return fs.readFileSync(path.resolve(ROOT, relPath), "utf-8");
}

describe("Policy Diff Impact — service contract", () => {
  const source = readSource("packages/web/src/services/policyDiffService.js");

  it("exports diffPolicyImpact function", () => {
    expect(source).toMatch(/export.*async function diffPolicyImpact/);
  });

  it("requires repo parameter", () => {
    expect(source).toMatch(/repo is required/);
  });

  it("requires yaml parameter", () => {
    expect(source).toMatch(/yaml is required/);
  });

  it("loads current policy via getConfigForRepo", () => {
    expect(source).toMatch(/getConfigForRepo/);
  });

  it("parses proposed policy with parseConfig", () => {
    expect(source).toMatch(/parseConfig/);
  });

  it("validates proposed policy with validateConfig", () => {
    expect(source).toMatch(/validateConfig/);
  });

  it("returns error for invalid proposed policy (does not diff)", () => {
    expect(source).toMatch(/Invalid proposed policy.*cannot diff/);
  });

  it("returns compared_at timestamp", () => {
    expect(source).toMatch(/compared_at/);
  });

  it("includes current and proposed metadata", () => {
    expect(source).toMatch(/current.*valid/);
    expect(source).toMatch(/proposed.*valid/);
    expect(source).toMatch(/dry_run/);
    expect(source).toMatch(/enabled_pillars/);
  });
});

describe("Policy Diff Impact — change detection", () => {
  const source = readSource("packages/web/src/services/policyDiffService.js");

  it("detects dry_run change (from/to/risk)", () => {
    const dryRunSection = source.slice(source.indexOf("dryRunChange"));
    expect(dryRunSection).toMatch(/from:/);
    expect(dryRunSection).toMatch(/to:/);
    expect(dryRunSection).toMatch(/increased|decreased/);
  });

  it("detects pillars_enabled (newly enabled)", () => {
    expect(source).toMatch(/pillars_enabled/);
    expect(source).toMatch(/pillarsEnabled/);
  });

  it("detects pillars_disabled (newly disabled)", () => {
    expect(source).toMatch(/pillars_disabled/);
    expect(source).toMatch(/pillarsDisabled/);
  });

  it("detects risks_added", () => {
    expect(source).toMatch(/risks_added/);
    expect(source).toMatch(/risksAdded/);
  });

  it("detects risks_removed", () => {
    expect(source).toMatch(/risks_removed/);
    expect(source).toMatch(/risksRemoved/);
  });

  it("detects warnings_added", () => {
    expect(source).toMatch(/warnings_added/);
  });

  it("detects warnings_removed", () => {
    expect(source).toMatch(/warnings_removed/);
  });

  it("compares risks by path", () => {
    expect(source).toMatch(/c\.path === r\.path|r\.path === c\.path/);
  });
});

describe("Policy Diff Impact — simulation comparison", () => {
  const source = readSource("packages/web/src/services/policyDiffService.js");

  it("queries decision_log events for comparison", () => {
    expect(source).toMatch(/FROM decision_log/);
  });

  it("has simulateOne helper function", () => {
    expect(source).toMatch(/function simulateOne/);
  });

  it("has classifyImpact function", () => {
    expect(source).toMatch(/function classifyImpact/);
  });

  it("classifies more_permissive", () => {
    expect(source).toMatch(/more_permissive/);
  });

  it("classifies more_restrictive", () => {
    expect(source).toMatch(/more_restrictive/);
  });

  it("classifies unchanged", () => {
    expect(source).toMatch(/unchanged/);
  });

  it("classifies new_dry_run", () => {
    expect(source).toMatch(/new_dry_run/);
  });

  it("classifies removes_dry_run", () => {
    expect(source).toMatch(/removes_dry_run/);
  });

  it("classifies unsupported", () => {
    expect(source).toMatch(/unsupported/);
  });

  it("simulation_impact summary has all 5 counters", () => {
    expect(source).toMatch(/events_considered/);
    expect(source).toMatch(/newly_would_act/);
    expect(source).toMatch(/newly_would_skip/);
    expect(source).toMatch(/unchanged/);
    expect(source).toMatch(/unsupported/);
  });

  it("per-event results include current and proposed decisions", () => {
    expect(source).toMatch(/current_decision/);
    expect(source).toMatch(/proposed_decision/);
  });

  it("per-event results include impact label and reason", () => {
    expect(source).toMatch(/impact/);
    expect(source).toMatch(/reason/);
  });

  it("has impactReason helper", () => {
    expect(source).toMatch(/function impactReason/);
  });
});

describe("Policy Diff Impact — route contract", () => {
  const source = readSource("packages/web/src/routes/config.js");

  it("registers POST /diff-impact endpoint", () => {
    expect(source).toMatch(/configRouter\.post.*diff-impact/);
  });

  it("requires repo in body", () => {
    expect(source).toMatch(/repo is required/);
  });

  it("requires yaml in body", () => {
    expect(source).toMatch(/yaml is required/);
  });

  it("passes from/to/limit params", () => {
    expect(source).toMatch(/from/);
    expect(source).toMatch(/to/);
    expect(source).toMatch(/limit/);
  });

  it("caps limit at 200", () => {
    expect(source).toMatch(/Math\.min.*200/);
  });

  it("imports diffPolicyImpact", () => {
    expect(source).toMatch(/diffPolicyImpact/);
    expect(source).toMatch(/policyDiffService/);
  });

  it("handles errors gracefully", () => {
    expect(source).toMatch(/Failed to compute policy diff impact/);
  });
});

describe("Policy Diff Impact — dashboard integration", () => {
  const source = readSource("packages/web-dashboard/src/app/policy-preview/page.tsx");

  it("has Impact Comparison section", () => {
    expect(source).toMatch(/Impact Comparison/);
  });

  it("has repo selector for diff", () => {
    expect(source).toMatch(/diffRepo/);
  });

  it("has Compare impact button", () => {
    expect(source).toMatch(/Compare impact/);
  });

  it("disables comparison when policy invalid", () => {
    expect(source).toMatch(/result\?.valid/);
  });

  it("calls POST /api/config/diff-impact", () => {
    expect(source).toMatch(/\/api\/config\/diff-impact/);
  });

  it("has summary cards for dry-run, pillars, risks", () => {
    expect(source).toMatch(/Dry-run/);
    expect(source).toMatch(/Pillars enabled/);
    expect(source).toMatch(/Pillars disabled/);
    expect(source).toMatch(/Risks added/);
    expect(source).toMatch(/Risks removed/);
  });

  it("has simulation impact summary (newly would act/skip/unchanged/unsupported)", () => {
    expect(source).toMatch(/Newly would act/);
    expect(source).toMatch(/Newly would skip/);
    expect(source).toMatch(/Unchanged/);
  });

  it("shows pillar changes", () => {
    expect(source).toMatch(/Pillar Changes/);
    expect(source).toMatch(/newly enabled/);
    expect(source).toMatch(/newly disabled/);
  });

  it("shows risk changes", () => {
    expect(source).toMatch(/Risk Changes/);
  });

  it("shows event impact table with current -> proposed", () => {
    expect(source).toMatch(/current_decision/);
    expect(source).toMatch(/proposed_decision/);
  });

  it("has DiffStat component", () => {
    expect(source).toMatch(/DiffStat/);
  });

  it("has error state", () => {
    expect(source).toMatch(/diffError/);
    expect(source).toMatch(/Comparison failed/);
  });

  it("has loading state", () => {
    expect(source).toMatch(/diffLoading/);
    expect(source).toMatch(/Comparing/);
  });
});
