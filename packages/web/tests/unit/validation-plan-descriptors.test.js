// Tests for descriptor-aware compileValidationPlan (Task 8D).
//
// Verifies:
//   - a present + valid ci_workflow_command descriptor overrides legacy lint
//   - a present + shape-invalid descriptor becomes an explicit shape_invalid
//     artifact (NOT dropped, NOT legacy fallback)
//   - absent descriptor → legacy fallback
//   - the legacy GitWire baseline lint is NOT used when a repo command exists

import { describe, it, expect } from "@jest/globals";
import { compileValidationPlan } from "../../src/lib/validationPlanAdapter.js";

const VALID_DESCRIPTOR = {
  command_id: "repo_lint",
  semantic_id: "lint_result",
  source: "ci_workflow",
  argv: ["npx", "--no-install", "eslint", "app.js"],
  target_paths: ["app.js"],
  network: "disabled",
  requires_shell: false,
};

function evidenceWith(descriptor) {
  return [{ type: "ci_workflow_command", descriptor }];
}

describe("compileValidationPlan — descriptor overrides legacy (selected mode)", () => {
  it("uses repo_lint descriptor when a valid ci_workflow_command is present (selected)", () => {
    const plan = compileValidationPlan(["lint_result"], evidenceWith(VALID_DESCRIPTOR), { descriptorActivation: "selected" });
    expect(plan.executable_commands).toContain("repo_lint");
    expect(plan.executable_commands).not.toContain("lint"); // legacy NOT used
    const d = plan.command_descriptors.repo_lint;
    expect(d.argv).toEqual(["npx", "--no-install", "eslint", "app.js"]);
    expect(d.target_paths).toEqual(["app.js"]);
    expect(d.requires_shell).toBe(false);
  });

  it("observed mode: legacy lint is normative, descriptor is evidence only", () => {
    const plan = compileValidationPlan(["lint_result"], evidenceWith(VALID_DESCRIPTOR));
    expect(plan.executable_commands).toContain("lint");
    expect(plan.executable_commands).not.toContain("repo_lint"); // descriptor NOT dispatched
    // descriptor is still recorded as candidate evidence
    expect(plan.command_descriptors.repo_lint).toBeDefined();
  });

  it("legacy lint fallback works when descriptor is absent", () => {
    const plan = compileValidationPlan(["lint_result"]);
    expect(plan.executable_commands).toContain("lint");
    expect(plan.executable_commands).not.toContain("repo_lint");
  });

  it("legacy lint fallback works when evidence is present but has no matching descriptor", () => {
    const plan = compileValidationPlan(["lint_result"], [{ type: "ci_log_excerpt", excerpt: "..." }]);
    expect(plan.executable_commands).toContain("lint");
    expect(plan.executable_commands).not.toContain("repo_lint");
  });
});

