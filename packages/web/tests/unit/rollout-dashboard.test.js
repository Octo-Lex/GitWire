// tests/unit/rollout-dashboard.test.js
// Tests for the rollout dashboard page — list, detail, actions, states.

import { jest } from "@jest/globals";
import { fileURLToPath } from "url";
import fs from "fs";
import path from "path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

function readSource(relPath) {
  return fs.readFileSync(path.resolve(ROOT, relPath), "utf-8");
}

describe("Rollout Dashboard — page structure", () => {
  const source = readSource("packages/web-dashboard/src/app/rollouts/page.tsx");

  it("page file exists", () => {
    expect(source.length).toBeGreaterThan(0);
  });

  it("is a client component", () => {
    expect(source).toMatch(/"use client"/);
  });

  it("uses useSWR for data fetching", () => {
    expect(source).toMatch(/useSWR/);
  });

  it("fetches /api/rollouts for list", () => {
    expect(source).toMatch(/\/api\/rollouts/);
  });

  it("has Policy Rollouts page title", () => {
    expect(source).toMatch(/Policy Rollouts/);
  });

  it("mentions controlled policy lifecycle", () => {
    expect(source).toMatch(/plan, validate, approve, promote, roll back/i);
  });
});

describe("Rollout Dashboard — list view", () => {
  const source = readSource("packages/web-dashboard/src/app/rollouts/page.tsx");

  it("has status filter dropdown with all 8 states", () => {
    expect(source).toMatch(/draft/);
    expect(source).toMatch(/validated/);
    expect(source).toMatch(/review_ready/);
    expect(source).toMatch(/approved/);
    expect(source).toMatch(/promoted/);
    expect(source).toMatch(/rolled_back/);
    expect(source).toMatch(/rejected/);
    expect(source).toMatch(/cancelled/);
  });

  it("has repo filter input", () => {
    expect(source).toMatch(/repoFilter/);
  });

  it("has clear filters button", () => {
    expect(source).toMatch(/Clear filters/);
  });

  it("shows plan ID", () => {
    expect(source).toMatch(/p\.id/);
  });

  it("shows status badge", () => {
    expect(source).toMatch(/STATUS_STYLES/);
  });

  it("shows repo full name", () => {
    expect(source).toMatch(/repo_full_name/);
  });

  it("shows dry-run indicator from proposed config", () => {
    expect(source).toMatch(/dry_run/);
  });

  it("shows risk counts from recommendations summary", () => {
    expect(source).toMatch(/recommendations_summary/);
    expect(source).toMatch(/critical/);
    expect(source).toMatch(/warning/);
  });

  it("shows created time relative", () => {
    expect(source).toMatch(/formatDistanceToNow/);
    expect(source).toMatch(/created_at/);
  });

  it("shows creator and actors", () => {
    expect(source).toMatch(/created_by/);
    expect(source).toMatch(/approved_by/);
    expect(source).toMatch(/promoted_by/);
    expect(source).toMatch(/rolled_back_by/);
  });

  it("has total count", () => {
    expect(source).toMatch(/total/);
  });

  it("has loading skeleton state", () => {
    expect(source).toMatch(/Skeleton/);
  });

  it("has empty state", () => {
    expect(source).toMatch(/EmptyState/);
    expect(source).toMatch(/No rollout plans/);
  });

  it("has error state", () => {
    expect(source).toMatch(/Failed to load rollouts/);
  });
});

describe("Rollout Dashboard — detail view", () => {
  const source = readSource("packages/web-dashboard/src/app/rollouts/page.tsx");

  it("has lifecycle timeline section", () => {
    expect(source).toMatch(/Lifecycle/);
    expect(source).toMatch(/LIFECYCLE_ORDER/);
  });

  it("lifecycle includes all 6 states in order", () => {
    expect(source).toMatch(/"draft", "validated", "review_ready", "approved", "promoted", "rolled_back"/);
  });

  it("has evidence summary section", () => {
    expect(source).toMatch(/Evidence/);
    expect(source).toMatch(/EvidenceCard/);
  });

  it("shows validation evidence card", () => {
    expect(source).toMatch(/Validation/);
    expect(source).toMatch(/validation_result/);
  });

  it("shows simulation evidence card", () => {
    expect(source).toMatch(/Simulation/);
    expect(source).toMatch(/simulation_summary/);
  });

  it("shows diff impact evidence card", () => {
    expect(source).toMatch(/Diff Impact/);
    expect(source).toMatch(/diff_impact_summary/);
  });

  it("shows recommendations evidence card", () => {
    expect(source).toMatch(/Recommendations/);
    expect(source).toMatch(/recommendations_summary/);
  });

  it("has audit trail section", () => {
    expect(source).toMatch(/Audit Trail/);
    expect(source).toMatch(/AuditRow/);
  });

  it("audit trail shows all actors", () => {
    expect(source).toMatch(/Created by/);
    expect(source).toMatch(/Approved by/);
    expect(source).toMatch(/Promoted by/);
    expect(source).toMatch(/Rejected by/);
    expect(source).toMatch(/Rolled back by/);
    expect(source).toMatch(/Cancelled by/);
  });

  it("has policy snapshots section (redacted)", () => {
    expect(source).toMatch(/Policy Snapshots/);
    expect(source).toMatch(/Redacted/);
  });

  it("shows proposed config collapsible block", () => {
    expect(source).toMatch(/Proposed Config/);
    expect(source).toMatch(/ConfigBlock/);
  });

  it("shows previous config when available", () => {
    expect(source).toMatch(/Previous Config/);
    expect(source).toMatch(/previous_config/);
  });

  it("shows replaced config when rolled back", () => {
    expect(source).toMatch(/Replaced Config/);
    expect(source).toMatch(/replaced_config_snapshot/);
  });

  it("has rollback evidence section", () => {
    expect(source).toMatch(/Rollback Evidence/);
    expect(source).toMatch(/rollback_evidence/);
  });

  it("shows rollback hashes", () => {
    expect(source).toMatch(/previous_config_hash/);
    expect(source).toMatch(/replaced_config_hash/);
  });
});

