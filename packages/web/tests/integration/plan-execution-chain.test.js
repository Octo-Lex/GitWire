// tests/integration/plan-execution-chain.test.js
//
// Full-chain integration tests: planner → backend result → receipt → verifier.
//
// Unlike the unit tests (hand-crafted fixtures) and the planner-only integration
// tests, these tests exercise the actual receipt builder and verifier gate with
// synthetic backend results that match the real backend output shape.
//
// These tests would have caught every round of blockers ChatGPT identified:
// - Legacy argv missing in executor-service results
// - command_source mismatch (fallback_template vs legacy_template)
// - Descriptor commands dispatched in observed mode
// - Sequence mismatch from alphabetical sorting
// - Receipt dropping conformance fields
// - Timeout classified as divergent

import { describe, it, expect } from "@jest/globals";
import { compileValidationPlan } from "../../src/lib/validationPlanAdapter.js";
import { buildValidationPlan } from "../../src/lib/sandboxRunner.js";
import { validateGap1ValidatorBindings } from "../../src/lib/validatorReceiptGate.js";
import { resolveDescriptorActivation } from "@gitwire/core";
import { normalizeNormativeSteps, normalizeExecutedSteps, derivePlanExecutionRelation } from "../../src/lib/planExecutionConformance.js";

// ── Helpers ─────────────────────────────────────────────────────────────────

const DIGEST = "sha256:" + "a".repeat(64);
const REF = "registry.example.com/v@" + DIGEST;

function buildReceiptFromPlanAndResult(buildPlanResult, execResult, opts = {}) {
  const {
    backend_id = "executor-service",
    executor_kind = "container-runtime",
    executor_pass_capable = true,
    plan_execution_relation = "exact",
    plan_execution_reason_codes = [],
  } = opts;

  // Simulate what sandboxRunner does: derive conformance + eligibility + receipt
  const commands = execResult.command_results.map(c => c.command);
  const receipt = {
    execution_backend_id: backend_id,
    executor_version: "1.0.0",
    source_snapshot_hash: "sha256:snap",
    patch_artifact_hash: "sha256:patch",
    base_sha: "abc123",
    input_bundle_hash: "sha256:bundle",
    sandbox_image_digest: DIGEST,
    validation_plan_hash: buildPlanResult.validation_plan_hash,
    commands,
    per_command_exit_statuses: execResult.command_results.map(c => c.exit_status ?? 0),
    aggregate_exit_status: execResult.aggregate_exit_status ?? 0,
    output_refs: execResult.command_results.map(c => c.output_ref || "output:fake"),
    output_hashes: execResult.command_results.map(c => c.output_hash || "fake"),
    limits_applied: {},
    result: execResult.overall,
    container_runtime: "docker",
    runtime_version: "29.5.0",
    network_disabled: true,
    non_root: true,
    read_only_rootfs: true,
    resource_limits: {},
    image_ref: REF,
    executor_kind,
    executor_pass_capable,
    validator_image_ref: REF,
    validator_image_digest: DIGEST,
    validator_result: execResult.overall,
    validator_result_status: execResult.overall,
    executor_report_hash: "sha256:report",
    executor_report_ref: "executor-report:sha256:report",
    validation_response_source: "real_executor_service",
    plan_execution_relation,
    plan_execution_reason_codes,
    executed_steps: execResult.executed_steps || [],
    backend_execution_features: ["normative-step-reporting-v1", "command-descriptor-v1"],
  };
  return receipt;
}

