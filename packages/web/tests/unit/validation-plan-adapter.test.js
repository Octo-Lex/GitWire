// Tests for the validation-plan adapter (v0.23.0 Task 9).
//
// Translates semantic required_validation IDs into executable executor command
// IDs. This is the reconciliation layer that unblocks the DB-backed receipt
// proof path — without it, the production CI-evidence envelope sends
// `policy_scope_check` and `test_or_build_result` to the executor, which
// rejects them as non-allowlisted → inconclusive.
//
// Design: Option A→C evolution. Small adapter now, structured to grow into a
// full validation-plan layer.

import { describe, it, expect } from "@jest/globals";
import {
  compileValidationPlan,
  VALIDATION_PLAN_MAPPINGS,
} from "../../src/lib/validationPlanAdapter.js";

describe("compileValidationPlan — shape", () => {
  it("returns an object with executable_commands + acceptance_policy + unmapped", () => {
    const plan = compileValidationPlan(["test_or_build_result"]);
    expect(plan).toHaveProperty("executable_commands");
    expect(plan).toHaveProperty("acceptance_policy");
    expect(plan).toHaveProperty("unmapped");
    expect(Array.isArray(plan.executable_commands)).toBe(true);
  });
});

describe("compileValidationPlan — test_or_build_result", () => {
  it("maps test_or_build_result to [test, build]", () => {
    const plan = compileValidationPlan(["test_or_build_result"]);
    expect(plan.executable_commands).toContain("test");
    expect(plan.executable_commands).toContain("build");
  });

  it("sets acceptance_policy = test_or_build (pass if either passes)", () => {
    const plan = compileValidationPlan(["test_or_build_result"]);
    expect(plan.acceptance_policy).toBe("test_or_build");
  });
});

describe("compileValidationPlan — policy_scope_check", () => {
  it("maps policy_scope_check to no executable commands (app-side predicate)", () => {
    const plan = compileValidationPlan(["policy_scope_check"]);
    expect(plan.executable_commands).toEqual([]);
  });

  it("sets acceptance_policy = policy_scope_predicate (no executor commands)", () => {
    const plan = compileValidationPlan(["policy_scope_check"]);
    expect(plan.acceptance_policy).toBe("policy_scope_predicate");
  });
});

describe("compileValidationPlan — combined requirements", () => {
  it("maps both policy_scope_check + test_or_build_result", () => {
    const plan = compileValidationPlan(["policy_scope_check", "test_or_build_result"]);
    expect(plan.executable_commands).toContain("test");
    expect(plan.executable_commands).toContain("build");
    // Acceptance policy reflects both requirements.
    expect(plan.acceptance_policy).toBe("policy_scope_predicate_and_test_or_build");
  });

  it("deduplicates executable commands", () => {
    // If multiple requirements map to the same commands, deduplicate.
    const plan = compileValidationPlan(["test_or_build_result", "lint"]);
    const cmds = plan.executable_commands;
    expect(new Set(cmds).size).toBe(cmds.length);
    expect(cmds).toContain("test");
    expect(cmds).toContain("build");
    expect(cmds).toContain("lint");
  });
});

describe("compileValidationPlan — already-executable IDs pass through", () => {
  it("passes lint through as executable", () => {
    const plan = compileValidationPlan(["lint"]);
    expect(plan.executable_commands).toContain("lint");
  });

  it("passes test through as executable", () => {
    const plan = compileValidationPlan(["test"]);
    expect(plan.executable_commands).toContain("test");
  });

  it("passes build through as executable", () => {
    const plan = compileValidationPlan(["build"]);
    expect(plan.executable_commands).toContain("build");
  });
});

describe("compileValidationPlan — unknown IDs", () => {
  it("records unknown IDs in unmapped and does NOT add them to executable_commands", () => {
    const plan = compileValidationPlan(["unknown_command_xyz"]);
    expect(plan.unmapped).toContain("unknown_command_xyz");
    expect(plan.executable_commands).not.toContain("unknown_command_xyz");
  });

  it("separates mapped and unmapped when both are present", () => {
    const plan = compileValidationPlan(["test_or_build_result", "unknown_xyz"]);
    expect(plan.executable_commands).toContain("test");
    expect(plan.unmapped).toContain("unknown_xyz");
  });
});

describe("VALIDATION_PLAN_MAPPINGS", () => {
  it("is a frozen object documenting the semantic→executable mapping", () => {
    expect(Object.isFrozen(VALIDATION_PLAN_MAPPINGS)).toBe(true);
    expect(VALIDATION_PLAN_MAPPINGS).toHaveProperty("test_or_build_result");
    expect(VALIDATION_PLAN_MAPPINGS).toHaveProperty("policy_scope_check");
  });
});
