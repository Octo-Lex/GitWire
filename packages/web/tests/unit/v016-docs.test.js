// tests/unit/v016-docs.test.js
// Verifies v0.16.0 documentation completeness.

import { jest } from "@jest/globals";
import { fileURLToPath } from "url";
import fs from "fs";
import path from "path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

function readSource(relPath) {
  return fs.readFileSync(path.resolve(ROOT, relPath), "utf-8");
}

describe("v0.16.0 — README documentation", () => {
  const readme = readSource("README.md");

  it("has Policy Preview & Simulation section", () => {
    expect(readme).toMatch(/## Policy Preview & Simulation/);
  });

  it("documents non-mutating safety model", () => {
    expect(readme).toMatch(/non-mutating/i);
  });

  it("lists all 4 preview capabilities (validate, preview, simulate, compare, recommend)", () => {
    expect(readme).toMatch(/Validate/i);
    expect(readme).toMatch(/Preview/i);
    expect(readme).toMatch(/Simulate/i);
    expect(readme).toMatch(/Compare impact/i);
    expect(readme).toMatch(/Review guardrail recommendations/i);
  });

  it("documents the recommended rollout workflow", () => {
    expect(readme).toMatch(/\*\*Validate\*\* the proposed policy/);
    expect(readme).toMatch(/\*\*Simulate\*\* against recent/);
    expect(readme).toMatch(/\*\*Compare\*\* proposed behavior/);
    expect(readme).toMatch(/\*\*Review\*\* guardrail recommendations/);
    expect(readme).toMatch(/\*\*Roll out\*\* with dry-run/);
  });

  it("documents AI-dependent limitations", () => {
    expect(readme).toMatch(/would_require_ai/);
    expect(readme).toMatch(/does not fabricate/i);
  });

  it("lists all 4 API endpoints in a table", () => {
    expect(readme).toMatch(/POST \/api\/config\/validate/);
    expect(readme).toMatch(/POST \/api\/config\/simulate/);
    expect(readme).toMatch(/POST \/api\/config\/diff-impact/);
    expect(readme).toMatch(/POST \/api\/config\/recommendations/);
  });

  it("has mermaid rollout workflow diagram", () => {
    expect(readme).toMatch(/```mermaid/);
    expect(readme).toMatch(/graph LR/);
  });

  it("mentions /policy-preview in dashboard routes", () => {
    expect(readme).toMatch(/\/policy-preview/);
  });

  it("documents policy preview in Security Model section", () => {
    expect(readme).toMatch(/Policy preview workflow/);
    expect(readme).toMatch(/Guardrail recommendations/);
  });
});

describe("v0.16.0 — API docs", () => {
  it("policy-preview.md exists", () => {
    expect(fs.existsSync(path.resolve(ROOT, "docs/api/policy-preview.md"))).toBe(true);
  });

  const apiDoc = readSource("docs/api/policy-preview.md");

  it("documents POST /api/config/validate", () => {
    expect(apiDoc).toMatch(/POST \/api\/config\/validate/);
  });

  it("documents POST /api/config/simulate", () => {
    expect(apiDoc).toMatch(/POST \/api\/config\/simulate/);
  });

  it("documents POST /api/config/diff-impact", () => {
    expect(apiDoc).toMatch(/POST \/api\/config\/diff-impact/);
  });

  it("documents POST /api/config/recommendations", () => {
    expect(apiDoc).toMatch(/POST \/api\/config\/recommendations/);
  });

  it("documents risk categories table", () => {
    expect(apiDoc).toMatch(/issue_fix\.enabled/);
    expect(apiDoc).toMatch(/auto_patch/);
    expect(apiDoc).toMatch(/spam_gate/);
  });

  it("documents simulated decisions table", () => {
    expect(apiDoc).toMatch(/would_act/);
    expect(apiDoc).toMatch(/would_skip/);
    expect(apiDoc).toMatch(/dry_run/);
    expect(apiDoc).toMatch(/would_block/);
    expect(apiDoc).toMatch(/would_require_ai/);
  });

  it("documents impact labels table", () => {
    expect(apiDoc).toMatch(/more_permissive/);
    expect(apiDoc).toMatch(/more_restrictive/);
    expect(apiDoc).toMatch(/unchanged/);
    expect(apiDoc).toMatch(/new_dry_run/);
    expect(apiDoc).toMatch(/removes_dry_run/);
    expect(apiDoc).toMatch(/unsupported/);
  });

  it("documents recommendation rules table", () => {
    expect(apiDoc).toMatch(/enable-dry-run-for-risky-policy/);
    expect(apiDoc).toMatch(/keep-dry-run-during-rollout/);
    expect(apiDoc).toMatch(/narrow-triggers/);
    expect(apiDoc).toMatch(/no-recommendations/);
  });

  it("documents AI-dependent sources", () => {
    expect(apiDoc).toMatch(/AI-dependent/i);
    expect(apiDoc).toMatch(/triage.*ai_review.*issue_fix|would_require_ai/);
  });

  it("documents safety model (non-mutating)", () => {
    expect(apiDoc).toMatch(/non-mutating/i);
    expect(apiDoc).toMatch(/No config files saved/);
    expect(apiDoc).toMatch(/No GitHub API writes/);
  });
});

describe("v0.16.0 — Dashboard docs", () => {
  const pagesDoc = readSource("docs/dashboard/pages.md");

  it("has Policy Preview section", () => {
    expect(pagesDoc).toMatch(/## Policy Preview.*policy-preview/);
  });

  it("documents validation panel", () => {
    expect(pagesDoc).toMatch(/Validation panel/);
  });

  it("documents simulation panel", () => {
    expect(pagesDoc).toMatch(/Simulation panel/);
  });

  it("documents impact comparison panel", () => {
    expect(pagesDoc).toMatch(/Impact comparison panel/);
  });

  it("documents recommendations panel", () => {
    expect(pagesDoc).toMatch(/Recommendations panel/);
  });

  it("documents recommended workflow steps", () => {
    expect(pagesDoc).toMatch(/Validate/);
    expect(pagesDoc).toMatch(/Run simulation/);
    expect(pagesDoc).toMatch(/Compare impact/);
    expect(pagesDoc).toMatch(/Generate recommendations/);
  });
});

describe("v0.16.0 — VitePress sidebar", () => {
  const config = readSource("docs/.vitepress/config.ts");

  it("has Policy Preview in API sidebar", () => {
    expect(config).toMatch(/Policy Preview/);
    expect(config).toMatch(/\/api\/policy-preview/);
  });
});

describe("v0.16.0 — version bump", () => {
  // Compare semver numerically so the test does not rot on each new minor.
  function atLeast(actual, min) {
    const [a1, a2] = actual.split(".").map(Number);
    const [m1, m2] = min.split(".").map(Number);
    return a1 > m1 || (a1 === m1 && a2 >= m2);
  }

  it("package.json version is at least 0.16.0", () => {
    const pkg = JSON.parse(readSource("package.json"));
    expect(atLeast(pkg.version, "0.16.0")).toBe(true);
  });

  it("core/src/buildInfo.js version is at least 0.16.0", () => {
    const buildInfo = readSource("packages/core/src/buildInfo.js");
    const m = buildInfo.match(/version:\s*"([^"]+)"/);
    expect(m).not.toBeNull();
    expect(atLeast(m[1], "0.16.0")).toBe(true);
  });
});
