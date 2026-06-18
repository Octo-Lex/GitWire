// tests/unit/v018-docs.test.js
// Verifies v0.18.0 documentation completeness — onboarding walkthrough,
// setup checklist references, and template documentation.

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

describe("v0.18.0 — First-run onboarding walkthrough", () => {
  const guide = readSource("docs/guides/first-run-onboarding.md");

  it("exists as a guide page", () => {
    expect(guide).toBeTruthy();
  });

  it("has a title", () => {
    expect(guide).toMatch(/# First-Run Onboarding Walkthrough/);
  });

  it("documents all 10 steps of the onboarding path", () => {
    expect(guide).toMatch(/Step 1.*Install GitWire/);
    expect(guide).toMatch(/Step 2.*Configure.*GitHub App/);
    expect(guide).toMatch(/Step 3.*Start Services/);
    expect(guide).toMatch(/Step 4.*Open the Dashboard/);
    expect(guide).toMatch(/Step 5.*Use.*Setup Checklist/);
    expect(guide).toMatch(/Step 6.*Pick.*Starter Template/);
    expect(guide).toMatch(/Step 7.*Validate/);
    expect(guide).toMatch(/Step 8.*Simulate/);
    expect(guide).toMatch(/Step 9.*Create.*Rollout/);
    expect(guide).toMatch(/Step 10.*Approve.*Promote/);
  });

  it("has a mermaid flow diagram showing the 10-step path", () => {
    expect(guide).toMatch(/```mermaid/);
    expect(guide).toMatch(/graph LR/);
    expect(guide).toMatch(/Install/);
    expect(guide).toMatch(/governed rollout/);
  });

  it("documents the setup checklist checks", () => {
    expect(guide).toMatch(/GitHub App configured/);
    expect(guide).toMatch(/Database connected/);
    expect(guide).toMatch(/Redis connected/);
    expect(guide).toMatch(/Webhook events received/);
    expect(guide).toMatch(/Dry-run mode/);
  });

  it("explains the color-coded status system", () => {
    expect(guide).toMatch(/Red.*blocking/);
    expect(guide).toMatch(/Amber.*action needed/);
    expect(guide).toMatch(/Green.*ready/);
  });

  it("documents template safety labels", () => {
    expect(guide).toMatch(/Dry-run protected/);
    expect(guide).toMatch(/Low-risk live/);
    expect(guide).toMatch(/Safe to preview/);
    expect(guide).toMatch(/Review before rollout/);
  });

  it("recommends Starter Dry-Run for first rollout", () => {
    expect(guide).toMatch(/Starter.*Dry-Run/);
    expect(guide).toMatch(/safest possible/i);
  });

  it("documents the rollout workflow (validate → simulate → approve → promote)", () => {
    expect(guide).toMatch(/Validate/);
    expect(guide).toMatch(/Simulate/);
    expect(guide).toMatch(/Approve/);
    expect(guide).toMatch(/Promote/);
    expect(guide).toMatch(/Rollback/);
  });

  it("explains write-before-transition safety guarantee", () => {
    expect(guide).toMatch(/write-before-transition/i);
  });

  it("explains rollback with evidence", () => {
    expect(guide).toMatch(/Rollback/);
    expect(guide).toMatch(/snapshot/);
    expect(guide).toMatch(/audit trail/);
  });

  it("documents moving from dry-run to live mode", () => {
    expect(guide).toMatch(/Moving to Live Mode/);
    expect(guide).toMatch(/dry_run.*false/);
  });

  it("has troubleshooting section", () => {
    expect(guide).toMatch(/Troubleshooting/);
    expect(guide).toMatch(/DATABASE_URL/);
    expect(guide).toMatch(/REDIS_URL/);
    expect(guide).toMatch(/webhook/i);
  });

  it("links to further reading", () => {
    expect(guide).toMatch(/Full Walkthrough/);
    expect(guide).toMatch(/Policy Preview/);
    expect(guide).toMatch(/Policy Rollout Controls/);
  });
});

describe("v0.18.0 — Sidebar navigation", () => {
  const config = readSource("docs/.vitepress/config.ts");

  it("has first-run onboarding in the Guides sidebar", () => {
    expect(config).toMatch(/first-run-onboarding/);
  });

  it("lists onboarding as the first guide entry", () => {
    expect(config).toMatch(
      /First-Run Onboarding[\s\S]*Full Walkthrough/
    );
  });

  it("nav Guides link points to onboarding", () => {
    expect(config).toMatch(/text:\s*"Guides".*first-run-onboarding/);
  });
});

describe("v0.18.0 — Setup checklist and templates exist", () => {
  const setupService = readSource(
    "packages/web/src/services/setupService.js"
  );
  const templateService = readSource(
    "packages/web/src/services/templateService.js"
  );
  const component = readSource(
    "packages/web-dashboard/src/components/SetupChecklist.tsx"
  );

  it("setup service has computeSetupStatus pure function", () => {
    expect(setupService).toMatch(/export function computeSetupStatus/);
  });

  it("setup service has 8 checks", () => {
    expect(setupService).toMatch(/github_app_configured/);
    expect(setupService).toMatch(/database_connected/);
    expect(setupService).toMatch(/redis_connected/);
    expect(setupService).toMatch(/installations_linked/);
    expect(setupService).toMatch(/repos_synced/);
    expect(setupService).toMatch(/webhooks_receiving/);
    expect(setupService).toMatch(/gitwire_yml_found/);
    expect(setupService).toMatch(/dry_run_status/);
  });

  it("templates have safety labels", () => {
    expect(templateService).toMatch(/dry-run-protected/);
    expect(templateService).toMatch(/low-risk-live/);
    expect(templateService).toMatch(/safe-to-preview/);
    expect(templateService).toMatch(/review-before-rollout/);
  });

  it("5 templates exist", () => {
    const templatesDir = path.resolve(
      ROOT,
      "packages/web/templates"
    );
    const files = fs.readdirSync(templatesDir).filter((f) => f.endsWith(".yml"));
    expect(files.length).toBe(5);
    expect(files).toContain("starter-dry-run.yml");
    expect(files).toContain("triage-only.yml");
    expect(files).toContain("ci-healing-dry-run.yml");
    expect(files).toContain("open-source-maintainer.yml");
    expect(files).toContain("strict-governance.yml");
  });

  it("component auto-hides when ready", () => {
    expect(component).toMatch(/overall === "ready"/);
    expect(component).toMatch(/return null/);
  });

  it("component shows template suggestions when yml missing", () => {
    expect(component).toMatch(/needsTemplates/);
    expect(component).toMatch(/TemplateSuggestions/);
  });
});
