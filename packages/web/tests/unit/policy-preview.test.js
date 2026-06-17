// tests/unit/policy-preview.test.js
// Tests for the policy preview dashboard page.
// Verifies UI structure, safety labeling, input/validation flow, and result rendering.

import { jest } from "@jest/globals";
import { fileURLToPath } from "url";
import fs from "fs";
import path from "path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

function readSource(relPath) {
  return fs.readFileSync(path.resolve(ROOT, relPath), "utf-8");
}

describe("Policy Preview Dashboard — page structure", () => {
  const source = readSource("packages/web-dashboard/src/app/policy-preview/page.tsx");

  it("exists as a page", () => {
    expect(source).toBeTruthy();
    expect(source.length).toBeGreaterThan(1000);
  });

  it("is a client component", () => {
    expect(source).toMatch(/"use client"/);
  });

  it("has Policy Preview title", () => {
    expect(source).toMatch(/Policy Preview/);
  });

  it("has YAML textarea input", () => {
    expect(source).toMatch(/textarea/);
    expect(source).toMatch(/gitwire\.yml/);
  });

  it("has Validate policy button", () => {
    expect(source).toMatch(/Validate policy/);
  });

  it("has Reset to example button", () => {
    expect(source).toMatch(/Reset to example/);
  });

  it("has Clear button", () => {
    expect(source).toMatch(/Clear/);
  });
});

describe("Policy Preview Dashboard — safety", () => {
  const source = readSource("packages/web-dashboard/src/app/policy-preview/page.tsx");

  it("has safety banner stating non-mutating", () => {
    expect(source).toMatch(/PREVIEW/);
    expect(source).toMatch(/does not save config or mutate GitHub/i);
  });

  it("subtitle says non-mutating analysis", () => {
    expect(source).toMatch(/non-mutating/i);
  });
});

describe("Policy Preview Dashboard — API call", () => {
  const source = readSource("packages/web-dashboard/src/app/policy-preview/page.tsx");

  it("calls POST /api/config/validate", () => {
    expect(source).toMatch(/\/api\/config\/validate/);
    expect(source).toMatch(/POST/);
  });

  it("sends yaml in body", () => {
    expect(source).toMatch(/yaml.*yamlInput/);
  });

  it("handles loading state", () => {
    expect(source).toMatch(/loading/i);
    expect(source).toMatch(/Validating/);
  });

  it("handles API errors", () => {
    expect(source).toMatch(/apiError/);
    expect(source).toMatch(/Validation failed/);
  });

  it("disables button while loading", () => {
    expect(source).toMatch(/disabled.*loading/);
  });
});

describe("Policy Preview Dashboard — summary cards", () => {
  const source = readSource("packages/web-dashboard/src/app/policy-preview/page.tsx");

  it("shows Valid/Invalid status", () => {
    expect(source).toMatch(/Valid/);
    expect(source).toMatch(/Invalid/);
  });

  it("shows Dry-Run On/Off", () => {
    expect(source).toMatch(/Dry-Run/);
    expect(source).toMatch(/On/);
    expect(source).toMatch(/Off/);
  });

  it("shows enabled pillars count", () => {
    expect(source).toMatch(/Pillars/);
    expect(source).toMatch(/enabled_pillars\.length/);
  });

  it("shows risk count with unmitigated breakdown", () => {
    expect(source).toMatch(/Risks/);
    expect(source).toMatch(/risky_settings\.length/);
    expect(source).toMatch(/unmitigated/);
  });

  it("shows warning count", () => {
    expect(source).toMatch(/Warnings/);
    expect(source).toMatch(/warnings\.length/);
  });
});

describe("Policy Preview Dashboard — errors panel", () => {
  const source = readSource("packages/web-dashboard/src/app/policy-preview/page.tsx");

  it("renders errors when present", () => {
    expect(source).toMatch(/result\.errors\.length/);
    expect(source).toMatch(/Errors/);
  });

  it("shows error path and message", () => {
    expect(source).toMatch(/e\.path/);
    expect(source).toMatch(/e\.message/);
  });
});

describe("Policy Preview Dashboard — enabled pillars display", () => {
  const source = readSource("packages/web-dashboard/src/app/policy-preview/page.tsx");

  it("lists enabled pillars as badges", () => {
    expect(source).toMatch(/Enabled Pillars/);
    expect(source).toMatch(/enabled_pillars\.map/);
  });
});

describe("Policy Preview Dashboard — risk panel", () => {
  const source = readSource("packages/web-dashboard/src/app/policy-preview/page.tsx");

  it("renders risky settings when present", () => {
    expect(source).toMatch(/Risky Settings/);
    expect(source).toMatch(/risky_settings/);
  });

  it("groups risks by severity (high, medium, low)", () => {
    expect(source).toMatch(/highRisks/);
    expect(source).toMatch(/mediumRisks/);
    expect(source).toMatch(/lowRisks/);
  });

  it("shows risk path and reason", () => {
    expect(source).toMatch(/risk\.path/);
    expect(source).toMatch(/risk\.reason/);
  });

  it("shows dry-run mitigation status (RiskRow component)", () => {
    expect(source).toMatch(/RiskRow/);
    expect(source).toMatch(/mitigated_by_dry_run/);
    expect(source).toMatch(/dry-run safe/);
    expect(source).toMatch(/dry-run off/);
    expect(source).toMatch(/not mitigated/);
  });

  it("separates mitigated from unmitigated risks", () => {
    expect(source).toMatch(/mitigated/);
    expect(source).toMatch(/unmitigatedRisks/);
  });
});

describe("Policy Preview Dashboard — warnings panel", () => {
  const source = readSource("packages/web-dashboard/src/app/policy-preview/page.tsx");

  it("renders warnings when present", () => {
    expect(source).toMatch(/Warnings/);
    expect(source).toMatch(/warnings\.map/);
  });

  it("shows warning path and message", () => {
    expect(source).toMatch(/w\.path/);
    expect(source).toMatch(/w\.message/);
  });

  it("shows warning severity", () => {
    expect(source).toMatch(/w\.severity/);
  });
});

describe("Policy Preview Dashboard — normalized config", () => {
  const source = readSource("packages/web-dashboard/src/app/policy-preview/page.tsx");

  it("has collapsible normalized config section", () => {
    expect(source).toMatch(/Normalized Config/);
    expect(source).toMatch(/showConfig/);
  });

  it("labels config as redacted", () => {
    expect(source).toMatch(/redacted/i);
  });

  it("only shows config when valid", () => {
    expect(source).toMatch(/result\.valid/);
  });
});

describe("Policy Preview Dashboard — parsed timestamp", () => {
  const source = readSource("packages/web-dashboard/src/app/policy-preview/page.tsx");

  it("shows parsed_at timestamp", () => {
    expect(source).toMatch(/parsed_at/);
    expect(source).toMatch(/toLocaleString/);
  });
});

describe("Policy Preview — sidebar navigation", () => {
  const source = readSource("packages/web-dashboard/src/components/Sidebar.tsx");

  it("includes policy-preview in navigation", () => {
    expect(source).toMatch(/\/policy-preview/);
    expect(source).toMatch(/Policy Preview/);
  });
});
