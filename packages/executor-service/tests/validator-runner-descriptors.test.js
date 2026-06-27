// Tests for the descriptor execution path in runValidatorJob (Task 8D).
//
// These complement the existing validator-runner.test.js (which covers the
// legacy command-template path). They assert:
//   - a valid descriptor executes its argv and records executed_argv
//   - a shape_invalid descriptor is rejected (carries shape_reasons)
//   - a policy-invalid descriptor is rejected (carries policy_reasons)
//   - overall is "fail" when any descriptor is rejected (not "pass")
//   - legacy fallback works when a command has no descriptor
//
// cmdRunner + imageInspector seams are injected so no real Docker is needed.

import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { runValidatorJob } from "../src/validatorRunner.js";
import { _setCmdRunnerForTests, _setImageInspectorForTests } from "../src/validatorRunner.js";

const REF = "registry.example.com/v@sha256:" + "a".repeat(64);
const DIGEST = "sha256:" + "a".repeat(64);

function makeConfig() {
  return {
    executor_service_id: "executor-service",
    executor_service_version: "1.0.0",
    executor_service_instance_id: "test-instance",
    deployment_mode: "compose-local",
    validator_image_ref: REF,
    validator_image_digest: DIGEST,
  };
}

function matchingInspector() {
  return () => ({ ok: true, digest: DIGEST, hash: "sha256:" + "b".repeat(64), all_digests: [DIGEST] });
}

function successRunner() {
  return (cmd) => {
    if (cmd[0] === "docker") return { ok: true, stdout: "lint passed", stderr: "", code: 0 };
    return { ok: false, stdout: "", stderr: "unknown", code: 1 };
  };
}

function failRunner() {
  return (cmd) => ({ ok: true, stdout: "", stderr: "lint failed", code: 1 });
}

beforeEach(() => {
  _setCmdRunnerForTests(successRunner());
  _setImageInspectorForTests(matchingInspector());
});
afterEach(() => {
  _setCmdRunnerForTests(null);
  _setImageInspectorForTests(null);
});

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

describe("runValidatorJob — descriptor execution path", () => {
  it("executes a valid descriptor and records executed_argv + command_source", async () => {
    const r = await runValidatorJob({
      request: {
        request_id: "req-1",
        files: [{ path: "app.js", content: "console.log('hi')" }],
        commands: ["repo_lint"],
        command_descriptors: { repo_lint: VALID_DESCRIPTOR },
        limits: { wall_clock_ms: 5000, memory_mb: 256, pids_limit: 32, output_bytes: 65536 },
        validator_image_ref: REF,
        validator_image_digest: DIGEST,
        expected_executor_policy: { network_disabled: true, non_root: true, read_only_rootfs: true, resource_limits: true },
      },
      config: makeConfig(),
    });
    expect(r.overall).toBe("pass");
    expect(r.command_results).toHaveLength(1);
    const cr = r.command_results[0];
    expect(cr.command).toBe("repo_lint");
    expect(cr.command_source).toBe("ci_workflow");
    expect(cr.executed_argv).toEqual(["npx", "--no-install", "eslint", "app.js"]);
    expect(cr.target_paths).toEqual(["app.js"]);
    expect(cr.exit_status).toBe(0);
  });

  it("returns fail when the descriptor command exits non-zero", async () => {
    _setCmdRunnerForTests(failRunner());
    const r = await runValidatorJob({
      request: {
        request_id: "req-2",
        files: [{ path: "app.js", content: "x" }],
        commands: ["repo_lint"],
        command_descriptors: { repo_lint: VALID_DESCRIPTOR },
        limits: { wall_clock_ms: 5000, memory_mb: 256, pids_limit: 32, output_bytes: 65536 },
        validator_image_ref: REF,
        validator_image_digest: DIGEST,
        expected_executor_policy: { network_disabled: true, non_root: true, read_only_rootfs: true, resource_limits: true },
      },
      config: makeConfig(),
    });
    expect(r.overall).toBe("fail");
  });
});

describe("runValidatorJob — shape_invalid descriptor rejected", () => {
  it("records a rejected command_result with shape_reasons and overall=fail", async () => {
    const shapeInvalid = {
      command_id: "repo_lint",
      semantic_id: "lint_result",
      source: "ci_workflow",
      policy_status: "shape_invalid",
      shape_reasons: ["argv must be a non-empty string array"],
    };
    const r = await runValidatorJob({
      request: {
        request_id: "req-3",
        files: [{ path: "app.js", content: "x" }],
        commands: ["repo_lint"],
        command_descriptors: { repo_lint: shapeInvalid },
        limits: { wall_clock_ms: 5000, memory_mb: 256, pids_limit: 32, output_bytes: 65536 },
        validator_image_ref: REF,
        validator_image_digest: DIGEST,
        expected_executor_policy: { network_disabled: true, non_root: true, read_only_rootfs: true, resource_limits: true },
      },
      config: makeConfig(),
    });
    // A rejected descriptor means overall cannot be "pass".
    expect(r.overall).not.toBe("pass");
    const cr = r.command_results[0];
    expect(cr.status).toBe("rejected");
    expect(cr.command_source).toBe("ci_workflow");
    expect(cr.policy_reasons.join("; ")).toMatch(/shape invalid/);
  });

  // Blocker 1 regression: rejected descriptor command_results MUST carry the
  // full audit fields (executed_argv + target_paths), not just command/status/
  // policy_reasons/exit_status. A shape_invalid descriptor has no argv/
  // target_paths by definition → both must be present as empty arrays so the
  // receipt's command_result shape is uniform across accepted and rejected
  // results.
  it("shape_invalid rejected result carries executed_argv=[] and target_paths=[]", async () => {
    const shapeInvalid = {
      command_id: "repo_lint",
      semantic_id: "lint_result",
      source: "ci_workflow",
      policy_status: "shape_invalid",
      shape_reasons: ["argv must be a non-empty string array"],
    };
    const r = await runValidatorJob({
      request: {
        request_id: "req-3b",
        files: [{ path: "app.js", content: "x" }],
        commands: ["repo_lint"],
        command_descriptors: { repo_lint: shapeInvalid },
        limits: { wall_clock_ms: 5000, memory_mb: 256, pids_limit: 32, output_bytes: 65536 },
        validator_image_ref: REF,
        validator_image_digest: DIGEST,
        expected_executor_policy: { network_disabled: true, non_root: true, read_only_rootfs: true, resource_limits: true },
      },
      config: makeConfig(),
    });
    const cr = r.command_results[0];
    expect(cr.status).toBe("rejected");
    expect(cr.executed_argv).toEqual([]);
    expect(cr.target_paths).toEqual([]);
    expect(cr.exit_status).toBeNull();
    expect(cr.output_ref).toBeNull();
    expect(cr.output_hash).toBeNull();
  });
});

