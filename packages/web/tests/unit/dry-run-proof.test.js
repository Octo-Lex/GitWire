// tests/unit/dry-run-proof.test.js
// Tests for the dry-run proof view API contract.
// Verifies that dry-run decisions are surfaced correctly with safety-first labeling.

import { jest } from "@jest/globals";
import { fileURLToPath } from "url";
import fs from "fs";
import path from "path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

function readSource(relPath) {
  return fs.readFileSync(path.resolve(ROOT, relPath), "utf-8");
}

describe("Dry-Run Proof — API contract", () => {

  describe("Decision log backend supports dry_run filter", () => {
    const service = readSource("packages/web/src/services/decisionLogService.js");
    const route = readSource("packages/web/src/routes/decisions.js");

    it("getDecisions accepts decision filter", () => {
      expect(service).toMatch(/d\.decision\s*=/);
    });

    it("route passes decision query param", () => {
      expect(route).toMatch(/req\.query\.decision/);
    });

    it("dry_run is a valid decision value recorded by workers", () => {
      // Verified in triageWorker.js — the worker records dry_run when isDryRun is true
      const triage = readSource("packages/web/src/workers/triageWorker.js");
      expect(triage).toMatch(/dry_run/);
    });
  });

  describe("Dashboard dry-run proof page — safety language", () => {
    const source = readSource("packages/web-dashboard/src/app/dry-run/page.tsx");

    it("exists as dedicated page", () => {
      expect(source).toBeTruthy();
    });

    it("pins decision=dry_run (cannot be overridden)", () => {
      expect(source).toMatch(/params\.set\("decision",\s*"dry_run"\)/);
    });

    it("uses 'would have' language (not 'action' or 'executed')", () => {
      expect(source).toMatch(/Would have/);
      expect(source).toMatch(/would have acted/i);
    });

    it("uses 'skipped mutation' language", () => {
      expect(source).toMatch(/Skipped mutation/);
    });

    it("uses 'dry-run proof recorded' (not 'success')", () => {
      expect(source).toMatch(/Dry-run proofs? recorded/);
      expect(source).toMatch(/Dry-Run Proof/);
    });

    it("does NOT use misleading language", () => {
      // Should not use 'Action applied', 'Executed', 'Success' in action context
      expect(source).not.toMatch(/Action applied/);
      expect(source).not.toMatch(/mutation was executed/i);
    });

    it("has safety banner at top", () => {
      expect(source).toMatch(/SAFE/);
      expect(source).toMatch(/did not mutate GitHub/i);
    });

    it("has safety reminder in expanded detail", () => {
      expect(source).toMatch(/no GitHub API writes were made/i);
    });
  });

  describe("Dashboard dry-run proof page — filters", () => {
    const source = readSource("packages/web-dashboard/src/app/dry-run/page.tsx");

    it("has free-text search", () => {
      expect(source).toMatch(/searchQuery/);
      expect(source).toMatch(/Search planned action/);
    });

    it("has repo filter dropdown", () => {
      expect(source).toMatch(/repoFilter/);
    });

    it("has pillar filter dropdown", () => {
      expect(source).toMatch(/pillarFilter/);
      expect(source).toMatch(/PILLAR_OPTIONS/);
    });

    it("has source filter dropdown", () => {
      expect(source).toMatch(/sourceFilter/);
    });

    it("has target type filter dropdown", () => {
      expect(source).toMatch(/targetTypeFilter/);
    });

    it("has date range inputs", () => {
      expect(source).toMatch(/fromDate/);
      expect(source).toMatch(/toDate/);
    });

    it("has clear-filters button", () => {
      expect(source).toMatch(/clearFilters/);
      expect(source).toMatch(/Clear/);
    });
  });

  describe("Dashboard dry-run proof page — states", () => {
    const source = readSource("packages/web-dashboard/src/app/dry-run/page.tsx");

    it("has error state with retry", () => {
      expect(source).toMatch(/proofError/);
      expect(source).toMatch(/Failed to load/);
    });

    it("has loading skeleton", () => {
      expect(source).toMatch(/Skeleton/);
    });

    it("has empty state for filtered results", () => {
      expect(source).toMatch(/No dry-run proofs match/);
    });

    it("has pagination controls", () => {
      expect(source).toMatch(/Previous/);
      expect(source).toMatch(/Next/);
    });
  });

  describe("Dashboard dry-run proof page — detail view", () => {
    const source = readSource("packages/web-dashboard/src/app/dry-run/page.tsx");

    it("has expandable detail", () => {
      expect(source).toMatch(/expandedId/);
    });

    it("shows planned reason", () => {
      expect(source).toMatch(/Planned Reason/);
    });

    it("shows config used", () => {
      expect(source).toMatch(/Config Used/);
    });

    it("shows metadata (source, pillar, trigger, target, actor)", () => {
      expect(source).toMatch(/Planned Action/);
      expect(source).toMatch(/trigger_event/);
    });

    it("has deep link to decision log", () => {
      expect(source).toMatch(/View in decision log/);
    });

    it("has deep link to managed actions", () => {
      expect(source).toMatch(/View related managed actions/);
    });
  });

  describe("Sidebar navigation", () => {
    const sidebar = readSource("packages/web-dashboard/src/components/Sidebar.tsx");

    it("includes dry-run proof in navigation", () => {
      expect(sidebar).toMatch(/\/dry-run/);
      expect(sidebar).toMatch(/Dry-Run Proof/);
    });

    it("places it in governance section", () => {
      const governanceSection = sidebar.slice(
        sidebar.indexOf("Governance"),
        sidebar.indexOf("Operations")
      );
      expect(governanceSection).toMatch(/dry-run/);
    });
  });

  describe("Icon for dry-run proof", () => {
    const icons = readSource("packages/web-dashboard/src/components/Icons.tsx");

    it("exports DryRunProofIcon", () => {
      expect(icons).toMatch(/DryRunProofIcon/);
    });

    it("uses Eye icon (observation, not action)", () => {
      expect(icons).toMatch(/Eye/);
    });
  });

  describe("Worker dry-run recording contract", () => {
    const triage = readSource("packages/web/src/workers/triageWorker.js");

    it("records dry_run decision with is_dry_run condition", () => {
      expect(triage).toMatch(/is_dry_run\(\)/);
      expect(triage).toMatch(/dry_run/);
    });

    it("captures what would have been done in reason field", () => {
      // The reason field describes the planned action
      expect(triage).toMatch(/reason:/);
      expect(triage).toMatch(/applied labels/);
    });

    it("captures configUsed snapshot", () => {
      expect(triage).toMatch(/configUsed/);
    });
  });
});
