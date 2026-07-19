// tests/unit/source-of-truth-gate.test.js
//
// Negative tests for the source-of-truth drift check.
// Proves each documented value is validated against its implementation source.

import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkSourceOfTruth } from "../../../../scripts/check-source-of-truth.mjs";

// Resolve repo root the same way the module does: from import.meta.url of
// THIS file, up to the repo root (packages/web/tests/unit/ → 3 levels up).
const __filename_test = fileURLToPath(import.meta.url);
const __dirname_test = path.dirname(__filename_test);
// The module resolves its own REPO_ROOT from its import.meta.url location
// (scripts/ → one level up). We need to match that path for file mutation.
const MODULE_REPO_ROOT = path.resolve(__dirname_test, "../../../..");
const AGENTS_PATH = path.join(MODULE_REPO_ROOT, "AGENTS.md");

// Verify the path resolves correctly
const agentsExists = fs.existsSync(AGENTS_PATH);

describe("source-of-truth gate — current repo is consistent", () => {
  it("AGENTS.md is reachable at the resolved path", () => {
    expect(agentsExists).toBe(true);
  });

  it("returns zero violations on the checked-out tree", () => {
    const { violations } = checkSourceOfTruth(MODULE_REPO_ROOT);
    expect(violations).toEqual([]);
  });

  it("derives actual values from implementation sources", () => {
    const { actual } = checkSourceOfTruth(MODULE_REPO_ROOT);
    expect(actual.services).toBe(10);
    expect(actual.workers).toBe(14);
    expect(actual.migrations).toBe(37);
    expect(actual.version).toBe("0.23.1");
  });
});

// Drift-detection tests modify AGENTS.md in place, then restore it.
// They only run if the file is reachable.
const driftDescribe = agentsExists ? describe : describe.skip;

driftDescribe("source-of-truth gate — drift detection", () => {
  let original = "";

  beforeEach(() => {
    original = fs.readFileSync(AGENTS_PATH, "utf8");
  });

  afterEach(() => {
    if (original) {
      fs.writeFileSync(AGENTS_PATH, original);
    }
  });

  it("detects version drift", () => {
    const modified = original.replace("0.23.1", "0.99.0");
    fs.writeFileSync(AGENTS_PATH, modified);
    const { violations } = checkSourceOfTruth(MODULE_REPO_ROOT);
    expect(violations.some(v => v.field === "version")).toBe(true);
  });

  it("detects worker count drift", () => {
    const modified = original.replace(/14 BullMQ worker/, "99 BullMQ worker");
    fs.writeFileSync(AGENTS_PATH, modified);
    const { violations } = checkSourceOfTruth(MODULE_REPO_ROOT);
    expect(violations.some(v => v.field === "worker count")).toBe(true);
  });

  it("detects migration count drift", () => {
    const modified = original.replace(/37 SQL migrations/, "99 SQL migrations");
    fs.writeFileSync(AGENTS_PATH, modified);
    const { violations } = checkSourceOfTruth(MODULE_REPO_ROOT);
    expect(violations.some(v => v.field === "migration count")).toBe(true);
  });
});