describe("runValidatorJob — policy-invalid descriptor rejected", () => {
  it("records a rejected command_result with policy_reasons (npx without --no-install)", async () => {
    const policyInvalid = {
      ...VALID_DESCRIPTOR,
      argv: ["npx", "eslint", "app.js"], // missing --no-install
    };
    const r = await runValidatorJob({
      request: {
        request_id: "req-4",
        files: [{ path: "app.js", content: "x" }],
        commands: ["repo_lint"],
        command_descriptors: { repo_lint: policyInvalid },
        limits: { wall_clock_ms: 5000, memory_mb: 256, pids_limit: 32, output_bytes: 65536 },
        validator_image_ref: REF,
        validator_image_digest: DIGEST,
        expected_executor_policy: { network_disabled: true, non_root: true, read_only_rootfs: true, resource_limits: true },
      },
      config: makeConfig(),
    });
    expect(r.overall).not.toBe("pass");
    const cr = r.command_results[0];
    expect(cr.status).toBe("rejected");
    expect(cr.policy_reasons.join("; ")).toMatch(/--no-install/);
  });

  // Blocker 1 regression: a policy-rejected descriptor was never executed, but
  // its intended argv/target_paths are part of the audit trail — they show
  // exactly what was refused. executed_argv + target_paths must carry the
  // descriptor's intended values.
  it("policy-invalid rejected result carries the intended executed_argv + target_paths", async () => {
    const policyInvalid = {
      ...VALID_DESCRIPTOR,
      argv: ["npx", "eslint", "app.js", "../secret.js"], // missing --no-install + traversal
      target_paths: ["app.js", "../secret.js"],
    };
    const r = await runValidatorJob({
      request: {
        request_id: "req-4b",
        files: [{ path: "app.js", content: "x" }],
        commands: ["repo_lint"],
        command_descriptors: { repo_lint: policyInvalid },
        limits: { wall_clock_ms: 5000, memory_mb: 256, pids_limit: 32, output_bytes: 65536 },
        validator_image_ref: REF,
        validator_image_digest: DIGEST,
        expected_executor_policy: { network_disabled: true, non_root: true, read_only_rootfs: true, resource_limits: true },
      },
      config: makeConfig(),
    });
    const cr = r.command_results[0];
    expect(cr.status).toBe("rejected");
    expect(cr.executed_argv).toEqual(["npx", "eslint", "app.js", "../secret.js"]);
    expect(cr.target_paths).toEqual(["app.js", "../secret.js"]);
    expect(cr.exit_status).toBeNull();
  });
});

describe("runValidatorJob — legacy fallback when no descriptor", () => {
  it("uses the legacy template and records command_source=fallback_template", async () => {
    const r = await runValidatorJob({
      request: {
        request_id: "req-5",
        files: [{ path: "package.json", content: "{}" }],
        commands: ["lint"],
        // no command_descriptors → legacy path
        limits: { wall_clock_ms: 5000, memory_mb: 256, pids_limit: 32, output_bytes: 65536 },
        validator_image_ref: REF,
        validator_image_digest: DIGEST,
        expected_executor_policy: { network_disabled: true, non_root: true, read_only_rootfs: true, resource_limits: true },
      },
      config: makeConfig(),
    });
    expect(r.overall).toBe("pass");
    expect(r.command_results[0].command_source).toBe("fallback_template");
    expect(r.command_results[0].executed_argv).toBeUndefined();
  });
});

describe("runValidatorJob — hash includes descriptor fields", () => {
  it("the report hash is stable and recomputes identically", async () => {
    const r = await runValidatorJob({
      request: {
        request_id: "req-6",
        files: [{ path: "app.js", content: "x" }],
        commands: ["repo_lint"],
        command_descriptors: { repo_lint: VALID_DESCRIPTOR },
        limits: { wall_clock_ms: 5000, memory_mb: 256, pids_limit: 32, output_bytes: 65536 },
        validator_image_ref: REF,
        validator_image_digest: DIGEST,
        expected_executor_policy: { network_disabled: true, non_root: true, read_only_rootfs: true, resource_limits: true },
      },
      config: makeConfig(),
    });
    expect(r.executor_report_hash).toMatch(/^sha256:/);
    expect(r.executor_report_ref).toBe(`executor-report:${r.executor_report_hash}`);
  });
});
