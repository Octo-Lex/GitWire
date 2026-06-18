// tests/unit/setup-templates.test.js
// Tests for the starter policy templates — service contract, route integration,
// template validation, and YAML correctness.

import { jest } from "@jest/globals";
import { fileURLToPath } from "url";
import fs from "fs";
import path from "path";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../.."
);

function readSource(relPath) {
  return fs.readFileSync(path.resolve(ROOT, relPath), "utf-8");
}

// ── Template files exist and are valid ────────────────────────────────────

const TEMPLATES_DIR = path.resolve(ROOT, "packages/web/templates");

describe("Setup Templates — files exist and are valid YAML", () => {
  const EXPECTED_TEMPLATES = [
    "starter-dry-run",
    "triage-only",
    "ci-healing-dry-run",
    "open-source-maintainer",
    "strict-governance",
  ];

  EXPECTED_TEMPLATES.forEach((id) => {
    const filePath = path.join(TEMPLATES_DIR, `${id}.yml`);

    it(`${id}.yml exists`, () => {
      expect(fs.existsSync(filePath)).toBe(true);
    });

    it(`${id}.yml starts with a comment header`, () => {
      const content = fs.readFileSync(filePath, "utf-8");
      expect(content.startsWith("#")).toBe(true);
    });

    it(`${id}.yml has version: 1`, () => {
      const content = fs.readFileSync(filePath, "utf-8");
      expect(content).toMatch(/^version:\s*1/m);
    });

    it(`${id}.yml has a settings section with dry_run`, () => {
      const content = fs.readFileSync(filePath, "utf-8");
      expect(content).toMatch(/settings:/);
      expect(content).toMatch(/dry_run:/);
    });

    it(`${id}.yml has a pillars section`, () => {
      const content = fs.readFileSync(filePath, "utf-8");
      expect(content).toMatch(/pillars:/);
    });

    it(`${id}.yml includes safety guidance comments`, () => {
      const content = fs.readFileSync(filePath, "utf-8");
      expect(content).toMatch(/When to use/i);
      expect(content).toMatch(/change before going live/i);
    });
  });
});

// ── Dry-run templates actually set dry_run: true ──────────────────────────

describe("Setup Templates — dry-run correctness", () => {
  it("starter-dry-run.yml has dry_run: true", () => {
    const content = readSource("packages/web/templates/starter-dry-run.yml");
    expect(content).toMatch(/dry_run:\s*true/);
  });

  it("strict-governance.yml has dry_run: true", () => {
    const content = readSource("packages/web/templates/strict-governance.yml");
    expect(content).toMatch(/dry_run:\s*true/);
  });

  it("triage-only.yml has dry_run: false (triage labels are safe)", () => {
    const content = readSource("packages/web/templates/triage-only.yml");
    expect(content).toMatch(/dry_run:\s*false/);
  });

  it("ci-healing-dry-run.yml has auto_patch: false (the safety key)", () => {
    const content = readSource(
      "packages/web/templates/ci-healing-dry-run.yml"
    );
    expect(content).toMatch(/auto_patch:\s*false/);
  });

  it("open-source-maintainer.yml has dry_run: false (production config)", () => {
    const content = readSource(
      "packages/web/templates/open-source-maintainer.yml"
    );
    expect(content).toMatch(/dry_run:\s*false/);
  });
});

// ── Template safety properties ────────────────────────────────────────────

describe("Setup Templates — safety properties", () => {
  it("starter-dry-run has issue_fix disabled", () => {
    const content = readSource("packages/web/templates/starter-dry-run.yml");
    expect(content).toMatch(/issue_fix:[\s\S]*?enabled:\s*false/);
  });

  it("strict-governance has issue_fix disabled", () => {
    const content = readSource("packages/web/templates/strict-governance.yml");
    expect(content).toMatch(/issue_fix:[\s\S]*?enabled:\s*false/);
  });

  it("all templates block sensitive file patterns in ci_healing", () => {
    const templates = [
      "starter-dry-run",
      "ci-healing-dry-run",
      "open-source-maintainer",
      "strict-governance",
    ];
    for (const id of templates) {
      const content = readSource(`packages/web/templates/${id}.yml`);
      expect(content).toMatch(/\.env\*/);
      expect(content).toMatch(/secrets\/\*\*/);
    }
  });

  it("strict-governance has quality_gates with stricter thresholds", () => {
    const content = readSource("packages/web/templates/strict-governance.yml");
    expect(content).toMatch(/quality_gates:/);
    expect(content).toMatch(/ci_failure_rate_7d/);
    expect(content).toMatch(/0\.15/); // stricter than default 0.3
  });

  it("open-source-maintainer includes spam_gate", () => {
    const content = readSource(
      "packages/web/templates/open-source-maintainer.yml"
    );
    expect(content).toMatch(/spam_gate:/);
    expect(content).toMatch(/enabled:\s*true/);
  });

  it("open-source-maintainer has close_days: null (no auto-close community issues)", () => {
    const content = readSource(
      "packages/web/templates/open-source-maintainer.yml"
    );
    expect(content).toMatch(/close_days:\s*null/);
  });
});

