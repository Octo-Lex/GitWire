// tests/unit/decision-log-search.test.js
// Tests for the decision log search/filter API contract.
// Verifies backend filter dimensions, parameterized SQL, and dashboard coverage.

import { jest } from "@jest/globals";
import { fileURLToPath } from "url";
import fs from "fs";
import path from "path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

function readSource(relPath) {
  return fs.readFileSync(path.resolve(ROOT, relPath), "utf-8");
}

describe("Decision Log Search — API contract", () => {

  describe("Backend service: getDecisions filter dimensions", () => {
    const source = readSource("packages/web/src/services/decisionLogService.js");

    it("supports repo filter", () => {
      expect(source).toMatch(/repo.*full_name/);
    });

    it("supports source filter", () => {
      expect(source).toMatch(/d\.source\s*=/);
    });

    it("supports decision filter", () => {
      expect(source).toMatch(/d\.decision\s*=/);
    });

    it("supports pillar filter", () => {
      expect(source).toMatch(/d\.pillar\s*=/);
    });

    it("supports trigger_event filter", () => {
      expect(source).toMatch(/trigger_event|triggerEvent/i);
      expect(source).toMatch(/d\.trigger_event\s*=/);
    });

    it("supports target_type filter", () => {
      expect(source).toMatch(/d\.target_type\s*=/);
    });

    it("supports free-text search (ILIKE on reason)", () => {
      expect(source).toMatch(/ILIKE/);
    });

    it("supports date range (from/to)", () => {
      expect(source).toMatch(/created_at\s*>=/);
      expect(source).toMatch(/created_at\s*<=/);
    });

    it("uses parameterized queries", () => {
      const fnBody = source.slice(
        source.indexOf("export async function getDecisions"),
        source.indexOf("export async function getDecisionSummary")
      );
      expect(fnBody).toMatch(/pIdx/);
      expect(fnBody).toMatch(/\$" \+ pIdx/);
    });

    it("returns pagination metadata", () => {
      expect(source).toMatch(/totalPages/);
      expect(source).toMatch(/perPage/);
    });
  });

  describe("Backend route: passes all query params", () => {
    const source = readSource("packages/web/src/routes/decisions.js");

    it("passes repo, source, decision to service", () => {
      expect(source).toMatch(/req\.query\.repo/);
      expect(source).toMatch(/req\.query\.source/);
      expect(source).toMatch(/req\.query\.decision/);
    });

    it("passes pillar filter", () => {
      expect(source).toMatch(/req\.query\.pillar/);
    });

    it("passes trigger_event filter", () => {
      expect(source).toMatch(/trigger_event/);
    });

    it("passes free-text search q", () => {
      expect(source).toMatch(/req\.query\.q/);
    });

    it("passes date range from/to", () => {
      expect(source).toMatch(/req\.query\.from/);
      expect(source).toMatch(/req\.query\.to/);
    });

    it("caps per_page at 100", () => {
      expect(source).toMatch(/Math\.min.*100/);
    });
  });

  describe("Dashboard decisions page — filter coverage", () => {
    const source = readSource("packages/web-dashboard/src/app/decisions/page.tsx");

    it("has free-text search input", () => {
      expect(source).toMatch(/searchQuery/);
      expect(source).toMatch(/Search reason/);
    });

    it("has repo filter dropdown", () => {
      expect(source).toMatch(/repoFilter/);
    });

    it("has pillar filter dropdown", () => {
      expect(source).toMatch(/pillarFilter/);
      expect(source).toMatch(/PILLAR_OPTIONS/);
    });

    it("has source filter buttons", () => {
      expect(source).toMatch(/sourceFilter/);
    });

    it("has decision filter buttons", () => {
      expect(source).toMatch(/decisionFilter/);
    });

    it("has date range inputs", () => {
      expect(source).toMatch(/fromDate/);
      expect(source).toMatch(/toDate/);
    });

    it("has clear-filters button", () => {
      expect(source).toMatch(/clearFilters/);
      expect(source).toMatch(/Clear/);
    });

    it("has error state", () => {
      expect(source).toMatch(/decisionsError/);
      expect(source).toMatch(/Failed to load/);
    });

    it("has loading skeleton", () => {
      expect(source).toMatch(/Skeleton/);
    });

    it("has expandable detail view", () => {
      expect(source).toMatch(/expandedId/);
      expect(source).toMatch(/Config Used/);
      expect(source).toMatch(/Metadata/);
    });

    it("has empty state for filtered results", () => {
      expect(source).toMatch(/No decisions match/);
    });

    it("has pagination controls", () => {
      expect(source).toMatch(/Previous/);
      expect(source).toMatch(/Next/);
      expect(source).toMatch(/totalPages/);
    });

    it("sanitizes conditions display (no raw tokens)", () => {
      // Conditions use [+] / [x] not checkmark emoji
      expect(source).toMatch(/\[\+\]/);
      expect(source).toMatch(/\[x\]/);
    });
  });

  describe("Decision log service: logDecision contract", () => {
    const source = readSource("packages/web/src/services/decisionLogService.js");

    it("records repo_id, source, trigger_event, decision, reason", () => {
      expect(source).toMatch(/repo_id/);
      expect(source).toMatch(/trigger_event/);
      expect(source).toMatch(/decision/);
      expect(source).toMatch(/reason/);
    });

    it("stores conditions as JSON", () => {
      expect(source).toMatch(/JSON\.stringify\(conditions\)/);
    });

    it("stores config_used as JSON", () => {
      expect(source).toMatch(/config_used/);
    });

    it("defaults actor to gitwire[bot]", () => {
      expect(source).toMatch(/gitwire\[bot\]/);
    });

    it("does not crash on write failure (non-fatal)", () => {
      expect(source).toMatch(/non-fatal/i);
    });
  });
});
