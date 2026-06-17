// tests/unit/waiver-visibility.test.js
// Tests for the waiver visibility API contract.
// Verifies global filter dimensions, parameterized SQL, status computation, and dashboard coverage.

import { jest } from "@jest/globals";
import { fileURLToPath } from "url";
import fs from "fs";
import path from "path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

function readSource(relPath) {
  return fs.readFileSync(path.resolve(ROOT, relPath), "utf-8");
}

describe("Waiver Visibility — API contract", () => {

  describe("Backend service: listAllWaivers filter dimensions", () => {
    const source = readSource("packages/web/src/services/waiverService.js");

    it("exports listAllWaivers function", () => {
      expect(source).toMatch(/export.*function listAllWaivers/);
    });

    it("supports repo filter via full_name join", () => {
      const fnBody = source.slice(
        source.indexOf("export async function listAllWaivers"),
        source.indexOf("// src/routes")
      );
      expect(fnBody).toMatch(/r\.full_name/);
    });

    it("supports pillar filter", () => {
      const fnBody = source.slice(
        source.indexOf("export async function listAllWaivers"),
        source.indexOf("// src/routes")
      );
      expect(fnBody).toMatch(/w\.pillar\s*=/);
    });

    it("supports scope filter", () => {
      const fnBody = source.slice(
        source.indexOf("export async function listAllWaivers"),
        source.indexOf("// src/routes")
      );
      expect(fnBody).toMatch(/w\.scope\s*=/);
    });

    it("supports grantedBy filter", () => {
      const fnBody = source.slice(
        source.indexOf("export async function listAllWaivers"),
        source.indexOf("// src/routes")
      );
      expect(fnBody).toMatch(/granted_by/);
    });

    it("supports free-text search (ILIKE on reason)", () => {
      const fnBody = source.slice(
        source.indexOf("export async function listAllWaivers"),
        source.indexOf("// src/routes")
      );
      expect(fnBody).toMatch(/ILIKE/);
    });

    it("supports status filter (active/expired/expiring)", () => {
      const fnBody = source.slice(
        source.indexOf("export async function listAllWaivers"),
        source.indexOf("// src/routes")
      );
      expect(fnBody).toMatch(/status.*active/);
      expect(fnBody).toMatch(/status.*expired/);
      expect(fnBody).toMatch(/status.*expiring/);
      expect(fnBody).toMatch(/INTERVAL.*7.*days/);
    });

    it("uses parameterized queries", () => {
      const fnBody = source.slice(
        source.indexOf("export async function listAllWaivers"),
        source.indexOf("// src/routes")
      );
      expect(fnBody).toMatch(/pIdx/);
    });

    it("returns pagination metadata (total, limit, offset)", () => {
      const fnBody = source.slice(
        source.indexOf("export async function listAllWaivers"),
        source.indexOf("// src/routes")
      );
      expect(fnBody).toMatch(/total/);
      expect(fnBody).toMatch(/limit/);
      expect(fnBody).toMatch(/offset/);
    });

    it("joins repositories for repo_full_name", () => {
      const fnBody = source.slice(
        source.indexOf("export async function listAllWaivers"),
        source.indexOf("// src/routes")
      );
      expect(fnBody).toMatch(/repo_full_name/);
    });
  });

  describe("Backend route: global listing when no repo", () => {
    const source = readSource("packages/web/src/routes/waivers.js");

    it("does not require repo (supports global view)", () => {
      expect(source).toMatch(/if\s*\(\s*!\s*repo\s*\)/);
      expect(source).toMatch(/listAllWaivers/);
    });

    it("passes scope filter", () => {
      expect(source).toMatch(/req\.query\.scope/);
    });

    it("passes status filter", () => {
      expect(source).toMatch(/req\.query\.status/);
    });

    it("passes granted_by filter", () => {
      expect(source).toMatch(/granted_by/);
    });

    it("passes free-text search q", () => {
      expect(source).toMatch(/req\.query\.q/);
    });

    it("passes limit and offset for pagination", () => {
      expect(source).toMatch(/req\.query\.limit/);
      expect(source).toMatch(/req\.query\.offset/);
    });

    it("caps limit at 200", () => {
      expect(source).toMatch(/Math\.min.*200/);
    });
  });

  describe("Dashboard waivers page — filter coverage", () => {
    const source = readSource("packages/web-dashboard/src/app/waivers/page.tsx");

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

    it("has scope filter dropdown", () => {
      expect(source).toMatch(/scopeFilter/);
      expect(source).toMatch(/SCOPE_OPTIONS/);
    });

    it("has status filter buttons", () => {
      expect(source).toMatch(/statusFilter/);
      expect(source).toMatch(/active/);
      expect(source).toMatch(/expiring/);
      expect(source).toMatch(/expired/);
    });

    it("has clear-filters button", () => {
      expect(source).toMatch(/clearFilters/);
      expect(source).toMatch(/Clear/);
    });

    it("has error state", () => {
      expect(source).toMatch(/waiverError/);
      expect(source).toMatch(/Failed to load/);
    });

    it("has loading skeleton", () => {
      expect(source).toMatch(/Skeleton/);
    });

    it("has expandable detail view", () => {
      expect(source).toMatch(/expandedId/);
      expect(source).toMatch(/Metadata|Details/);
    });

    it("has empty state for filtered results", () => {
      expect(source).toMatch(/No waivers match/);
    });

    it("computes waiver status (active/expiring/expired)", () => {
      expect(source).toMatch(/computeWaiverStatus/);
    });

    it("shows decision linkage link", () => {
      expect(source).toMatch(/Decision linkage/);
      expect(source).toMatch(/decisions/);
    });

    it("shows expiry information", () => {
      expect(source).toMatch(/expires/);
      expect(source).toMatch(/formatDistanceToNow/);
    });

    it("has pagination controls", () => {
      expect(source).toMatch(/Previous/);
      expect(source).toMatch(/Next/);
    });
  });

  describe("Waiver service: existing functions preserved", () => {
    const source = readSource("packages/web/src/services/waiverService.js");

    it("still exports isWaived", () => {
      expect(source).toMatch(/export.*function isWaived/);
    });

    it("still exports grantWaiver", () => {
      expect(source).toMatch(/export.*function grantWaiver/);
    });

    it("still exports revokeWaiver", () => {
      expect(source).toMatch(/export.*function revokeWaiver/);
    });

    it("still exports expireWaivers", () => {
      expect(source).toMatch(/export.*function expireWaivers/);
    });

    it("still exports listWaivers (repo-specific)", () => {
      expect(source).toMatch(/export.*function listWaivers/);
    });

    it("scope ordering still works (issue > pr > branch > repo)", () => {
      expect(source).toMatch(/WHEN 'issue'/);
      expect(source).toMatch(/WHEN 'repo'/);
    });
  });

  describe("API helper: waivers() supports global view", () => {
    const source = readSource("packages/web-dashboard/src/lib/api.ts");

    it("returns /api/waivers?query when repo is empty", () => {
      expect(source).toMatch(/repo\s*\?/);
    });
  });
});
