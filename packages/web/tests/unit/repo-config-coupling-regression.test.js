// tests/unit/repo-config-coupling-regression.test.js
//
// Makes the repository's own safety posture visible in review.
//
// The W2-04 safe defaults leave every mutation-capable pillar disabled and
// dry_run on. This repository's .github/.gitwire.yml opts the AI review
// pillar into live mode (dry_run: false) so the review gate operates — that
// setting is GLOBAL: any future PR that enables another mutation-capable
// pillar here inherits live mode immediately, without a second look.
//
// This suite pins the current file shape so any change to that coupling
// surfaces as a test diff instead of slipping through.
//
// Recorded by the 2026-09-30 chain review (finding 4, #387).

import fs from "fs";
import path from "path";
import yaml from "js-yaml";
import { fileURLToPath } from "url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const configPath = path.join(ROOT, ".github", ".gitwire.yml");

const MUTATION_CAPABLE_PILLARS = [
  "triage", "ci_healing", "maintainer", "issue_fix",
  "enforcement", "trust", "merge_queue", "ai_review", "spam_gate",
];

function loadRepoConfig() {
  const text = fs.readFileSync(configPath, "utf-8");
  return yaml.load(text);
}

describe("repository config safety-posture coupling", () => {
  it("the repo config file exists and parses", () => {
    expect(() => loadRepoConfig()).not.toThrow();
  });

  it("dry_run is set explicitly AND currently false (deliberate live-mode opt-in for AI review)", () => {
    const config = loadRepoConfig();
    // Both facts are load-bearing: someone chose, and the choice is live mode
    // because the AI review gate must actually run. A flip to true must fail
    // here and be a conscious review decision, not a silent drift.
    expect(Object.prototype.hasOwnProperty.call(config.settings ?? {}, "dry_run")).toBe(true);
    expect(config.settings.dry_run).toBe(false);
  });

  it("every enabled pillar is enumerated explicitly — nothing rides implicit defaults", () => {
    const config = loadRepoConfig();
    const enabled = Object.entries(config.pillars ?? {})
      .filter(([, v]) => v?.enabled === true)
      .map(([k]) => k);
    // Currently exactly one: ai_review. If this list grows, the diff of THIS
    // test is the place a reviewer must confirm the new pillar is intended
    // to run in live mode (dry_run is global).
    expect(enabled.sort()).toEqual(["ai_review"]);
  });

  it("no mutation-capable pillar is enabled beyond the explicitly enumerated set", () => {
    const config = loadRepoConfig();
    const enabled = new Set(
      Object.entries(config.pillars ?? {}).filter(([, v]) => v?.enabled === true).map(([k]) => k),
    );
    const unexpected = MUTATION_CAPABLE_PILLARS.filter((p) => enabled.has(p) && p !== "ai_review");
    expect(unexpected).toEqual([]);
  });
});