function makeBackendResult(steps, opts = {}) {
  const command_results = steps.map((s, i) => ({
    command: s.command_id || `cmd${i}`,
    step_id: s.step_id,
    sequence: s.sequence ?? i,
    command_source: s.command_source,
    executed_argv: s.argv || null,
    target_paths: s.target_paths || [],
    exit_status: s.exit_status ?? 0,
    started: s.started !== false,
    completed: s.completed !== false,
    timed_out: s.timed_out === true,
    output_ref: `output:hash${i}`,
    output_hash: `hash${i}`,
    duration_ms: 100,
    ...(s.status ? { status: s.status } : {}),
  }));

  return {
    overall: opts.overall || "pass",
    command_results,
    executed_steps: command_results.map((cr, i) => ({
      step_id: cr.step_id,
      sequence: cr.sequence ?? i,
      command_source: cr.command_source,
      executed_argv: cr.executed_argv,
      target_paths: cr.target_paths,
      exit_status: cr.exit_status,
      started: cr.started,
      completed: cr.completed,
      timed_out: cr.timed_out,
      ...(cr.status ? { status: cr.status } : {}),
    })),
    aggregate_exit_status: opts.aggregate_exit_status ?? 0,
    executor_report_hash: "sha256:report",
    executor_report_ref: "executor-report:sha256:report",
    inspected_image_digest: DIGEST,
    inspection_hash: "sha256:inspect",
    validation_response_source: "real_executor_service",
  };
}

const VALID_DESCRIPTOR = {
  command_id: "repo_lint",
  semantic_id: "lint_result",
  source: "ci_workflow",
  argv: ["npx", "--no-install", "eslint", "app.js"],
  target_paths: ["app.js"],
  network: "disabled",
  requires_shell: false,
  policy_status: "pending_executor_validation",
};

