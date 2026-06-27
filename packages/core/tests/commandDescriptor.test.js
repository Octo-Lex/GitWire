// Tests for @gitwire/core command descriptor canonicalization + shape validation.
//
// This is the SHARED pure layer — security policy lives in executor-service.
// These tests assert shape/canonical behavior only.

import { describe, it, expect } from "@jest/globals";
import {
  validateDescriptorShape,
  canonicalizeDescriptor,
  canonicalizePlan,
} from "../src/index.js";

const VALID = {
  command_id: "repo_lint",
  semantic_id: "lint_result",
  source: "ci_workflow",
  argv: ["npx", "--no-install", "eslint", "app.js"],
  target_paths: ["app.js"],
  network: "disabled",
  requires_shell: false,
};

describe("validateDescriptorShape", () => {
  it("accepts a well-formed descriptor", () => {
    expect(validateDescriptorShape(VALID)).toEqual({ ok: true, reasons: [] });
  });

  it("rejects a non-object", () => {
    const r = validateDescriptorShape(null);
    expect(r.ok).toBe(false);
    expect(r.reasons[0]).toMatch(/plain object/);
  });

  it("rejects when required string fields are missing or empty", () => {
    const r = validateDescriptorShape({ ...VALID, command_id: "", semantic_id: 5 });
    expect(r.ok).toBe(false);
    expect(r.reasons.join("; ")).toMatch(/command_id/);
    expect(r.reasons.join("; ")).toMatch(/semantic_id/);
  });

  it("rejects empty or non-string argv", () => {
    expect(validateDescriptorShape({ ...VALID, argv: [] }).ok).toBe(false);
    expect(validateDescriptorShape({ ...VALID, argv: ["ok", 7] }).ok).toBe(false);
    expect(validateDescriptorShape({ ...VALID, argv: "npx" }).ok).toBe(false);
  });

  it("rejects empty or non-string target_paths", () => {
    expect(validateDescriptorShape({ ...VALID, target_paths: [] }).ok).toBe(false);
    expect(validateDescriptorShape({ ...VALID, target_paths: [""] }).ok).toBe(false);
  });
});

describe("canonicalizeDescriptor", () => {
  it("sorts object keys deterministically", () => {
    const c = canonicalizeDescriptor({
      target_paths: ["app.js"],
      semantic_id: "lint_result",
      command_id: "repo_lint",
      argv: ["npx", "eslint"],
      source: "ci_workflow",
      requires_shell: false,
      network: "disabled",
    });
    expect(Object.keys(c)).toEqual(
      ["argv", "command_id", "network", "requires_shell", "semantic_id", "source", "target_paths"]
    );
  });

  it("coerces argv and target_paths elements to strings", () => {
    const c = canonicalizeDescriptor({ ...VALID, argv: ["npx", 42], target_paths: [true] });
    expect(c.argv).toEqual(["npx", "42"]);
    expect(c.target_paths).toEqual(["true"]);
  });

  it("does not mutate the input", () => {
    const input = { ...VALID };
    canonicalizeDescriptor(input);
    expect(input).toEqual({ ...VALID });
  });

  it("preserves shape_invalid identity + reasons without requiring argv", () => {
    const c = canonicalizeDescriptor({
      command_id: "repo_lint",
      semantic_id: "lint_result",
      source: "ci_workflow",
      policy_status: "shape_invalid",
      shape_reasons: ["argv must be a non-empty string array"],
    });
    expect(c.policy_status).toBe("shape_invalid");
    expect(c.shape_reasons).toEqual(["argv must be a non-empty string array"]);
    expect(c.argv).toBeUndefined();
    expect(Object.keys(c)).toEqual(
      ["command_id", "policy_status", "semantic_id", "shape_reasons", "source"]
    );
  });
});

describe("canonicalizePlan", () => {
  it("preserves commands[] order and keys descriptors by command_id", () => {
    const plan = canonicalizePlan({
      commands: ["repo_lint", "repo_test"],
      command_descriptors: {
        repo_test: { ...VALID, command_id: "repo_test", semantic_id: "test_or_build_result" },
        repo_lint: VALID,
      },
    });
    expect(plan.commands).toEqual(["repo_lint", "repo_test"]);
    expect(Object.keys(plan.command_descriptors).sort()).toEqual(["repo_lint", "repo_test"]);
  });

  it("dedupes byte-identical descriptors under the same command_id", () => {
    const plan = canonicalizePlan({
      commands: ["repo_lint"],
      command_descriptors: {
        repo_lint: VALID,
        repo_lint_dup: { ...VALID }, // identical content, different key
      },
    });
    expect(Object.keys(plan.command_descriptors)).toEqual(["repo_lint"]);
  });

  it("throws on conflicting descriptors for the same command_id (fail-closed)", () => {
    expect(() =>
      canonicalizePlan({
        commands: ["repo_lint"],
        command_descriptors: {
          a: VALID,
          b: { ...VALID, argv: ["npx", "eslint", "other.js"] },
        },
      })
    ).toThrow(/conflicting descriptors for command_id "repo_lint"/);
  });

  it("handles plans with no descriptors", () => {
    const plan = canonicalizePlan({ commands: ["lint"], command_descriptors: {} });
    expect(plan).toEqual({ commands: ["lint"], command_descriptors: {} });
  });

  it("throws on non-object plan", () => {
    expect(() => canonicalizePlan(null)).toThrow();
  });
});
