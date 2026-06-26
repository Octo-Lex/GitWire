// Regression test for Task 9 P1 blocker: the recorder must compare executed
// commands against the COMPILED validation plan (executable IDs), not the raw
// semantic IDs from the envelope.
//
// Scenario: envelope has semantic IDs (policy_scope_check, test_or_build_result)
//           executor runs compiled commands (test, build)
//           recorder must NOT reject as "missing: policy_scope_check"

import { describe, it, expect } from "@jest/globals";
import { compileValidationPlan } from "../../src/lib/validationPlanAdapter.js";

describe("Task 9 P1 regression: compiled commands vs semantic envelope IDs", () => {
  it("test_or_build_result + policy_scope_check compiles to [build, test] not semantic IDs", () => {
    const envelope = { required_validation: ["policy_scope_check", "test_or_build_result"] };
    const plan = compileValidationPlan(envelope.required_validation);
    // The recorder must use plan.executable_commands as requiredCommands,
    // NOT envelope.required_validation.
    expect(plan.executable_commands).toEqual(["build", "test"]);
    // These semantic IDs must NOT appear in the compiled commands.
    expect(plan.executable_commands).not.toContain("policy_scope_check");
    expect(plan.executable_commands).not.toContain("test_or_build_result");
  });

  it("an executed set of [build, test] satisfies the compiled plan for this envelope", () => {
    const envelope = { required_validation: ["policy_scope_check", "test_or_build_result"] };
    const plan = compileValidationPlan(envelope.required_validation);
    const executed = ["build", "test"].sort();

    // The command-set check that recordVerificationResult does:
    // requiredCommands = compiledPlan.executable_commands
    // executedCommands = the actual commands that ran
    // For the test to pass: every required command must be in the executed set.
    const required = new Set(plan.executable_commands);
    const executedSet = new Set(executed);
    const missing = [...required].filter(c => !executedSet.has(c));
    const disallowed = [...executedSet].filter(c => !required.has(c));

    expect(missing).toEqual([]);  // no required commands missing
    expect(disallowed).toEqual([]); // no unexpected commands
  });
});
