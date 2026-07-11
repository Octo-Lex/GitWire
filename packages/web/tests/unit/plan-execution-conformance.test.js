// tests/unit/plan-execution-conformance.test.js
//
// P0 adversarial test matrix for the plan-execution conformance model.
// Tests the pure conformance engine (planExecutionConformance.js) and
// result eligibility (resultEligibility.js) directly.
//
// This is the proof that the safety property works: a receipt whose plan
// says descriptor but whose execution ran legacy CANNOT pass.

import {
  normalizeNormativeSteps,
  normalizeExecutedSteps,
  derivePlanExecutionRelation,
} from "../../src/lib/planExecutionConformance.js";
import { deriveResultEligibility, mapResultOutcome } from "../../src/lib/resultEligibility.js";
import { computeValidationPlanHash } from "@gitwire/core";

// ── Fixtures ────────────────────────────────────────────────────────────────

const DESCRIPTOR_STEP = {
  step_id: "lint_result:0",
  sequence: 0,
  semantic: "lint_result",
  command_source: "ci_workflow_descriptor",
  command_id: "repo_lint",
  argv: ["npx", "--no-install", "eslint", "app.js"],
  target_paths: ["app.js"],
};

const LEGACY_STEP = {
  step_id: "lint_result:0",
  sequence: 0,
  semantic: "lint_result",
  command_source: "legacy_template",
  command_id: "lint",
  argv: null,
  target_paths: null,
};

const DESCRIPTOR_EXECUTED = {
  step_id: "lint_result:0",
  sequence: 0,
  command_source: "ci_workflow_descriptor",
  executed_argv: ["npx", "--no-install", "eslint", "app.js"],
  target_paths: ["app.js"],
  exit_status: 0,
};

const LEGACY_EXECUTED = {
  step_id: "lint_result:0",
  sequence: 0,
  command_source: "fallback_template",
  executed_argv: ["npm", "run", "lint", "--"],
  target_paths: null,
  exit_status: 0,
};

function planWith(steps, opts = {}) {
  return {
    plan_schema_version: 2,
    descriptor_policy: { activation: opts.activation || "observed" },
    normative_steps: steps,
    required_execution_features: opts.features || ["normative-step-reporting-v1"],
    executable_commands: steps.map(s => s.command_id).filter(Boolean),
    command_descriptors: {},
    acceptance_policy: "lint_pass",
  };
}

