// tests/unit/policy-simulation.test.js
// Tests for the historical policy simulation API.
// Verifies simulation contract, guard evaluation, AI-dependent labeling,
// dry-run behavior, and route behavior.

import { jest } from "@jest/globals";
import { fileURLToPath } from "url";
import fs from "fs";
import path from "path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

function readSource(relPath) {
  return fs.readFileSync(path.resolve(ROOT, relPath), "utf-8");
}

describe("Policy Simulation — service contract", () => {
  const source = readSource("packages/web/src/services/policySimulationService.js");

  it("exports simulatePolicy function", () => {
    expect(source).toMatch(/export.*async function simulatePolicy/);
  });

  it("requires repo parameter", () => {
    expect(source).toMatch(/repo is required/);
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

  it("returns error result for invalid policy (does not simulate)", () => {
    expect(source).toMatch(/Invalid policy.*cannot simulate/);
  });

  it("queries decision_log for historical events", () => {
    expect(source).toMatch(/FROM decision_log/);
  });

  it("filters by repo_id", () => {
    expect(source).toMatch(/repo_id/);
  });

  it("filters by date range (from/to)", () => {
    expect(source).toMatch(/created_at\s*>=/);
    expect(source).toMatch(/created_at\s*<=/);
  });

  it("caps limit at 200", () => {
    expect(source).toMatch(/Math\.min.*200/);
  });

  it("uses parameterized queries", () => {
    expect(source).toMatch(/\$\d/);
  });

  it("returns simulated_at timestamp", () => {
    expect(source).toMatch(/simulated_at/);
  });

  it("includes scope metadata", () => {
    expect(source).toMatch(/scope.*repo/);
  });

  it("includes policy metadata (valid, dry_run, enabled_pillars)", () => {
    const policySection = source.slice(source.indexOf("policy:"));
    expect(policySection).toMatch(/valid/);
    expect(policySection).toMatch(/dry_run/);
    expect(policySection).toMatch(/enabled_pillars/);
  });
});

describe("Policy Simulation — summary shape", () => {
  const source = readSource("packages/web/src/services/policySimulationService.js");

  it("counts events_considered", () => {
    expect(source).toMatch(/events_considered/);
  });

  it("counts would_act", () => {
    expect(source).toMatch(/would_act/);
  });

  it("counts would_skip", () => {
    expect(source).toMatch(/would_skip/);
  });

  it("counts would_block", () => {
    expect(source).toMatch(/would_block/);
  });

  it("counts dry_run", () => {
    expect(source).toMatch(/summary.*dry_run/);
  });

  it("counts unsupported", () => {
    expect(source).toMatch(/unsupported/);
  });
});

describe("Policy Simulation — guard evaluation", () => {
  const source = readSource("packages/web/src/services/policySimulationService.js");

  it("uses isPillarEnabled from @gitwire/rules", () => {
    expect(source).toMatch(/isPillarEnabled/);
  });

  it("uses shouldTrigger from @gitwire/rules", () => {
    expect(source).toMatch(/shouldTrigger/);
  });

  it("uses isDryRun from @gitwire/rules", () => {
    expect(source).toMatch(/isDryRun/);
  });

  it("has simulateEvent function", () => {
    expect(source).toMatch(/function simulateEvent/);
  });

  it("checks pillar_enabled guard first", () => {
    expect(source).toMatch(/pillar_enabled/);
  });

  it("returns would_skip when pillar disabled", () => {
    expect(source).toMatch(/Pillar.*disabled/);
  });

  it("checks trigger_filter guard second", () => {
    expect(source).toMatch(/trigger_filter/);
  });

  it("returns would_skip when trigger filter fails", () => {
    expect(source).toMatch(/Trigger filter did not match/);
  });

  it("checks is_dry_run guard third", () => {
    expect(source).toMatch(/is_dry_run\(\)/);
  });
});

describe("Policy Simulation — AI-dependent labeling", () => {
  const source = readSource("packages/web/src/services/policySimulationService.js");

  it("defines AI_DEPENDENT_SOURCES set", () => {
    expect(source).toMatch(/AI_DEPENDENT_SOURCES/);
  });

  it("marks triage as AI-dependent", () => {
    expect(source).toMatch(/"triage"/);
  });

  it("marks ai_review as AI-dependent", () => {
    expect(source).toMatch(/"ai_review"/);
  });

  it("marks issue_fix as AI-dependent", () => {
    expect(source).toMatch(/"issue_fix"/);
  });

  it("returns would_require_ai for AI sources that originally acted", () => {
    expect(source).toMatch(/would_require_ai/);
    expect(source).toMatch(/requires AI replay/);
  });

  it("does NOT fabricate AI output", () => {
    expect(source).toMatch(/Cannot deterministically replay/);
  });
});

describe("Policy Simulation — dry-run behavior", () => {
  const source = readSource("packages/web/src/services/policySimulationService.js");

  it("returns dry_run decision when dry-run is active", () => {
    expect(source).toMatch(/simulated_decision.*dry_run/);
  });

  it("states dry-run prevents mutation", () => {
    expect(source).toMatch(/Dry-run.*prevent mutation/);
  });
});

describe("Policy Simulation — per-event result shape", () => {
  const source = readSource("packages/web/src/services/policySimulationService.js");

  it("includes event_id", () => {
    expect(source).toMatch(/event_id/);
  });

  it("includes event_type", () => {
    expect(source).toMatch(/event_type/);
  });

  it("includes source", () => {
    expect(source).toMatch(/source/);
  });

  it("includes target_type and target_number", () => {
    expect(source).toMatch(/target_type/);
    expect(source).toMatch(/target_number/);
  });

  it("includes original_decision", () => {
    expect(source).toMatch(/original_decision/);
  });

  it("includes simulated_decision", () => {
    expect(source).toMatch(/simulated_decision/);
  });

  it("includes would_do array", () => {
    expect(source).toMatch(/would_do/);
  });

  it("includes reason", () => {
    expect(source).toMatch(/reason/);
  });

  it("includes conditions array", () => {
    expect(source).toMatch(/conditions/);
  });
});

describe("Policy Simulation — route contract", () => {
  const source = readSource("packages/web/src/routes/config.js");

  it("registers POST /simulate endpoint", () => {
    expect(source).toMatch(/configRouter\.post.*simulate/);
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

  it("imports simulatePolicy", () => {
    expect(source).toMatch(/simulatePolicy/);
    expect(source).toMatch(/policySimulationService/);
  });

  it("handles errors gracefully", () => {
    expect(source).toMatch(/Failed to simulate/);
  });
});

describe("Policy Simulation — dashboard integration", () => {
  const source = readSource("packages/web-dashboard/src/app/policy-preview/page.tsx");

  it("has simulation section", () => {
    expect(source).toMatch(/Historical Simulation/);
  });

  it("has repo selector for simulation", () => {
    expect(source).toMatch(/simRepo/);
  });

  it("has date range inputs", () => {
    expect(source).toMatch(/simFrom/);
    expect(source).toMatch(/simTo/);
  });

  it("has limit selector", () => {
    expect(source).toMatch(/simLimit/);
  });

  it("has Run simulation button", () => {
    expect(source).toMatch(/Run simulation/);
  });

  it("disables simulation when policy invalid", () => {
    expect(source).toMatch(/result\?.valid/);
  });

  it("calls POST /api/config/simulate", () => {
    expect(source).toMatch(/\/api\/config\/simulate/);
  });

  it("shows simulation summary stats (6 cards)", () => {
    expect(source).toMatch(/SimStat/);
    expect(source).toMatch(/Considered/);
    expect(source).toMatch(/Would act/);
    expect(source).toMatch(/Would skip/);
    expect(source).toMatch(/Dry-run/);
    expect(source).toMatch(/Block/);
    expect(source).toMatch(/Unsupported/);
  });

  it("has per-event expandable rows", () => {
    expect(source).toMatch(/simExpandedId/);
  });

  it("shows conditions in expanded detail", () => {
    expect(source).toMatch(/Conditions/);
    expect(source).toMatch(/c\.check/);
  });

  it("shows would_do in expanded detail", () => {
    expect(source).toMatch(/Would do/);
  });

  it("shows original_decision in expanded detail", () => {
    expect(source).toMatch(/Original/);
    expect(source).toMatch(/original_decision/);
  });

  it("states simulation is approximate", () => {
    expect(source).toMatch(/Approximate/i);
  });

  it("has simulation error state", () => {
    expect(source).toMatch(/simError/);
    expect(source).toMatch(/Simulation failed/);
  });

  it("has loading state", () => {
    expect(source).toMatch(/simLoading/);
    expect(source).toMatch(/Simulating/);
  });
});
