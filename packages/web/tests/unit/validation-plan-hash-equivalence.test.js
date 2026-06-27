// P0 TEST (Task 8D): runner and recorder validation_plan_hash equivalence.
//
// This is the most important regression test for Task 8D. It proves that:
//   sandboxRunner.buildValidationPlan(required_validation, evidence_refs)
//   repairProposalService.buildValidationPlanForRecorder(envelope, evidence_refs)
// produce BYTE-IDENTICAL:
//   - commands
//   - command_descriptors (canonical deep-equal)
//   - validation_plan_hash
//
// over the same frozen ci_workflow_command evidence fixture. If these drift,
// the verifier (recordVerificationResult) rejects every descriptor-derived
// receipt with a hash-mismatch error.

import { describe, it, expect } from "@jest/globals";
import { buildValidationPlan } from "../../src/lib/sandboxRunner.js";
import { buildValidationPlanForRecorder } from "../../src/services/repairProposalService.js";

// Frozen fixture: a MyShell-style ci_workflow_command evidence ref.
const FROZEN_DESCRIPTOR = {
  command_id: "repo_lint",
  semantic_id: "lint_result",
  source: "ci_workflow",
  argv: ["npx", "--no-install", "eslint", "app.js"],
  target_paths: ["app.js"],
  network: "disabled",
  requires_shell: false,
};

const EVIDENCE_REFS = [
  {
    type: "ci_workflow_command",
    source: ".github/workflows/demo-ci.yml@8899bb8e5258",
    excerpt_hash: "abc123",
    workflow_path: ".github/workflows/demo-ci.yml",
    workflow_ref: "8899bb8e5258aabcc1234567",
    workflow_blob_sha: "blobsha123",
    descriptor_hash: "def456",
    descriptor: FROZEN_DESCRIPTOR,
  },
];

const REQUIRED_VALIDATION = ["lint_result", "policy_scope_check"];

describe("P0: runner/recorder validation_plan_hash equivalence", () => {
  const envelope = { required_validation: REQUIRED_VALIDATION };

  const runnerPlan = buildValidationPlan(envelope, EVIDENCE_REFS);
  const recorderPlan = buildValidationPlanForRecorder(envelope, EVIDENCE_REFS);

  it("runner and recorder produce identical commands[]", () => {
    expect(runnerPlan.commands).toEqual(recorderPlan.commands);
  });

  it("runner and recorder produce identical validation_plan_hash", () => {
    expect(runnerPlan.validation_plan_hash).toEqual(recorderPlan.validation_plan_hash);
  });

  it("runner and recorder command_descriptors are deep-equal (canonical)", () => {
    expect(runnerPlan.command_descriptors).toEqual(recorderPlan.command_descriptors);
  });

  it("the descriptor argv is preserved exactly in both plans", () => {
    expect(runnerPlan.command_descriptors.repo_lint.argv).toEqual([
      "npx", "--no-install", "eslint", "app.js",
    ]);
    expect(recorderPlan.command_descriptors.repo_lint.argv).toEqual([
      "npx", "--no-install", "eslint", "app.js",
    ]);
  });

  it("deterministic across repeated calls (stable hash)", () => {
    const r1 = buildValidationPlan(envelope, EVIDENCE_REFS);
    const r2 = buildValidationPlan(envelope, EVIDENCE_REFS);
    expect(r1.validation_plan_hash).toEqual(r2.validation_plan_hash);
  });
});

describe("P0: equivalence holds for shape-invalid descriptors too", () => {
  const invalidDescriptor = {
    command_id: "repo_lint",
    semantic_id: "lint_result",
    source: "ci_workflow",
    // argv missing → shape_invalid
  };
  const ev = [{ type: "ci_workflow_command", descriptor: invalidDescriptor }];
  const envelope = { required_validation: ["lint_result"] };

  it("runner and recorder agree on the shape_invalid artifact", () => {
    const runnerPlan = buildValidationPlan(envelope, ev);
    const recorderPlan = buildValidationPlanForRecorder(envelope, ev);
    expect(runnerPlan.validation_plan_hash).toEqual(recorderPlan.validation_plan_hash);
    expect(runnerPlan.command_descriptors).toEqual(recorderPlan.command_descriptors);
    expect(runnerPlan.command_descriptors.repo_lint.policy_status).toBe("shape_invalid");
  });
});

describe("P0: equivalence holds when no descriptor is present (legacy)", () => {
  const envelope = { required_validation: ["lint_result"] };

  it("runner and recorder agree on legacy fallback", () => {
    const runnerPlan = buildValidationPlan(envelope, null);
    const recorderPlan = buildValidationPlanForRecorder(envelope, null);
    expect(runnerPlan.validation_plan_hash).toEqual(recorderPlan.validation_plan_hash);
    expect(runnerPlan.commands).toEqual(["lint"]);
  });
});
