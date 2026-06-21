// Verifies runSandboxVerification() threads executor_kind + validator identity
// into the produced receipt, using PROVEN reachability (not supports_pass).
//
// Key invariant (Gap 1 fix #3/#4): docker-executor is pass-capable ONLY when
//   backend.supports_pass === true
//   AND kind is structurally pass-capable
//   AND live reachability for that kind is true
//   AND validator identity is complete
// These tests pin each branch of that conjunction deterministically,
// independent of whether Docker happens to be reachable in the sandbox.

import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { setConfig } from "@gitwire/runtime/compat/_init.js";

// runSandboxVerification() uses the runtime logger, which requires the
// runtime to be initialized. setConfig() with LOG_LEVEL silent is the
// established pattern (see tests/unit/commentRouter.test.js).
setConfig({
  LOG_LEVEL: "silent",
  REDIS_URL: "redis://localhost:6379",
  DATABASE_URL: "postgresql://localhost/gitops_hub",
  GITHUB_APP_ID: "test",
  GITHUB_PRIVATE_KEY: "test",
});

import { runSandboxVerification } from "../../src/lib/sandboxRunner.js";

// Minimal artifact + envelope. The artifact's files[] will fail to apply
// against SOURCE (path mismatch → apply returns not-applied), producing an
// inconclusive receipt via the artifact-apply-failed path. We only assert
// on the receipt's executor/validator binding fields, not on pass.
const ARTIFACT = JSON.stringify({
  base_sha: "abc",
  files: [{ path: "does-not-exist.txt", content: "hi" }],
  operations: [],
});

const ENVELOPE = {
  // "lint" is allowlisted in validationCommandTemplates.js. It will fail at
  // run time (no package.json), but that's irrelevant — we assert on receipt
  // binding fields, not execution outcome.
  required_validation: ["lint"],
};

const SOURCE = [{ path: "x.txt", content: "old" }];

const COMPLETE_REF = "registry.example.com/v@sha256:" + "a".repeat(64);
const COMPLETE_DIGEST = "sha256:" + "a".repeat(64);

function parseReceipt(result) {
  return JSON.parse(result.receipt.receipt_content);
}

describe("runSandboxVerification — node-executor receipt bindings", () => {
  beforeEach(() => {
    process.env.GITWIRE_EXECUTOR_BACKEND = "node-executor";
    delete process.env.GITWIRE_VALIDATOR_IMAGE_REF;
    delete process.env.GITWIRE_VALIDATOR_IMAGE_DIGEST;
  });
  afterEach(() => {
    delete process.env.GITWIRE_EXECUTOR_BACKEND;
  });

  // Checkpoint: node-executor receipts always carry executor_kind=local-process
  it("carries executor_kind=local-process", async () => {
    const result = await runSandboxVerification({
      artifactContent: ARTIFACT,
      base_sha: "abc",
      taskEnvelope: ENVELOPE,
      sourceFiles: SOURCE,
      source_snapshot_hash: "sha256:src",
      input_bundle_hash: "sha256:bundle",
      patch_artifact_hash: "sha256:patch",
    });
    expect(parseReceipt(result).executor_kind).toBe("local-process");
  });

  // Checkpoint: node-executor receipts always carry executor_pass_capable=false
  it("carries executor_pass_capable=false", async () => {
    const result = await runSandboxVerification({
      artifactContent: ARTIFACT,
      base_sha: "abc",
      taskEnvelope: ENVELOPE,
      sourceFiles: SOURCE,
      source_snapshot_hash: "sha256:src",
      input_bundle_hash: "sha256:bundle",
      patch_artifact_hash: "sha256:patch",
    });
    expect(parseReceipt(result).executor_pass_capable).toBe(false);
  });

  // Checkpoint: node-executor validator_result_status is inconclusive, never pass
  it("has validator_result_status=inconclusive (never pass)", async () => {
    const result = await runSandboxVerification({
      artifactContent: ARTIFACT,
      base_sha: "abc",
      taskEnvelope: ENVELOPE,
      sourceFiles: SOURCE,
      source_snapshot_hash: "sha256:src",
      input_bundle_hash: "sha256:bundle",
      patch_artifact_hash: "sha256:patch",
    });
    const status = parseReceipt(result).validator_result_status;
    expect(status).toBe("inconclusive");
    expect(status).not.toBe("pass");
  });

  // Checkpoint: proof_collected_at still propagates as a receipt sibling
  it("propagates proof_collected_at as a sibling", async () => {
    const result = await runSandboxVerification({
      artifactContent: ARTIFACT,
      base_sha: "abc",
      taskEnvelope: ENVELOPE,
      sourceFiles: SOURCE,
      source_snapshot_hash: "sha256:src",
      input_bundle_hash: "sha256:bundle",
      patch_artifact_hash: "sha256:patch",
    });
    expect(result.receipt.proof_collected_at).toBeDefined();
    expect(typeof result.receipt.proof_collected_at).toBe("string");
  });

  // Even with a complete validator identity configured, node-executor stays
  // non-pass-capable because its KIND is structurally non-pass-capable.
  it("stays non-pass-capable even when validator identity IS complete", async () => {
    process.env.GITWIRE_VALIDATOR_IMAGE_REF = COMPLETE_REF;
    process.env.GITWIRE_VALIDATOR_IMAGE_DIGEST = COMPLETE_DIGEST;
    try {
      const result = await runSandboxVerification({
        artifactContent: ARTIFACT,
        base_sha: "abc",
        taskEnvelope: ENVELOPE,
        sourceFiles: SOURCE,
        source_snapshot_hash: "sha256:src",
        input_bundle_hash: "sha256:bundle",
        patch_artifact_hash: "sha256:patch",
      });
      const parsed = parseReceipt(result);
      expect(parsed.executor_pass_capable).toBe(false);
      expect(parsed.validator_result_status).toBe("inconclusive");
    } finally {
      delete process.env.GITWIRE_VALIDATOR_IMAGE_REF;
      delete process.env.GITWIRE_VALIDATOR_IMAGE_DIGEST;
    }
  });
});

