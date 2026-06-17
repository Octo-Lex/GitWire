// tests/unit/audit-bundle.test.js
// Tests for the exportable audit bundle API contract.
// Verifies bundle structure, redaction, markdown conversion, and route behavior.

import { jest } from "@jest/globals";
import { fileURLToPath } from "url";
import fs from "fs";
import path from "path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

function readSource(relPath) {
  return fs.readFileSync(path.resolve(ROOT, relPath), "utf-8");
}

describe("Audit Bundle — redaction utility", () => {
  const source = readSource("packages/web/src/lib/redact.js");

  it("exports redactSecrets function", () => {
    expect(source).toMatch(/export.*function redactSecrets/);
  });

  it("exports truncateLongStrings function", () => {
    expect(source).toMatch(/export.*function truncateLongStrings/);
  });

  it("exports getRedactedFields function", () => {
    expect(source).toMatch(/export.*function getRedactedFields/);
  });

  it("covers all required secret key patterns", () => {
    expect(source).toMatch(/token/);
    expect(source).toMatch(/secret/);
    expect(source).toMatch(/password/);
    expect(source).toMatch(/private_key/);
    expect(source).toMatch(/privateKey/);
    expect(source).toMatch(/authorization/);
    expect(source).toMatch(/api_key/);
    expect(source).toMatch(/apiKey/);
    expect(source).toMatch(/pem/);
    expect(source).toMatch(/credential/);
  });

  it("replaces values with [REDACTED]", () => {
    expect(source).toMatch(/\[REDACTED\]/);
  });

  it("is case-insensitive on key matching", () => {
    expect(source).toMatch(/toLowerCase/);
  });
});

describe("Audit Bundle — service contract", () => {
  const source = readSource("packages/web/src/services/auditBundleService.js");

  it("exports generateAuditBundle function", () => {
    expect(source).toMatch(/export.*function generateAuditBundle/);
  });

  it("exports bundleToMarkdown function", () => {
    expect(source).toMatch(/export.*function bundleToMarkdown/);
  });

  it("uses schema_version audit-bundle/v1", () => {
    expect(source).toMatch(/audit-bundle\/v1/);
  });

  it("generates generated_at timestamp", () => {
    expect(source).toMatch(/generated_at/);
    expect(source).toMatch(/new Date\(\)\.toISOString/);
  });

  it("includes scope metadata (repo, pillar, target_type, target_number, from, to)", () => {
    const scopeSection = source.slice(source.indexOf("scope:"));
    expect(scopeSection).toMatch(/repo/);
    expect(scopeSection).toMatch(/pillar/);
    expect(scopeSection).toMatch(/target_type/);
    expect(scopeSection).toMatch(/target_number/);
    expect(scopeSection).toMatch(/from/);
    expect(scopeSection).toMatch(/to/);
  });

  it("includes summary counts (decisions, managed_actions, waivers, dry_run_decisions)", () => {
    const summarySection = source.slice(source.indexOf("summary:"));
    expect(summarySection).toMatch(/decisions/);
    expect(summarySection).toMatch(/managed_actions/);
    expect(summarySection).toMatch(/waivers/);
    expect(summarySection).toMatch(/dry_run_decisions/);
  });

  it("separates dry_run decisions from regular decisions", () => {
    expect(source).toMatch(/AND d.decision != 'dry_run'/);
    expect(source).toMatch(/AND d.decision = 'dry_run'/);
  });

  it("applies redaction to all sections", () => {
    expect(source).toMatch(/redactSecrets/);
    expect(source).toMatch(/truncateLongStrings/);
  });

  it("includes redaction metadata in bundle output", () => {
    const redactionSection = source.slice(source.indexOf("redactions:"));
    expect(redactionSection).toMatch(/enabled/);
    expect(redactionSection).toMatch(/fields/);
    expect(redactionSection).toMatch(/getRedactedFields/);
  });

  it("uses parameterized queries for safety", () => {
    expect(source).toMatch(/pIdx|aIdx|wIdx/);
    expect(source).toMatch(/\$" \+ pIdx/);
  });

  it("caps limit at 1000", () => {
    expect(source).toMatch(/Math\.min.*1000/);
  });

  it("includes markdown conversion with proper headers", () => {
    expect(source).toMatch(/GitWire Audit Bundle/);
    expect(source).toMatch(/Scope/);
    expect(source).toMatch(/Summary/);
    expect(source).toMatch(/Redactions/);
    expect(source).toMatch(/Dry-Run Proofs/);
  });
});

describe("Audit Bundle — route contract", () => {
  const source = readSource("packages/web/src/routes/auditBundles.js");

  it("registers GET /export endpoint", () => {
    expect(source).toMatch(/auditBundlesRouter\.get.*export/);
  });

  it("supports JSON format (default)", () => {
    expect(source).toMatch(/json/);
  });

  it("supports markdown format", () => {
    expect(source).toMatch(/markdown/);
  });

  it("passes repo, pillar, target_type, target_number filters", () => {
    expect(source).toMatch(/req\.query\.repo/);
    expect(source).toMatch(/req\.query\.pillar/);
    expect(source).toMatch(/target_type/);
    expect(source).toMatch(/target_number/);
  });

  it("passes date range from/to", () => {
    expect(source).toMatch(/req\.query\.from/);
    expect(source).toMatch(/req\.query\.to/);
  });

  it("sets Content-Disposition for download", () => {
    expect(source).toMatch(/Content-Disposition/);
    expect(source).toMatch(/attachment/);
  });

  it("caps limit at 1000", () => {
    expect(source).toMatch(/Math\.min.*1000/);
  });
});

describe("Audit Bundle — route registration", () => {
  const source = readSource("packages/web/src/app.js");

  it("registers audit-bundles router on /api/audit-bundles", () => {
    expect(source).toMatch(/api\/audit-bundles/);
  });

  it("imports auditBundlesRouter", () => {
    expect(source).toMatch(/auditBundlesRouter/);
  });
});

describe("Dashboard export integration", () => {

  describe("Decisions page", () => {
    const source = readSource("packages/web-dashboard/src/app/decisions/page.tsx");

    it("has export buttons", () => {
      expect(source).toMatch(/Export JSON/);
      expect(source).toMatch(/Export MD/);
    });

    it("export uses audit-bundles endpoint", () => {
      expect(source).toMatch(/audit-bundles\/export/);
    });

    it("export respects current filters", () => {
      expect(source).toMatch(/exportAuditBundle/);
      expect(source).toMatch(/params/);
    });
  });

  describe("Dry-run proof page", () => {
    const source = readSource("packages/web-dashboard/src/app/dry-run/page.tsx");

    it("has export buttons", () => {
      expect(source).toMatch(/Export JSON/);
      expect(source).toMatch(/Export MD/);
    });

    it("export uses audit-bundles endpoint", () => {
      expect(source).toMatch(/audit-bundles\/export/);
    });
  });

  describe("Actions page", () => {
    const source = readSource("packages/web-dashboard/src/app/actions/page.tsx");

    it("has export button", () => {
      expect(source).toMatch(/Export JSON/);
    });

    it("export uses audit-bundles endpoint", () => {
      expect(source).toMatch(/audit-bundles\/export/);
    });
  });

  describe("Waivers page", () => {
    const source = readSource("packages/web-dashboard/src/app/waivers/page.tsx");

    it("has export button", () => {
      expect(source).toMatch(/Export JSON/);
    });

    it("export uses audit-bundles endpoint", () => {
      expect(source).toMatch(/audit-bundles\/export/);
    });
  });
});