function execWith(steps, opts = {}) {
  return {
    executed_steps: steps,
    overall: opts.overall || "pass",
    inconclusive_reason: opts.reason,
    command_results: [],
  };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("P0: plan-execution conformance matrix", () => {
  // 1. Observed + legacy exact → exact
  test("observed mode + legacy template execution → exact", () => {
    const plan = planWith([LEGACY_STEP], { activation: "observed" });
    const exec = execWith([{
      ...LEGACY_EXECUTED,
      command_source: "legacy_template", // matches plan
    }]);
    const norm = normalizeNormativeSteps(plan);
    const execNorm = normalizeExecutedSteps(exec);
    const result = derivePlanExecutionRelation({
      plannedSteps: norm.steps,
      executedSteps: execNorm.steps,
      executionAttempted: execNorm.executionAttempted,
      evidenceComplete: norm.evidenceComplete && execNorm.evidenceComplete,
    });
    expect(result.relation).toBe("exact");
  });

  // 2. Selected + descriptor exact → exact
  test("selected mode + descriptor execution → exact", () => {
    const plan = planWith([DESCRIPTOR_STEP], { activation: "selected", features: ["normative-step-reporting-v1", "command-descriptor-v1"] });
    const exec = execWith([DESCRIPTOR_EXECUTED]);
    const norm = normalizeNormativeSteps(plan);
    const execNorm = normalizeExecutedSteps(exec);
    const result = derivePlanExecutionRelation({
      plannedSteps: norm.steps,
      executedSteps: execNorm.steps,
      executionAttempted: execNorm.executionAttempted,
      evidenceComplete: norm.evidenceComplete && execNorm.evidenceComplete,
    });
    expect(result.relation).toBe("exact");
  });

  // 3. Selected + descriptor plan but legacy executed → divergent
  test("selected mode + descriptor plan but legacy executed → divergent", () => {
    const plan = planWith([DESCRIPTOR_STEP], { activation: "selected" });
    const exec = execWith([LEGACY_EXECUTED]);
    const norm = normalizeNormativeSteps(plan);
    const execNorm = normalizeExecutedSteps(exec);
    const result = derivePlanExecutionRelation({
      plannedSteps: norm.steps,
      executedSteps: execNorm.steps,
      executionAttempted: execNorm.executionAttempted,
      evidenceComplete: norm.evidenceComplete && execNorm.evidenceComplete,
    });
    expect(result.relation).toBe("divergent");
    expect(result.reason_codes.some(r => r.includes("command_source_mismatch"))).toBe(true);
  });

  // 4. Missing execution evidence → unverifiable (not none)
  test("missing executed_steps → unverifiable", () => {
    const plan = planWith([DESCRIPTOR_STEP]);
    const exec = { overall: "inconclusive", inconclusive_reason: "executor_service_url_not_configured" };
    const norm = normalizeNormativeSteps(plan);
    const execNorm = normalizeExecutedSteps(exec);
    const result = derivePlanExecutionRelation({
      plannedSteps: norm.steps,
      executedSteps: execNorm.steps,
      executionAttempted: execNorm.executionAttempted,
      evidenceComplete: norm.evidenceComplete && execNorm.evidenceComplete,
    });
    // Missing executed_steps field → evidence incomplete → unverifiable
    expect(result.relation).toBe("unverifiable");
  });

  // 5. Duplicate normative step IDs → divergent
  test("duplicate planned step IDs → divergent", () => {
    const plan = planWith([DESCRIPTOR_STEP, DESCRIPTOR_STEP]);
    const exec = execWith([DESCRIPTOR_EXECUTED, DESCRIPTOR_EXECUTED]);
    const norm = normalizeNormativeSteps(plan);
    const execNorm = normalizeExecutedSteps(exec);
    const result = derivePlanExecutionRelation({
      plannedSteps: norm.steps,
      executedSteps: execNorm.steps,
      executionAttempted: execNorm.executionAttempted,
      evidenceComplete: norm.evidenceComplete && execNorm.evidenceComplete,
    });
    expect(result.relation).toBe("divergent");
    expect(result.reason_codes).toContain("duplicate_planned_step_ids");
  });

  // 6. Reordered commands → divergent (sequence mismatch)
  test("reordered steps → divergent (sequence mismatch)", () => {
    const step1 = { ...DESCRIPTOR_STEP, step_id: "lint_result:0", sequence: 0, argv: ["npx", "--no-install", "eslint", "a.js"], target_paths: ["a.js"] };
    const step2 = { ...DESCRIPTOR_STEP, step_id: "test_or_build_result:0", sequence: 1, argv: ["node", "test.js"], target_paths: ["test.js"] };
    // Executed in reversed order — sequences don't match
    const exec1 = { ...DESCRIPTOR_EXECUTED, step_id: "test_or_build_result:0", sequence: 0, executed_argv: ["node", "test.js"], target_paths: ["test.js"] };
    const exec2 = { ...DESCRIPTOR_EXECUTED, step_id: "lint_result:0", sequence: 1, executed_argv: ["npx", "--no-install", "eslint", "a.js"], target_paths: ["a.js"] };
    const plan = planWith([step1, step2]);
    const exec = execWith([exec1, exec2]);
    const norm = normalizeNormativeSteps(plan);
    const execNorm = normalizeExecutedSteps(exec);
    const result = derivePlanExecutionRelation({
      plannedSteps: norm.steps,
      executedSteps: execNorm.steps,
      executionAttempted: execNorm.executionAttempted,
      evidenceComplete: norm.evidenceComplete && execNorm.evidenceComplete,
    });
    expect(result.relation).toBe("divergent");
    expect(result.reason_codes.some(r => r.includes("sequence_mismatch"))).toBe(true);
  });

  // 7. Single-argument difference → divergent
  test("single argv difference → divergent", () => {
    const plan = planWith([DESCRIPTOR_STEP]);
    const exec = execWith([{
      ...DESCRIPTOR_EXECUTED,
      executed_argv: ["npx", "--no-install", "eslint", "other.js"], // different target file
    }]);
    const norm = normalizeNormativeSteps(plan);
    const execNorm = normalizeExecutedSteps(exec);
    const result = derivePlanExecutionRelation({
      plannedSteps: norm.steps,
      executedSteps: execNorm.steps,
      executionAttempted: execNorm.executionAttempted,
      evidenceComplete: norm.evidenceComplete && execNorm.evidenceComplete,
    });
    expect(result.relation).toBe("divergent");
    expect(result.reason_codes.some(r => r.includes("argv_mismatch"))).toBe(true);
  });

  // 8. Target path normalization difference → divergent
  test("target_paths difference → divergent", () => {
    const plan = planWith([DESCRIPTOR_STEP]);
    const exec = execWith([{
      ...DESCRIPTOR_EXECUTED,
      target_paths: ["other.js"], // different path
    }]);
    const norm = normalizeNormativeSteps(plan);
    const execNorm = normalizeExecutedSteps(exec);
    const result = derivePlanExecutionRelation({
      plannedSteps: norm.steps,
      executedSteps: execNorm.steps,
      executionAttempted: execNorm.executionAttempted,
      evidenceComplete: norm.evidenceComplete && execNorm.evidenceComplete,
    });
    expect(result.relation).toBe("divergent");
    expect(result.reason_codes.some(r => r.includes("target_paths_mismatch"))).toBe(true);
  });

  // 9. Extra execution step → divergent
  test("extra executed step → divergent", () => {
    const plan = planWith([DESCRIPTOR_STEP]);
    const exec = execWith([DESCRIPTOR_EXECUTED, { ...DESCRIPTOR_EXECUTED, step_id: "extra:0" }]);
    const norm = normalizeNormativeSteps(plan);
    const execNorm = normalizeExecutedSteps(exec);
    const result = derivePlanExecutionRelation({
      plannedSteps: norm.steps,
      executedSteps: execNorm.steps,
      executionAttempted: execNorm.executionAttempted,
      evidenceComplete: norm.evidenceComplete && execNorm.evidenceComplete,
    });
    expect(result.relation).toBe("divergent");
    expect(result.reason_codes.some(r => r.includes("extra_steps"))).toBe(true);
  });

  // 10. Omitted step → divergent
  test("omitted step (planned but not executed) → divergent", () => {
    const step1 = { ...DESCRIPTOR_STEP, step_id: "lint_result:0" };
    const step2 = { ...DESCRIPTOR_STEP, step_id: "test_or_build_result:0", argv: ["node", "test.js"], target_paths: ["test.js"] };
    const plan = planWith([step1, step2]);
    const exec = execWith([{ ...DESCRIPTOR_EXECUTED, step_id: "lint_result:0" }]); // missing step 2
    const norm = normalizeNormativeSteps(plan);
    const execNorm = normalizeExecutedSteps(exec);
    const result = derivePlanExecutionRelation({
      plannedSteps: norm.steps,
      executedSteps: execNorm.steps,
      executionAttempted: execNorm.executionAttempted,
      evidenceComplete: norm.evidenceComplete && execNorm.evidenceComplete,
    });
    expect(result.relation).toBe("divergent");
    expect(result.reason_codes.some(r => r.includes("omitted_steps"))).toBe(true);
  });

  // 11. Empty normative plan + empty execution → none (not vacuous pass)
  test("empty plan + empty execution → none (no vacuous pass)", () => {
    const plan = planWith([]);
    const exec = execWith([]);
    const norm = normalizeNormativeSteps(plan);
    const execNorm = normalizeExecutedSteps(exec);
    const result = derivePlanExecutionRelation({
      plannedSteps: norm.steps,
      executedSteps: execNorm.steps,
      executionAttempted: execNorm.executionAttempted,
      evidenceComplete: norm.evidenceComplete && execNorm.evidenceComplete,
    });
    expect(result.relation).toBe("none");
    expect(result.reason_codes).toContain("empty_plan_no_execution");
  });

  // 12. Schema-v1 plan (no normative_steps) → unverifiable
  test("schema-v1 plan (no normative_steps) → unverifiable", () => {
    const plan = { plan_schema_version: 1, executable_commands: ["lint"], command_descriptors: {} };
    const exec = execWith([LEGACY_EXECUTED]);
    const norm = normalizeNormativeSteps(plan);
    const execNorm = normalizeExecutedSteps(exec);
    const result = derivePlanExecutionRelation({
      plannedSteps: norm.steps,
      executedSteps: execNorm.steps,
      executionAttempted: execNorm.executionAttempted,
      evidenceComplete: norm.evidenceComplete && execNorm.evidenceComplete,
    });
    expect(result.relation).toBe("unverifiable");
    expect(result.reason_codes).toContain("insufficient_evidence");
  });

  // 13. Unknown executed step ID → divergent
  test("unknown executed step ID → divergent", () => {
    // Equal step count, but the executed step has an ID not in the plan.
    const plan = planWith([{ ...DESCRIPTOR_STEP, step_id: "lint_result:0" }, { ...DESCRIPTOR_STEP, step_id: "test_or_build_result:0", argv: ["node", "test.js"], target_paths: ["test.js"] }]);
    const exec = execWith([
      { ...DESCRIPTOR_EXECUTED, step_id: "lint_result:0" },
      { ...DESCRIPTOR_EXECUTED, step_id: "unknown:0", executed_argv: ["node", "test.js"], target_paths: ["test.js"] },
    ]);
    const norm = normalizeNormativeSteps(plan);
    const execNorm = normalizeExecutedSteps(exec);
    const result = derivePlanExecutionRelation({
      plannedSteps: norm.steps,
      executedSteps: execNorm.steps,
      executionAttempted: execNorm.executionAttempted,
      evidenceComplete: norm.evidenceComplete && execNorm.evidenceComplete,
    });
    expect(result.relation).toBe("divergent");
    expect(result.reason_codes.some(r => r.includes("missing_executed_step") || r.includes("unknown_executed_step"))).toBe(true);
  });
});

describe("P0: result eligibility", () => {
  test("exact relation + all conditions met → eligible", () => {
    const result = deriveResultEligibility({
      planExecutionRelation: "exact",
      requiredExecutionFeatures: ["normative-step-reporting-v1"],
      backendExecutionFeatures: ["normative-step-reporting-v1", "command-descriptor-v1"],
      backendPassCapable: true,
      selectedBackendReachable: true,
      validatorImageIdentityValid: true,
      reportIntegrityValid: true,
      executionEvidenceComplete: true,
      planSchemaSupported: true,
    });
    expect(result.eligible).toBe(true);
    expect(result.reason_codes).toHaveLength(0);
  });

  test("divergent relation → not eligible", () => {
    const result = deriveResultEligibility({
      planExecutionRelation: "divergent",
      requiredExecutionFeatures: ["normative-step-reporting-v1"],
      backendExecutionFeatures: ["normative-step-reporting-v1"],
      backendPassCapable: true,
      selectedBackendReachable: true,
      validatorImageIdentityValid: true,
      reportIntegrityValid: true,
      executionEvidenceComplete: true,
      planSchemaSupported: true,
    });
    expect(result.eligible).toBe(false);
    expect(result.reason_codes.some(r => r.includes("plan_execution_not_exact"))).toBe(true);
  });

  test("missing required feature → not eligible", () => {
    const result = deriveResultEligibility({
      planExecutionRelation: "exact",
      requiredExecutionFeatures: ["normative-step-reporting-v1", "command-descriptor-v1"],
      backendExecutionFeatures: ["normative-step-reporting-v1"], // missing command-descriptor-v1
      backendPassCapable: true,
      selectedBackendReachable: true,
      validatorImageIdentityValid: true,
      reportIntegrityValid: true,
      executionEvidenceComplete: true,
      planSchemaSupported: true,
    });
    expect(result.eligible).toBe(false);
    expect(result.reason_codes.some(r => r.includes("required_feature_missing:command-descriptor-v1"))).toBe(true);
  });

  test("backend not pass-capable → not eligible", () => {
    const result = deriveResultEligibility({
      planExecutionRelation: "exact",
      requiredExecutionFeatures: ["normative-step-reporting-v1"],
      backendExecutionFeatures: ["normative-step-reporting-v1"],
      backendPassCapable: false,
      selectedBackendReachable: true,
      validatorImageIdentityValid: true,
      reportIntegrityValid: true,
      executionEvidenceComplete: true,
      planSchemaSupported: true,
    });
    expect(result.eligible).toBe(false);
    expect(result.reason_codes).toContain("backend_not_pass_capable");
  });

  test("timeout overrides eligibility → inconclusive", () => {
    const result = mapResultOutcome({
      eligible: true,
      executionOverall: "pass",
      hasTimeout: true,
    });
    expect(result.validator_result).toBe("inconclusive");
    expect(result.reason).toBe("timeout_or_spawn_failure");
  });

  test("eligible + pass → pass", () => {
    const result = mapResultOutcome({
      eligible: true,
      executionOverall: "pass",
      hasTimeout: false,
    });
    expect(result.validator_result).toBe("pass");
  });

  test("eligible + fail → fail", () => {
    const result = mapResultOutcome({
      eligible: true,
      executionOverall: "fail",
      hasTimeout: false,
    });
    expect(result.validator_result).toBe("fail");
  });

  test("ineligible + pass → inconclusive", () => {
    const result = mapResultOutcome({
      eligible: false,
      executionOverall: "pass",
      hasTimeout: false,
    });
    expect(result.validator_result).toBe("inconclusive");
  });
});

describe("P0: hash equivalence through both construction paths", () => {
  test("runner and recorder produce identical validation_plan_hash", () => {
    // This test is a smoke test here — the full equivalence suite is in
    // validation-plan-hash-equivalence.test.js. This just verifies the
    // centralized hash function is importable and produces stable output.
    const input = {
      commands: ["lint"],
      command_descriptors: {},
      image_digest: "sha256:node-executor-v1",
      required_validation: ["lint_result"],
      acceptance_policy: "lint_pass",
      plan_schema_version: 2,
      descriptor_policy: { activation: "observed" },
      normative_steps: [{ step_id: "lint_result:0", sequence: 0, semantic: "lint_result", command_source: "legacy_template", command_id: "lint", argv: null, target_paths: null }],
      required_execution_features: ["normative-step-reporting-v1"],
    };
    const hash1 = computeValidationPlanHash(input);
    const hash2 = computeValidationPlanHash(input);
    expect(hash1).toBe(hash2);
    expect(hash1.startsWith("sha256:")).toBe(true);
  });
});