describe("compileValidationPlan — shape-invalid descriptor is explicit (selected mode)", () => {
  it("a shape-invalid descriptor becomes an explicit shape_invalid artifact, not legacy lint (selected)", () => {
    const invalidDescriptor = {
      command_id: "repo_lint",
      semantic_id: "lint_result",
      source: "ci_workflow",
      // argv missing → shape-invalid
    };
    const plan = compileValidationPlan(["lint_result"], evidenceWith(invalidDescriptor), { descriptorActivation: "selected" });
    // The command_id is still in the executable plan (identity preserved)...
    expect(plan.executable_commands).toContain("repo_lint");
    // ...but it is marked shape_invalid, NOT legacy lint.
    expect(plan.executable_commands).not.toContain("lint");
    const d = plan.command_descriptors.repo_lint;
    expect(d.policy_status).toBe("shape_invalid");
    expect(d.shape_reasons.length).toBeGreaterThan(0);
    expect(d.argv).toBeUndefined();
  });

  it("shape_reasons explain why the descriptor was rejected", () => {
    const invalidDescriptor = {
      command_id: "repo_lint",
      semantic_id: "lint_result",
      source: "ci_workflow",
      argv: [], // empty argv
      target_paths: ["app.js"],
    };
    const plan = compileValidationPlan(["lint_result"], evidenceWith(invalidDescriptor));
    expect(plan.command_descriptors.repo_lint.shape_reasons.join("; ")).toMatch(/argv/);
  });

  // Blocker 2 regression: when the extractor (workflowCommandExtractor) has
  // ALREADY classified a descriptor as shape_invalid with specific path reasons
  // (glob/absolute/traversal/empty), the adapter MUST preserve those original
  // reasons verbatim. Re-running generic shape validation here would replace
  // the specific path reason (e.g. "must not contain glob characters") with a
  // generic "argv must be a non-empty string array" — losing the actionable
  // detail that the extractor derived from the actual workflow command.
  describe("compileValidationPlan — preserves extractor-provided shape_reasons", () => {
    it("preserves a glob-specific reason from the extractor", () => {
      const extractorRejected = {
        command_id: "repo_lint",
        semantic_id: "lint_result",
        source: "ci_workflow",
        policy_status: "shape_invalid",
        shape_reasons: ["target_path must not contain glob characters: packages/*/src"],
      };
      const plan = compileValidationPlan(["lint_result"], evidenceWith(extractorRejected));
      const d = plan.command_descriptors.repo_lint;
      expect(d.policy_status).toBe("shape_invalid");
      // The glob-specific reason survives — NOT replaced by a generic argv message.
      expect(d.shape_reasons).toEqual(["target_path must not contain glob characters: packages/*/src"]);
      expect(d.shape_reasons.join("; ")).not.toMatch(/argv must be a non-empty/);
    });

    it("preserves a traversal-specific reason from the extractor", () => {
      const extractorRejected = {
        command_id: "repo_lint",
        semantic_id: "lint_result",
        source: "ci_workflow",
        policy_status: "shape_invalid",
        shape_reasons: ["target_path must not contain traversal (..): ../secret.js"],
      };
      const plan = compileValidationPlan(["lint_result"], evidenceWith(extractorRejected));
      const d = plan.command_descriptors.repo_lint;
      expect(d.shape_reasons).toEqual(["target_path must not contain traversal (..): ../secret.js"]);
    });

    it("preserves an absolute-path reason from the extractor", () => {
      const extractorRejected = {
        command_id: "repo_lint",
        semantic_id: "lint_result",
        source: "ci_workflow",
        policy_status: "shape_invalid",
        shape_reasons: ["target_path must be relative, not absolute: /etc/passwd"],
      };
      const plan = compileValidationPlan(["lint_result"], evidenceWith(extractorRejected));
      const d = plan.command_descriptors.repo_lint;
      expect(d.shape_reasons).toEqual(["target_path must be relative, not absolute: /etc/passwd"]);
    });
  });
});

describe("compileValidationPlan — determinism", () => {
  it("produces identical output for the same evidence across two calls", () => {
    const ev = evidenceWith(VALID_DESCRIPTOR);
    const a = compileValidationPlan(["lint_result"], ev);
    const b = compileValidationPlan(["lint_result"], ev);
    expect(JSON.stringify(a)).toEqual(JSON.stringify(b));
  });
});

describe("compileValidationPlan — test_or_build_result descriptor", () => {
  it("uses a repo descriptor for test_or_build_result too", () => {
    const descriptor = {
      command_id: "repo_node_script",
      semantic_id: "test_or_build_result",
      source: "ci_workflow",
      argv: ["node", "test.js"],
      target_paths: ["test.js"],
      network: "disabled",
      requires_shell: false,
    };
    const plan = compileValidationPlan(["test_or_build_result"], evidenceWith(descriptor), { descriptorActivation: "selected" });
    expect(plan.executable_commands).toContain("repo_node_script");
    expect(plan.command_descriptors.repo_node_script.argv).toEqual(["node", "test.js"]);
  });
});
