// Tests that buildExecutionReceipt() binds the Gap 1 validator fields.

import { describe, it, expect } from "@jest/globals";
import { buildExecutionReceipt } from "../../src/lib/sandboxRunner.js";

const BASE_PARAMS = {
  execution_backend_id: "docker-executor",
  executor_version: "1.0.0",
  source_snapshot_hash: "sha256:src",
  patch_artifact_hash: "sha256:patch",
  base_sha: "abc",
  input_bundle_hash: "sha256:bundle",
  sandbox_image_digest: "sha256:" + "a".repeat(64),
  validation_plan_hash: "sha256:plan",
  commands_executed: ["npm-test"],
  per_command_exit_statuses: [0],
  aggregate_exit_status: 0,
  output_refs: ["output:1"],
  output_hashes: ["sha256:1"],
  limits_applied: {},
  result: "pass",
  container_runtime: "docker",
  runtime_version: "24.0.7",
  network_disabled: true,
  non_root: true,
  read_only_rootfs: true,
  resource_limits: {},
  image_ref: "registry.example.com/gitwire/validator@sha256:" + "a".repeat(64),
  // Gap 1 new fields:
  executor_kind: "container-runtime",
  executor_pass_capable: true,
  validator_image_ref: "registry.example.com/gitwire/validator@sha256:" + "a".repeat(64),
  validator_image_digest: "sha256:" + "a".repeat(64),
  validator_result: "pass",
  validator_result_status: "pass",
};

describe("buildExecutionReceipt — validator fields bound", () => {
  it("receipt content contains executor_kind", () => {
    const { receipt_content } = buildExecutionReceipt(BASE_PARAMS);
    const parsed = JSON.parse(receipt_content);
    expect(parsed.executor_kind).toBe("container-runtime");
  });

  it("receipt content contains executor_pass_capable", () => {
    const { receipt_content } = buildExecutionReceipt(BASE_PARAMS);
    const parsed = JSON.parse(receipt_content);
    expect(parsed.executor_pass_capable).toBe(true);
  });

  it("receipt content contains validator_image_ref + digest", () => {
    const { receipt_content } = buildExecutionReceipt(BASE_PARAMS);
    const parsed = JSON.parse(receipt_content);
    expect(parsed.validator_image_ref).toContain("sha256:");
    expect(parsed.validator_image_digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("receipt content contains validator_result + validator_result_status", () => {
    const { receipt_content } = buildExecutionReceipt(BASE_PARAMS);
    const parsed = JSON.parse(receipt_content);
    expect(parsed.validator_result).toBe("pass");
    expect(parsed.validator_result_status).toBe("pass");
  });

  it("receipt content does NOT contain proof_collected_at (stays content-addressed)", () => {
    const { receipt_content } = buildExecutionReceipt(BASE_PARAMS);
    const parsed = JSON.parse(receipt_content);
    expect(parsed.proof_collected_at).toBeUndefined();
  });

  it("proof_collected_at is returned as a SIBLING, not inside the hash", () => {
    const result = buildExecutionReceipt(BASE_PARAMS);
    expect(result.proof_collected_at).toBeDefined();
    expect(typeof result.proof_collected_at).toBe("string");
  });
});

describe("buildExecutionReceipt — local-process is never pass-capable in receipt", () => {
  it("node-executor receipt carries executor_pass_capable=false", () => {
    const { receipt_content } = buildExecutionReceipt({
      ...BASE_PARAMS,
      execution_backend_id: "node-executor",
      executor_kind: "local-process",
      executor_pass_capable: false,
      result: "inconclusive",
      validator_result: "inconclusive",
      validator_result_status: "inconclusive",
      inconclusive_reason: "host_spawn_not_isolated",
      image_ref: null,
      validator_image_ref: null,
      validator_image_digest: null,
    });
    const parsed = JSON.parse(receipt_content);
    expect(parsed.executor_pass_capable).toBe(false);
    expect(parsed.validator_result_status).toBe("inconclusive");
  });
});

describe("buildExecutionReceipt — hash determinism preserved", () => {
  it("identical inputs produce identical receipt_hash", () => {
    const a = buildExecutionReceipt(BASE_PARAMS);
    const b = buildExecutionReceipt(BASE_PARAMS);
    expect(a.receipt_hash).toBe(b.receipt_hash);
  });
});