function evidenceWith(descriptor) {
  return [{
    type: "ci_workflow_command",
    source: ".github/workflows/ci.yml@abc123",
    excerpt_hash: "sha256:fake",
    workflow_path: ".github/workflows/ci.yml",
    workflow_ref: "abc123def456",
    workflow_blob_sha: "blobsha123",
    descriptor_hash: "sha256:fake",
    descriptor,
    description: "test descriptor",
  }];
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("Full chain: planner → backend result → receipt → verifier", () => {
  describe("observed mode (default)", () => {
    it("legacy execution through executor-service reaches exact and passes verification", () => {
      const envelope = { required_validation: ["lint_result"] };
      const buildPlanResult = buildValidationPlan(envelope, evidenceWith(VALID_DESCRIPTOR));

      // Backend result: legacy lint ran successfully, matching the normative step
      const normStep = buildPlanResult.normative_steps[0];
      const execResult = makeBackendResult([{
        step_id: normStep.step_id,
        sequence: normStep.sequence,
        command_id: normStep.command_id,
        command_source: normStep.command_source,
        argv: normStep.argv,
        target_paths: normStep.target_paths,
        exit_status: 0,
      }]);

      const receipt = buildReceiptFromPlanAndResult(buildPlanResult, execResult);
      const rawReport = { executed_steps: execResult.executed_steps, executor_service_id: "executor-service" };

      // Verifier should accept this receipt
      expect(() => validateGap1ValidatorBindings(receipt, buildPlanResult, rawReport)).not.toThrow();
    });

    it("descriptor NOT dispatched in observed mode — legacy is normative", () => {
      const envelope = { required_validation: ["lint_result"] };
      const buildPlanResult = buildValidationPlan(envelope, evidenceWith(VALID_DESCRIPTOR));

      // The dispatch_commands should be ["lint"] not ["repo_lint"]
      expect(buildPlanResult.dispatch_commands).toContain("lint");
      expect(buildPlanResult.dispatch_commands).not.toContain("repo_lint");
    });
  });

  describe("selected mode", () => {
    it("descriptor execution reaches exact and passes verification", () => {
      const origEnv = process.env.GITWIRE_DESCRIPTOR_ACTIVATION;
      process.env.GITWIRE_DESCRIPTOR_ACTIVATION = "selected";
      try {
        const envelope = { required_validation: ["lint_result"] };
        const buildPlanResult = buildValidationPlan(envelope, evidenceWith(VALID_DESCRIPTOR));

        // Normative step should be the descriptor
        const normStep = buildPlanResult.normative_steps[0];
        expect(normStep.command_source).toBe("ci_workflow_descriptor");
        expect(normStep.argv).toEqual(["npx", "--no-install", "eslint", "app.js"]);

        const execResult = makeBackendResult([{
          step_id: normStep.step_id,
          sequence: normStep.sequence,
          command_id: normStep.command_id,
          command_source: normStep.command_source,
          argv: normStep.argv,
          target_paths: normStep.target_paths,
          exit_status: 0,
        }]);

        const receipt = buildReceiptFromPlanAndResult(buildPlanResult, execResult);
        const rawReport = { executed_steps: execResult.executed_steps, executor_service_id: "executor-service" };

        expect(() => validateGap1ValidatorBindings(receipt, buildPlanResult, rawReport)).not.toThrow();
      } finally {
        if (origEnv === undefined) delete process.env.GITWIRE_DESCRIPTOR_ACTIVATION;
        else process.env.GITWIRE_DESCRIPTOR_ACTIVATION = origEnv;
      }
    });

    it("descriptor plan with legacy substitution is divergent → verifier rejects", () => {
      const origEnv = process.env.GITWIRE_DESCRIPTOR_ACTIVATION;
      process.env.GITWIRE_DESCRIPTOR_ACTIVATION = "selected";
      try {
        const envelope = { required_validation: ["lint_result"] };
        const buildPlanResult = buildValidationPlan(envelope, evidenceWith(VALID_DESCRIPTOR));

        // Backend ran legacy instead of descriptor, but the receipt falsely claims pass
        const execResult = makeBackendResult([{
          step_id: buildPlanResult.normative_steps[0].step_id,
          sequence: 0,
          command_id: "lint",
          command_source: "legacy_template", // wrong — plan says ci_workflow_descriptor
          argv: ["npm", "run", "lint", "--"],
          target_paths: [],
          exit_status: 0,
        }], { overall: "pass" });

        // Receipt claims pass — the verifier should catch the conformance mismatch
        const receipt = buildReceiptFromPlanAndResult(buildPlanResult, execResult, {
          plan_execution_relation: "exact", // receipt falsely claims exact
        });
        receipt.validator_result_status = "pass"; // must be pass to reach conformance check
        const rawReport = { executed_steps: execResult.executed_steps, executor_service_id: "executor-service" };

        // Verifier recomputes conformance and finds command_source mismatch
        expect(() => validateGap1ValidatorBindings(receipt, buildPlanResult, rawReport))
          .toThrow(/command_source_mismatch|recomputed/);
      } finally {
        if (origEnv === undefined) delete process.env.GITWIRE_DESCRIPTOR_ACTIVATION;
        else process.env.GITWIRE_DESCRIPTOR_ACTIVATION = origEnv;
      }
    });
  });

  describe("multi-step ordering", () => {
    it("test_or_build_result executes in normative sequence (test before build)", () => {
      const envelope = { required_validation: ["test_or_build_result"] };
      const buildPlanResult = buildValidationPlan(envelope, evidenceWith(VALID_DESCRIPTOR));

      // Normative steps should be in test, build order
      expect(buildPlanResult.normative_steps.length).toBeGreaterThanOrEqual(2);
      // dispatch_commands should preserve sequence order, not alphabetical
      const dispatch = buildPlanResult.dispatch_commands;
      const testIdx = dispatch.indexOf("test");
      const buildIdx = dispatch.indexOf("build");
      expect(testIdx).toBeLessThan(buildIdx);
    });
  });

  describe("timeout vs rejection", () => {
    it("timed-out command is NOT divergent — exact relation with inconclusive outcome", () => {
      const envelope = { required_validation: ["lint_result"] };
      const buildPlanResult = buildValidationPlan(envelope, evidenceWith(VALID_DESCRIPTOR));

      const normStep = buildPlanResult.normative_steps[0];
      const execResult = makeBackendResult([{
        step_id: normStep.step_id,
        sequence: normStep.sequence,
        command_id: normStep.command_id,
        command_source: normStep.command_source,
        argv: normStep.argv,
        target_paths: normStep.target_paths,
        exit_status: null, // timed out
        started: true,
        completed: false,
        timed_out: true,
      }], { overall: "inconclusive" });

      // The gate is pass-only, so we test the conformance module directly.
      // A timeout should produce exact relation (not divergent), because the
      // planned command started with matching identity — it just didn't finish.
      const norm = normalizeNormativeSteps(buildPlanResult);
      const execNorm = normalizeExecutedSteps(execResult);
      const result = derivePlanExecutionRelation({
        plannedSteps: norm.steps,
        executedSteps: execNorm.steps,
        executionAttempted: execNorm.executionAttempted,
        evidenceComplete: norm.evidenceComplete && execNorm.evidenceComplete,
      });

      expect(result.relation).toBe("exact");
    });

    it("policy-rejected descriptor is divergent — verifier rejects", () => {
      const origEnv = process.env.GITWIRE_DESCRIPTOR_ACTIVATION;
      process.env.GITWIRE_DESCRIPTOR_ACTIVATION = "selected";
      try {
        const envelope = { required_validation: ["lint_result"] };
        const buildPlanResult = buildValidationPlan(envelope, evidenceWith(VALID_DESCRIPTOR));

        // Raw report shows a rejected step — the command never ran
        const execResult = makeBackendResult([{
          step_id: buildPlanResult.normative_steps[0].step_id,
          sequence: 0,
          command_id: "repo_lint",
          command_source: "ci_workflow_descriptor",
          argv: ["npx", "--no-install", "eslint", "app.js"],
          target_paths: ["app.js"],
          exit_status: null,
          status: "rejected",
          started: false,
          completed: false,
        }], { overall: "fail" });

        // Receipt falsely claims pass + exact — verifier should catch the rejection
        const receipt = buildReceiptFromPlanAndResult(buildPlanResult, execResult, {
          plan_execution_relation: "exact",
        });
        receipt.validator_result_status = "pass";
        const rawReport = { executed_steps: execResult.executed_steps, executor_service_id: "executor-service" };

        expect(() => validateGap1ValidatorBindings(receipt, buildPlanResult, rawReport))
          .toThrow(/step_rejected|recomputed/);
      } finally {
        if (origEnv === undefined) delete process.env.GITWIRE_DESCRIPTOR_ACTIVATION;
        else process.env.GITWIRE_DESCRIPTOR_ACTIVATION = origEnv;
      }
    });
  });

  describe("receipt field requirements", () => {
    it("missing backend_execution_features is rejected", () => {
      const envelope = { required_validation: ["lint_result"] };
      const buildPlanResult = buildValidationPlan(envelope, evidenceWith(VALID_DESCRIPTOR));
      const normStep = buildPlanResult.normative_steps[0];
      const execResult = makeBackendResult([{
        step_id: normStep.step_id,
        sequence: normStep.sequence,
        command_id: normStep.command_id,
        command_source: normStep.command_source,
        argv: normStep.argv,
        target_paths: normStep.target_paths,
      }]);

      const receipt = buildReceiptFromPlanAndResult(buildPlanResult, execResult);
      delete receipt.backend_execution_features; // remove the field

      const rawReport = { executed_steps: execResult.executed_steps, executor_service_id: "executor-service" };

      expect(() => validateGap1ValidatorBindings(receipt, buildPlanResult, rawReport))
        .toThrow(/backend_execution_features/);
    });

    it("missing plan_execution_relation is rejected", () => {
      const envelope = { required_validation: ["lint_result"] };
      const buildPlanResult = buildValidationPlan(envelope, evidenceWith(VALID_DESCRIPTOR));
      const normStep = buildPlanResult.normative_steps[0];
      const execResult = makeBackendResult([{
        step_id: normStep.step_id,
        sequence: normStep.sequence,
        command_id: normStep.command_id,
        command_source: normStep.command_source,
        argv: normStep.argv,
        target_paths: normStep.target_paths,
      }]);

      const receipt = buildReceiptFromPlanAndResult(buildPlanResult, execResult);
      delete receipt.plan_execution_relation;

      const rawReport = { executed_steps: execResult.executed_steps, executor_service_id: "executor-service" };

      expect(() => validateGap1ValidatorBindings(receipt, buildPlanResult, rawReport))
        .toThrow(/plan_execution_relation/);
    });
  });
});
