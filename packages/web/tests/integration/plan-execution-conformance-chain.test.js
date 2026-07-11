// tests/integration/plan-execution-conformance-chain.test.js
//
// Integration tests through the real planner → backend → receipt chain.
// Unlike the unit tests in plan-execution-conformance.test.js (which use
// hand-crafted fixtures), these tests call the actual compileValidationPlan
// and buildValidationPlan, then verify the normative_steps flow through to
// the plan hash and the step metadata is correctly structured.
//
// This catches the defects ChatGPT identified: planner IDs not propagated,
// command_source mismatch, observed mode dispatching descriptor commands.

import { describe, it, expect } from "@jest/globals";
import { compileValidationPlan } from "../../src/lib/validationPlanAdapter.js";
import { buildValidationPlan } from "../../src/lib/sandboxRunner.js";
import { computeValidationPlanHash } from "@gitwire/core";

// Fixtures
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

describe("Integration: planner → normative_steps → hash chain", () => {
  describe("observed mode (default)", () => {
    it("descriptor evidence present but legacy is normative", () => {
      const plan = compileValidationPlan(
        ["lint_result"],
        evidenceWith(VALID_DESCRIPTOR),
      );

      // Legacy command dispatched, not descriptor
      expect(plan.executable_commands).toContain("lint");
      expect(plan.executable_commands).not.toContain("repo_lint");

      // Descriptor still recorded as evidence
      expect(plan.command_descriptors.repo_lint).toBeDefined();

      // Normative step uses legacy_template
      expect(plan.normative_steps).toHaveLength(1);
      expect(plan.normative_steps[0].command_source).toBe("legacy_template");
      expect(plan.normative_steps[0].command_id).toBe("lint");
      expect(plan.normative_steps[0].step_id).toMatch(/^lint_result:0$/);

      // Legacy step carries resolved argv (not null)
      expect(plan.normative_steps[0].argv).toEqual(["npm", "run", "lint", "--"]);
      expect(plan.normative_steps[0].target_paths).toEqual([]);

      // command-descriptor-v1 NOT required (legacy is normative)
      expect(plan.required_execution_features).not.toContain("command-descriptor-v1");
    });

    it("buildValidationPlan produces consistent hash with normative_steps", () => {
      const envelope = { required_validation: ["lint_result"] };
      const planResult = buildValidationPlan(envelope, evidenceWith(VALID_DESCRIPTOR));

      // Hash is computed via the shared function and includes normative_steps
      expect(planResult.validation_plan_hash).toMatch(/^sha256:/);
      expect(planResult.plan_schema_version).toBe(2);
      expect(planResult.normative_steps).toHaveLength(1);
      expect(planResult.normative_steps[0].command_source).toBe("legacy_template");
      expect(planResult.descriptor_policy.activation).toBe("observed");
    });
  });

  describe("selected mode", () => {
    it("descriptor is normative and dispatched", () => {
      const plan = compileValidationPlan(
        ["lint_result"],
        evidenceWith(VALID_DESCRIPTOR),
        { descriptorActivation: "selected" },
      );

      // Descriptor command dispatched
      expect(plan.executable_commands).toContain("repo_lint");
      expect(plan.executable_commands).not.toContain("lint");

      // Normative step uses ci_workflow_descriptor
      expect(plan.normative_steps).toHaveLength(1);
      expect(plan.normative_steps[0].command_source).toBe("ci_workflow_descriptor");
      expect(plan.normative_steps[0].command_id).toBe("repo_lint");
      expect(plan.normative_steps[0].argv).toEqual(["npx", "--no-install", "eslint", "app.js"]);
      expect(plan.normative_steps[0].target_paths).toEqual(["app.js"]);

      // command-descriptor-v1 IS required
      expect(plan.required_execution_features).toContain("command-descriptor-v1");
    });
  });

  describe("step ID structure", () => {
    it("step IDs follow semantic:sequence pattern", () => {
      const plan = compileValidationPlan(
        ["lint_result", "test_or_build_result"],
        evidenceWith(VALID_DESCRIPTOR),
      );

      for (const step of plan.normative_steps) {
        expect(step.step_id).toMatch(/^.+:\d+$/);
        expect(typeof step.sequence).toBe("number");
      }
    });

    it("sequences are monotonic from 0", () => {
      const plan = compileValidationPlan(
        ["lint_result", "test_or_build_result"],
        evidenceWith(VALID_DESCRIPTOR),
      );

      const sequences = plan.normative_steps.map(s => s.sequence);
      for (let i = 0; i < sequences.length; i++) {
        expect(sequences[i]).toBe(i);
      }
    });
  });

  describe("hash determinism", () => {
    it("same evidence + same activation → same hash", () => {
      const envelope = { required_validation: ["lint_result"] };
      const ev = evidenceWith(VALID_DESCRIPTOR);
      const a = buildValidationPlan(envelope, ev);
      const b = buildValidationPlan(envelope, ev);
      expect(a.validation_plan_hash).toBe(b.validation_plan_hash);
    });

    it("different activation → different hash", () => {
      const envelope = { required_validation: ["lint_result"] };
      const ev = evidenceWith(VALID_DESCRIPTOR);

      const observed = buildValidationPlan(envelope, ev);
      // Force selected mode via env
      const origEnv = process.env.GITWIRE_DESCRIPTOR_ACTIVATION;
      process.env.GITWIRE_DESCRIPTOR_ACTIVATION = "selected";
      try {
        const selected = buildValidationPlan(envelope, ev);
        expect(observed.validation_plan_hash).not.toBe(selected.validation_plan_hash);
      } finally {
        if (origEnv === undefined) delete process.env.GITWIRE_DESCRIPTOR_ACTIVATION;
        else process.env.GITWIRE_DESCRIPTOR_ACTIVATION = origEnv;
      }
    });
  });

  describe("command_source canonical values", () => {
    it("all normative step command_source values are in the canonical enum", () => {
      const validSources = new Set(["legacy_template", "ci_workflow_descriptor"]);

      // Test both modes
      for (const activation of ["observed", "selected"]) {
        const plan = compileValidationPlan(
          ["lint_result"],
          evidenceWith(VALID_DESCRIPTOR),
          { descriptorActivation: activation },
        );
        for (const step of plan.normative_steps) {
          expect(validSources.has(step.command_source)).toBe(true);
        }
      }
    });
  });
});