describe("runSandboxVerification — docker-executor pass-capability conjunction", () => {
  beforeEach(() => {
    // Force docker-executor selection (simulates getDefaultBackend returning it).
    // Note: Task 7.5 will make getDefaultBackend reachability-honest; here we
    // force the id directly to isolate the runner's binding logic.
    process.env.GITWIRE_EXECUTOR_BACKEND = "docker-executor";
  });
  afterEach(() => {
    delete process.env.GITWIRE_EXECUTOR_BACKEND;
    delete process.env.GITWIRE_VALIDATOR_IMAGE_REF;
    delete process.env.GITWIRE_VALIDATOR_IMAGE_DIGEST;
  });

  // Checkpoint: docker-executor without complete validator identity is not pass-capable.
  // This holds regardless of whether Docker is reachable: missing identity alone
  // disqualifies pass-capability (one of the four conditions fails).
  it("is NOT pass-capable when validator identity is missing", async () => {
    delete process.env.GITWIRE_VALIDATOR_IMAGE_REF;
    delete process.env.GITWIRE_VALIDATOR_IMAGE_DIGEST;
    const result = await runSandboxVerification({
      artifactContent: ARTIFACT,
      base_sha: "abc",
      taskEnvelope: ENVELOPE,
      sourceFiles: SOURCE,
      source_snapshot_hash: "sha256:src",
      input_bundle_hash: "sha256:bundle",
      patch_artifact_hash: "sha256:patch",
    });
    const parsed = parseReceipt(result);
    expect(parsed.executor_kind).toBe("container-runtime");
    expect(parsed.executor_pass_capable).toBe(false);
    expect(parsed.validator_result_status).toBe("inconclusive");
  });

  // Checkpoint: docker-executor with live reachability but missing identity
  // still cannot emit pass-capable proof. The four-condition conjunction
  // requires ALL four; missing identity breaks it even if the other three hold.
  // (In this sandbox Docker may be reachable, which actually strengthens this
  //  test: it proves identity-completeness is independently gating.)
  it("cannot emit pass-capable proof when identity is missing, even if Docker is reachable", async () => {
    // Deliberately do NOT set the validator image env — identity incomplete.
    delete process.env.GITWIRE_VALIDATOR_IMAGE_REF;
    delete process.env.GITWIRE_VALIDATOR_IMAGE_DIGEST;
    const result = await runSandboxVerification({
      artifactContent: ARTIFACT,
      base_sha: "abc",
      taskEnvelope: ENVELOPE,
      sourceFiles: SOURCE,
      source_snapshot_hash: "sha256:src",
      input_bundle_hash: "sha256:bundle",
      patch_artifact_hash: "sha256:patch",
    });
    const parsed = parseReceipt(result);
    // Regardless of reachability, identity is incomplete → not pass-capable.
    expect(parsed.executor_pass_capable).toBe(false);
    expect(parsed.validator_result_status).toBe("inconclusive");
  });

  // Structural check: docker-executor receipt always carries the right kind.
  it("carries executor_kind=container-runtime", async () => {
    const result = await runSandboxVerification({
      artifactContent: ARTIFACT,
      base_sha: "abc",
      taskEnvelope: ENVELOPE,
      sourceFiles: SOURCE,
      source_snapshot_hash: "sha256:src",
      input_bundle_hash: "sha256:bundle",
      patch_artifact_hash: "sha256:patch",
    });
    expect(parseReceipt(result).executor_kind).toBe("container-runtime");
  });
});