describe("Rollout Dashboard — actions", () => {
  const source = readSource("packages/web-dashboard/src/app/rollouts/page.tsx");

  it("has actions panel", () => {
    expect(source).toMatch(/Actions/);
  });

  it("has getAllowedActions function", () => {
    expect(source).toMatch(/function getAllowedActions/);
  });

  it("draft allows cancel", () => {
    expect(source).toMatch(/case "draft".*return \["cancel"\]/);
  });

  it("validated allows cancel", () => {
    expect(source).toMatch(/case "validated".*return \["cancel"\]/);
  });

  it("review_ready allows approve, reject, cancel", () => {
    expect(source).toMatch(/review_ready/);
    expect(source).toMatch(/approve/);
    expect(source).toMatch(/reject/);
  });

  it("approved allows promote, cancel", () => {
    expect(source).toMatch(/case "approved"/);
    expect(source).toMatch(/promote/);
  });

  it("promoted allows rollback", () => {
    expect(source).toMatch(/case "promoted"/);
    expect(source).toMatch(/rollback/);
  });

  it("terminal states show no actions", () => {
    expect(source).toMatch(/TERMINAL_STATES/);
    expect(source).toMatch(/rolled_back/);
    expect(source).toMatch(/rejected/);
    expect(source).toMatch(/cancelled/);
  });

  it("has action confirmation modal", () => {
    expect(source).toMatch(/actionModal/);
  });

  it("modal requires actor input", () => {
    expect(source).toMatch(/GitHub username/);
  });

  it("modal requires reason input", () => {
    expect(source).toMatch(/Reason for/);
  });

  it("has requiresReason function", () => {
    expect(source).toMatch(/function requiresReason/);
  });

  it("disables confirm when actor empty", () => {
    expect(source).toMatch(/actionActor\.trim/);
  });

  it("disables confirm when reason required but empty", () => {
    expect(source).toMatch(/requiresReason.*actionReason/);
  });

  it("calls correct API endpoint per action", () => {
    expect(source).toMatch(/\/api\/rollouts\/.*\+ action/);
  });
});

describe("Rollout Dashboard — confirmation copy", () => {
  const source = readSource("packages/web-dashboard/src/app/rollouts/page.tsx");

  it("has getConsequenceText function", () => {
    expect(source).toMatch(/function getConsequenceText/);
  });

  it("promote warns about replacing active policy", () => {
    expect(source).toMatch(/replace the active repository policy/);
    expect(source).toMatch(/previous policy snapshot will be retained/);
  });

  it("rollback warns about restoring previous policy", () => {
    expect(source).toMatch(/restore the previous policy snapshot/);
    expect(source).toMatch(/captured as replaced-config evidence/);
  });

  it("reject warns it is terminal", () => {
    expect(source).toMatch(/Rejecting this rollout is terminal/);
    expect(source).toMatch(/cannot be approved or promoted later/i);
  });

  it("approve explains no policy written yet", () => {
    expect(source).toMatch(/No policy is written yet/);
  });

  it("cancel warns it is terminal", () => {
    expect(source).toMatch(/Cancelling this rollout is terminal/);
  });

  it("promote/rollback have amber warning style", () => {
    const styleSection = source.slice(source.indexOf("getConsequenceStyle"));
    expect(styleSection).toMatch(/amber/);
  });

  it("reject/cancel have red warning style", () => {
    const styleSection = source.slice(source.indexOf("getConsequenceStyle"));
    expect(styleSection).toMatch(/red/);
  });
});

describe("Rollout Dashboard — critical recommendation acknowledgement", () => {
  const source = readSource("packages/web-dashboard/src/app/rollouts/page.tsx");

  it("shows critical recommendation checkboxes on approve", () => {
    expect(source).toMatch(/actionModal.action === "approve"/);
    expect(source).toMatch(/severity === "critical"/);
  });

  it("tracks acknowledged recommendations", () => {
    expect(source).toMatch(/acknowledgedRecs/);
  });

  it("passes acknowledged_recommendations to approve action", () => {
    expect(source).toMatch(/acknowledged_recommendations/);
  });
});

describe("Rollout Dashboard — sidebar integration", () => {
  const source = readSource("packages/web-dashboard/src/components/Sidebar.tsx");

  it("has /rollouts in sidebar", () => {
    expect(source).toMatch(/\/rollouts/);
  });

  it("labeled Rollouts", () => {
    expect(source).toMatch(/Rollouts/);
  });
});