// ── Service source contract ───────────────────────────────────────────────

describe("Setup Templates — service source contract", () => {
  const service = readSource(
    "packages/web/src/services/templateService.js"
  );

  it("exports listTemplates function", () => {
    expect(service).toMatch(/export async function listTemplates/);
  });

  it("exports getTemplate function", () => {
    expect(service).toMatch(/export async function getTemplate/);
  });

  it("has TEMPLATE_META with all 5 templates", () => {
    expect(service).toMatch(/starter-dry-run/);
    expect(service).toMatch(/triage-only/);
    expect(service).toMatch(/ci-healing-dry-run/);
    expect(service).toMatch(/open-source-maintainer/);
    expect(service).toMatch(/strict-governance/);
  });

  it("each template meta has id, name, description, difficulty, dry_run", () => {
    const metaFields = ["id:", "name:", "description:", "difficulty:", "dry_run:"];
    for (const field of metaFields) {
      expect(service).toContain(field);
    }
  });

  it("reads from templates directory", () => {
    expect(service).toMatch(/templates/);
    expect(service).toMatch(/readFile/);
  });

  it("getTemplate throws NOT_FOUND for unknown template", () => {
    expect(service).toMatch(/NOT_FOUND/);
  });

  it("rejects non-alphanumeric template IDs (path traversal prevention)", () => {
    expect(service).toMatch(/a-z0-9-/);
    expect(service).toMatch(/\.test\(id\)/);
  });

  it("uses meta.id (validated) instead of raw input for file path", () => {
    expect(service).toMatch(/meta\.id/);
    expect(service).toMatch(/meta\.id\}\.yml/);
    // Raw id should NOT be used directly in path.join for file reading
    expect(service).not.toMatch(/\$\{id\}\.yml/);
  });
});

// ── Route source contract ─────────────────────────────────────────────────

describe("Setup Templates — route source contract", () => {
  const route = readSource("packages/web/src/routes/setup.js");

  it("has GET /templates endpoint", () => {
    expect(route).toMatch(/router\.get\("\/templates"/);
  });

  it("has GET /templates/:id endpoint", () => {
    expect(route).toMatch(/router\.get\("\/templates\/:id"/);
  });

  it("imports from templateService", () => {
    expect(route).toMatch(/templateService/);
  });

  it("templates list returns { data: [...] } shape", () => {
    expect(route).toMatch(/data:\s*templates/);
  });

  it("template detail calls getTemplate", () => {
    expect(route).toMatch(/getTemplate/);
  });

  it("handles 404 for unknown template", () => {
    expect(route).toMatch(/NOT_FOUND/);
    expect(route).toMatch(/status\(404\)/);
  });
});

// ── Dashboard integration ─────────────────────────────────────────────────

describe("Setup Templates — dashboard integration", () => {
  const apiSource = readSource("packages/web-dashboard/src/lib/api.ts");
  const componentSource = readSource(
    "packages/web-dashboard/src/components/SetupChecklist.tsx"
  );

  it("API client has setupTemplates() endpoint", () => {
    expect(apiSource).toMatch(/setupTemplates:\s*\(\)\s*=>\s*`\/api\/setup\/templates`/);
  });

  it("API client has setupTemplate(id) endpoint", () => {
    expect(apiSource).toMatch(/setupTemplate:\s*\(id:\s*string\)/);
  });

  it("component has TemplateSuggestions sub-component", () => {
    expect(componentSource).toMatch(/TemplateSuggestions/);
  });

  it("component fetches templates when .gitwire.yml is missing", () => {
    expect(componentSource).toMatch(/needsTemplates/);
    expect(componentSource).toMatch(/setupTemplates/);
  });

  it("component shows template name, description, and difficulty", () => {
    expect(componentSource).toMatch(/tpl\.name/);
    expect(componentSource).toMatch(/tpl\.description/);
    expect(componentSource).toMatch(/tpl\.difficulty/);
  });

  it("component shows safety label badge", () => {
    expect(componentSource).toMatch(/safety_label/);
    expect(componentSource).toMatch(/SAFETY_META/);
  });

  it("non-dry-run templates have explicit non-dry-run safety labels", () => {
    const service = readSource("packages/web/src/services/templateService.js");
    // triage-only: low-risk-live
    expect(service).toMatch(/triage-only[\s\S]*?safety:\s*"low-risk-live"/);
    // ci-healing-dry-run: safe-to-preview
    expect(service).toMatch(/ci-healing-dry-run[\s\S]*?safety:\s*"safe-to-preview"/);
    // open-source-maintainer: review-before-rollout
    expect(service).toMatch(/open-source-maintainer[\s\S]*?safety:\s*"review-before-rollout"/);
  });

  it("component links to config playground with template param", () => {
    expect(componentSource).toMatch(/template=/);
    expect(componentSource).toMatch(/playground/);
  });
});
