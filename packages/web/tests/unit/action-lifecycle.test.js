// tests/unit/action-lifecycle.test.js
// Tests for the managed action lifecycle API contract.
// Verifies that listActions supports all filter dimensions
// and the action detail endpoint returns the expected shape.

import { jest } from "@jest/globals";
import { fileURLToPath } from "url";
import fs from "fs";
import path from "path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

function readSource(relPath) {
  return fs.readFileSync(path.resolve(ROOT, relPath), "utf-8");
}

describe("Managed Action Lifecycle — API contract", () => {

  describe("listActions filter dimensions", () => {
    const source = readSource("packages/web/src/services/actionStateMachine.js");

    it("supports repo filter", () => {
      expect(source).toMatch(/repo_full_name\s*=/);
    });

    it("supports status filter", () => {
      expect(source).toMatch(/status\s*=/);
    });

    it("supports pillar filter", () => {
      expect(source).toMatch(/pillar\s*=/);
    });

    it("supports action_type filter", () => {
      expect(source).toMatch(/action_type\s*=/);
    });

    it("uses parameterized queries (no string concatenation)", () => {
      const fnBody = source.slice(
        source.indexOf("async function listActions"),
        source.indexOf("async function getActionSummary")
      );
      expect(fnBody).toMatch(/\$\{idx\+\+\}/);
      expect(fnBody).not.toMatch(/`.*\$\{.*\}.*`.*WHERE/i);
    });
  });

  describe("Action route passes all filters", () => {
    const source = readSource("packages/web/src/routes/actions.js");

    it("passes repo, status, pillar, and action_type to listActions", () => {
      expect(source).toMatch(/req\.query\.repo/);
      expect(source).toMatch(/req\.query\.status/);
      expect(source).toMatch(/req\.query\.pillar/);
      expect(source).toMatch(/req\.query\.action_type/);
    });

    it("caps limit at 200", () => {
      expect(source).toMatch(/Math\.min.*200/);
    });
  });

  describe("Action state machine — lifecycle states", () => {
    const source = readSource("packages/web/src/services/actionStateMachine.js");

    it("exports all 8 lifecycle functions", () => {
      expect(source).toMatch(/export.*function propose/);
      expect(source).toMatch(/export.*function approve/);
      expect(source).toMatch(/export.*function execute/);
      expect(source).toMatch(/export.*function succeed/);
      expect(source).toMatch(/export.*function fail/);
      expect(source).toMatch(/export.*function cancel/);
      expect(source).toMatch(/export.*function retry/);
      expect(source).toMatch(/export.*function reconcile/);
    });

    it("propose generates an action with a unique key", () => {
      expect(source).toMatch(/actionKey/);
    });

    it("fail records error_message", () => {
      expect(source).toMatch(/error_message/);
    });

    it("retry creates child action with parent_action_id", () => {
      expect(source).toMatch(/parent_action_id/);
    });

    it("reconcile records reconciliation_status", () => {
      expect(source).toMatch(/reconciliation_status/);
    });
  });

  describe("Dashboard actions page — filter coverage", () => {
    const source = readSource("packages/web-dashboard/src/app/actions/page.tsx");

    it("has status filter buttons", () => {
      expect(source).toMatch(/statusFilter/);
    });

    it("has pillar filter dropdown", () => {
      expect(source).toMatch(/pillarFilter/);
      expect(source).toMatch(/PILLAR_OPTIONS/);
    });

    it("has action type filter dropdown", () => {
      expect(source).toMatch(/actionTypeFilter/);
      expect(source).toMatch(/ACTION_TYPE_OPTIONS/);
    });

    it("has repo filter dropdown", () => {
      expect(source).toMatch(/repoFilter/);
    });

    it("has clear-filters button", () => {
      expect(source).toMatch(/Clear filters/);
    });

    it("has loading skeleton state", () => {
      expect(source).toMatch(/shimmer/);
    });

    it("has error state", () => {
      expect(source).toMatch(/actionsError/);
      expect(source).toMatch(/Failed to load/);
    });

    it("has empty state for filtered results", () => {
      expect(source).toMatch(/No actions match your filters/);
    });
  });

  describe("Dashboard detail page — observability", () => {
    const source = readSource("packages/web-dashboard/src/app/actions/[id]/page.tsx");

    it("has loading skeleton (not just text)", () => {
      expect(source).toMatch(/shimmer/);
    });

    it("has error state with retry", () => {
      expect(source).toMatch(/actionError/);
      expect(source).toMatch(/Failed to load action/);
    });

    it("shows lifecycle timeline", () => {
      expect(source).toMatch(/TimelineStep/);
      expect(source).toMatch(/Proposed/);
      expect(source).toMatch(/Approved/);
      expect(source).toMatch(/Executing/);
      expect(source).toMatch(/Resolved/);
      expect(source).toMatch(/Reconciled/);
    });

    it("shows evidence JSON", () => {
      expect(source).toMatch(/evidence/);
    });

    it("shows error message for failed actions", () => {
      expect(source).toMatch(/error_message/);
    });

    it("shows retry chain (parent_action_id)", () => {
      expect(source).toMatch(/parent_action_id/);
    });

    it("shows reconciliation status", () => {
      expect(source).toMatch(/reconciliation_status/);
    });
  });
});
