// src/lib/validationPlanAdapter.js
// Validation-plan adapter (v0.23.0 Task 9).
//
// Translates semantic required_validation IDs into executable executor command
// IDs. This is the reconciliation layer between the CI-evidence vocabulary
// (policy_scope_check, test_or_build_result) and the executor-service's
// allowlisted command templates (lint, test, build, typecheck).
//
// Design: Option A→C evolution. Small adapter now, structured to grow into a
// full validation-plan layer where semantic requirements compile into
// executable plans with acceptance policies.
//
// Mappings:
//   test_or_build_result → commands [test, build], acceptance "pass if either"
//   policy_scope_check    → no executor commands, app-side predicate only
//   lint/test/build/typecheck → pass through as executable

// The semantic-to-executable mapping table. Frozen — adding a new semantic ID
// = adding one entry here. Each entry maps to:
//   commands: string[]     — executable command IDs for the executor
//   acceptance: string     — the acceptance policy for this requirement
//   app_side_only: boolean — true = no executor commands (predicate-only)
export const VALIDATION_PLAN_MAPPINGS = Object.freeze({
  test_or_build_result: {
    commands: ["test", "build"],
    acceptance: "test_or_build",
    app_side_only: false,
  },
  lint_result: {
    commands: ["lint"],
    acceptance: "lint_pass",
    app_side_only: false,
  },
  policy_scope_check: {
    commands: [],
    acceptance: "policy_scope_predicate",
    app_side_only: true,
  },
});

// Already-executable command IDs that pass through without translation.
const EXECUTABLE_COMMAND_IDS = new Set(["lint", "test", "build", "typecheck"]);

/**
 * Compile a list of semantic required_validation IDs into an executable
 * validation plan.
 *
 * @param {string[]} requiredValidation — semantic IDs from the CI-evidence envelope
 * @returns {{
 *   executable_commands: string[],  — deduplicated, sorted executor command IDs
 *   acceptance_policy: string,      — how to interpret the command results
 *   unmapped: string[],             — IDs that have no mapping (for diagnostics)
 * }}
 */
export function compileValidationPlan(requiredValidation) {
  const executableSet = new Set();
  const unmapped = [];
  const policies = [];

  for (const id of requiredValidation || []) {
    // Check if it's a semantic ID with a mapping.
    const mapping = VALIDATION_PLAN_MAPPINGS[id];
    if (mapping) {
      for (const cmd of mapping.commands) {
        executableSet.add(cmd);
      }
      policies.push(mapping.acceptance);
      continue;
    }

    // Check if it's already an executable command ID.
    if (EXECUTABLE_COMMAND_IDS.has(id)) {
      executableSet.add(id);
      continue;
    }

    // Unknown — record as unmapped. Do NOT add to executable_commands.
    unmapped.push(id);
  }

  // Derive the composite acceptance policy from the collected sub-policies.
  let acceptancePolicy;
  if (policies.length === 0) {
    // No semantic IDs → all pass-through executables → standard "all must pass".
    acceptancePolicy = "all_must_pass";
  } else if (policies.length === 1) {
    acceptancePolicy = policies[0];
  } else {
    // Multiple semantic requirements → combine with "_and_".
    acceptancePolicy = policies.sort().join("_and_");
  }

  return {
    executable_commands: [...executableSet].sort(),
    acceptance_policy: acceptancePolicy,
    unmapped,
  };
}
