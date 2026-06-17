// tests/unit/v017-docs.test.js
// Verifies v0.17.0 documentation completeness.

import { jest } from "@jest/globals";
import { fileURLToPath } from "url";
import fs from "fs";
import path from "path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

function readSource(relPath) {
  return fs.readFileSync(path.resolve(ROOT, relPath), "utf-8");
}

describe("v0.17.0 — README documentation", () => {
  const readme = readSource("README.md");

  it("has Policy Rollout Controls section", () => {
    expect(readme).toMatch(/## Policy Rollout Controls/);
  });

  it("documents rollout lifecycle with mermaid diagram", () => {
    expect(readme).toMatch(/```mermaid/i);
    expect(readme).toMatch(/\[draft\]/);
    expect(readme).toMatch(/\[validated\]/);
    expect(readme).toMatch(/\[review_ready\]/);
    expect(readme).toMatch(/\[approved\]/);
    expect(readme).toMatch(/\[promoted\]/);
  });

  it("documents how it works (6 steps)", () => {
    expect(readme).toMatch(/Create.*rollout plan/);
    expect(readme).toMatch(/Attach evidence/);
    expect(readme).toMatch(/Request review/);
    expect(readme).toMatch(/Approve or reject/);
    expect(readme).toMatch(/Promote/);
    expect(readme).toMatch(/Roll back/);
  });

  it("documents safety guarantees", () => {
    expect(readme).toMatch(/only path that writes policy/);
    expect(readme).toMatch(/Write-before-transition/);
    expect(readme).toMatch(/Previous policy snapshot/);
    expect(readme).toMatch(/Rollback evidence.*config hashes/);
    expect(readme).toMatch(/critical recommendation acknowledgement/);
    expect(readme).toMatch(/All 4 evidence types required/);
  });

  it("lists all 8 API endpoints in a table", () => {
    expect(readme).toMatch(/POST \/api\/rollouts\b/);
    expect(readme).toMatch(/GET \/api\/rollouts\b/);
    expect(readme).toMatch(/GET \/api\/rollouts\/:id/);
    expect(readme).toMatch(/PATCH \/api\/rollouts\/:id\/evidence/);
    expect(readme).toMatch(/POST \/api\/rollouts\/:id\/approve/);
    expect(readme).toMatch(/POST \/api\/rollouts\/:id\/reject/);
    expect(readme).toMatch(/POST \/api\/rollouts\/:id\/promote/);
    expect(readme).toMatch(/POST \/api\/rollouts\/:id\/rollback/);
  });

  it("links to Rollout API docs", () => {
    expect(readme).toMatch(/docs\/api\/rollouts\.md/);
  });

  it("mentions /rollouts dashboard page", () => {
    expect(readme).toMatch(/\/rollouts/);
  });

  it("documents rollout controls in Security Model", () => {
    expect(readme).toMatch(/Policy rollout controls/);
    expect(readme).toMatch(/governed lifecycle/);
    expect(readme).toMatch(/Promotion is the only write path/);
    expect(readme).toMatch(/Previous policy snapshots/);
  });
});

describe("v0.17.0 — API docs", () => {
  it("rollouts.md exists", () => {
    expect(fs.existsSync(path.resolve(ROOT, "docs/api/rollouts.md"))).toBe(true);
  });

  const apiDoc = readSource("docs/api/rollouts.md");

  it("documents lifecycle diagram", () => {
    expect(apiDoc).toMatch(/draft.*validated.*review_ready.*approved.*promoted/);
  });

  it("lists terminal states", () => {
    expect(apiDoc).toMatch(/rolled_back.*rejected.*cancelled/);
  });

  it("documents POST /api/rollouts (create)", () => {
    expect(apiDoc).toMatch(/POST \/api\/rollouts/);
  });

  it("documents GET /api/rollouts (list)", () => {
    expect(apiDoc).toMatch(/GET \/api\/rollouts/);
  });

  it("documents GET /api/rollouts/:id (detail)", () => {
    expect(apiDoc).toMatch(/GET \/api\/rollouts\/:id/);
  });

  it("documents PATCH evidence", () => {
    expect(apiDoc).toMatch(/PATCH \/api\/rollouts\/:id\/evidence/);
  });

  it("documents approve endpoint with rules", () => {
    expect(apiDoc).toMatch(/POST \/api\/rollouts\/:id\/approve/);
    expect(apiDoc).toMatch(/review_ready/i);
    expect(apiDoc).toMatch(/critical recommendation.*acknowledged/i);
  });

  it("documents reject endpoint", () => {
    expect(apiDoc).toMatch(/POST \/api\/rollouts\/:id\/reject/);
  });

  it("documents promote endpoint as ONLY write path", () => {
    expect(apiDoc).toMatch(/only path that writes policy/);
    expect(apiDoc).toMatch(/POST \/api\/rollouts\/:id\/promote/);
  });

  it("documents promotion execution sequence", () => {
    expect(apiDoc).toMatch(/Capture previous config snapshot/);
    expect(apiDoc).toMatch(/Write proposed config/);
    expect(apiDoc).toMatch(/write fails.*state remains/);
  });

  it("documents rollback endpoint", () => {
    expect(apiDoc).toMatch(/POST \/api\/rollouts\/:id\/rollback/);
  });

  it("documents rollback evidence with hashes", () => {
    expect(apiDoc).toMatch(/restored_previous_config/);
    expect(apiDoc).toMatch(/replaced_config_captured/);
    expect(apiDoc).toMatch(/previous_config_hash/);
    expect(apiDoc).toMatch(/promoted_config_hash/);
    expect(apiDoc).toMatch(/replaced_config_hash/);
  });

  it("documents generic transition endpoint", () => {
    expect(apiDoc).toMatch(/POST \/api\/rollouts\/:id\/transition/);
  });

  it("documents dashboard integration", () => {
    expect(apiDoc).toMatch(/Dashboard/);
    expect(apiDoc).toMatch(/\/rollouts/);
  });
});

describe("v0.17.0 — Dashboard docs", () => {
  const pagesDoc = readSource("docs/dashboard/pages.md");

  it("has Rollouts section", () => {
    expect(pagesDoc).toMatch(/## Rollouts.*rollouts/);
  });

  it("documents list view", () => {
    expect(pagesDoc).toMatch(/List view/);
    expect(pagesDoc).toMatch(/status badges/);
  });

  it("documents detail view", () => {
    expect(pagesDoc).toMatch(/Detail view/i);
    expect(pagesDoc).toMatch(/lifecycle timeline/i);
    expect(pagesDoc).toMatch(/evidence cards/i);
  });

  it("documents policy snapshots", () => {
    expect(pagesDoc).toMatch(/Collapsible redacted/);
  });

  it("documents rollback evidence", () => {
    expect(pagesDoc).toMatch(/Config hashes/);
  });

  it("documents actions panel", () => {
    expect(pagesDoc).toMatch(/State-driven actions/);
  });

  it("documents confirmation modal", () => {
    expect(pagesDoc).toMatch(/Confirmation modal/);
    expect(pagesDoc).toMatch(/amber warning/);
    expect(pagesDoc).toMatch(/red warning/);
  });

  it("documents critical recommendation acknowledgement", () => {
    expect(pagesDoc).toMatch(/Critical recommendation acknowledgement/);
  });

  it("has state-driven actions table", () => {
    expect(pagesDoc).toMatch(/draft.*cancel/);
    expect(pagesDoc).toMatch(/review_ready.*approve.*reject.*cancel/);
    expect(pagesDoc).toMatch(/approved.*promote/);
    expect(pagesDoc).toMatch(/promoted.*rollback/);
  });
});

describe("v0.17.0 — VitePress sidebar", () => {
  const config = readSource("docs/.vitepress/config.ts");

  it("has Rollouts in API sidebar", () => {
    expect(config).toMatch(/Rollouts/);
    expect(config).toMatch(/\/api\/rollouts/);
  });
});

describe("v0.17.0 — version bump", () => {
  it("package.json version is 0.17.0", () => {
    const pkg = readSource("package.json");
    expect(pkg).toMatch(/"version": "0.17.0"/);
  });

  it("core/src/index.js VERSION is 0.17.0", () => {
    const core = readSource("packages/core/src/index.js");
    expect(core).toMatch(/VERSION = "0.17.0"/);
  });
});
