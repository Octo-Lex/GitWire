// Tests for the validator runner (v0.23.0 Task 5, step 3-4).
//
// runValidatorJob() is the core: it inspects the pinned validator image,
// validates the digest, materializes the workspace, runs each allowlisted
// command in an isolated container, and returns the executor report object.
//
// Tests inject:
//   - cmdRunner:     (cmd[]) => { ok, stdout, stderr, code } for docker run/exec
//   - imageInspector:() => { ok, digest, hash } for docker inspect
// so no real Docker is needed.

import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { runValidatorJob } from "../src/validatorRunner.js";

const REF = "registry.example.com/v@sha256:" + "a".repeat(64);
const DIGEST = "sha256:" + "a".repeat(64);

function makeConfig(overrides = {}) {
  return {
    executor_service_id: "executor-service",
    executor_service_version: "1.0.0",
    executor_service_instance_id: "test-instance",
    deployment_mode: "compose-local",
    validator_image_ref: REF,
    validator_image_digest: DIGEST,
    ...overrides,
  };
}

function makeRequest(overrides = {}) {
  return {
    request_id: "req-1",
    files: [{ path: "package.json", content: '{"name":"x"}' }],
    commands: ["lint"],
    limits: { wall_clock_ms: 5000, memory_mb: 256, pids_limit: 32, output_bytes: 65536 },
    validator_image_ref: REF,
    validator_image_digest: DIGEST,
    expected_executor_policy: {
      network_disabled: true, non_root: true, read_only_rootfs: true, resource_limits: true,
    },
    ...overrides,
  };
}

// Image inspector that returns the configured digest (matches → pass path).
function matchingInspector() {
  return () => ({ ok: true, digest: DIGEST, hash: "sha256:" + "b".repeat(64) });
}

// cmdRunner that simulates a successful docker run: exit 0, some stdout.
function successRunner() {
  return (cmd) => {
    // The runner calls `docker run ...`; respond with exit 0.
    if (cmd[0] === "docker" || cmd[0] === "podman") {
      return { ok: true, stdout: "lint passed", stderr: "", code: 0 };
    }
    return { ok: false, stdout: "", stderr: "unknown command", code: 1 };
  };
}

// cmdRunner that simulates a failing command (lint exits 1).
function failRunner() {
  return (cmd) => ({ ok: true, stdout: "", stderr: "lint failed", code: 1 });
}

describe("runValidatorJob — pass path", () => {
  it("returns overall=pass when all commands exit 0 + digest matches", async () => {
    const r = await runValidatorJob({
      request: makeRequest(),
      config: makeConfig(),
      cmdRunner: successRunner(),
      imageInspector: matchingInspector(),
    });
    expect(r.overall).toBe("pass");
    expect(r.aggregate_exit_status).toBe(0);
    expect(r.inspected_image_digest).toBe(DIGEST);
    expect(r.network_disabled).toBe(true);
    expect(r.non_root).toBe(true);
    expect(r.read_only_rootfs).toBe(true);
    expect(r.command_results).toHaveLength(1);
    expect(r.command_results[0].exit_status).toBe(0);
  });

  it("includes executor_report_hash + executor_report_ref on pass", async () => {
    const r = await runValidatorJob({
      request: makeRequest(),
      config: makeConfig(),
      cmdRunner: successRunner(),
      imageInspector: matchingInspector(),
    });
    expect(r.executor_report_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(r.executor_report_ref).toBe("executor-report:" + r.executor_report_hash);
  });

  it("includes report_schema_version=1", async () => {
    const r = await runValidatorJob({
      request: makeRequest(),
      config: makeConfig(),
      cmdRunner: successRunner(),
      imageInspector: matchingInspector(),
    });
    expect(r.report_schema_version).toBe(1);
  });
});

describe("runValidatorJob — fail path", () => {
  it("returns overall=fail when a command exits non-zero", async () => {
    const r = await runValidatorJob({
      request: makeRequest(),
      config: makeConfig(),
      cmdRunner: failRunner(),
      imageInspector: matchingInspector(),
    });
    expect(r.overall).toBe("fail");
    expect(r.aggregate_exit_status).toBe(1);
  });
});

describe("runValidatorJob — inconclusive paths", () => {
  it("returns inconclusive + validator_image_ref_mismatch when request ref != config ref", async () => {
    const r = await runValidatorJob({
      request: makeRequest({ validator_image_ref: "other@sha256:" + "z".repeat(64) }),
      config: makeConfig(),
      cmdRunner: successRunner(),
      imageInspector: matchingInspector(),
    });
    expect(r.overall).toBe("inconclusive");
    expect(r.inconclusive_reason).toBe("validator_image_ref_mismatch");
  });

  it("returns inconclusive + image_inspection_failed when inspected digest != configured", async () => {
    const r = await runValidatorJob({
      request: makeRequest(),
      config: makeConfig(),
      cmdRunner: successRunner(),
      imageInspector: () => ({ ok: true, digest: "sha256:" + "9".repeat(64), hash: "sha256:x" }),
    });
    expect(r.overall).toBe("inconclusive");
    expect(r.inconclusive_reason).toBe("image_inspection_failed");
  });

  it("returns inconclusive + image_inspection_failed when inspect itself fails", async () => {
    const r = await runValidatorJob({
      request: makeRequest(),
      config: makeConfig(),
      cmdRunner: successRunner(),
      imageInspector: () => ({ ok: false }),
    });
    expect(r.overall).toBe("inconclusive");
    expect(r.inconclusive_reason).toBe("image_inspection_failed");
  });

  // Non-blocking regression: multiple RepoDigests entries. The configured digest
  // should be accepted when it appears anywhere in RepoDigests, not only first.
  it("accepts configured digest when it's the SECOND entry in RepoDigests (multi-registry)", async () => {
    const OTHER_DIGEST = "sha256:" + "1".repeat(64); // different from DIGEST
    const r = await runValidatorJob({
      request: makeRequest(),
      config: makeConfig(),
      cmdRunner: successRunner(),
      imageInspector: () => ({
        ok: true,
        digest: OTHER_DIGEST,          // first parsed (not the match)
        all_digests: [OTHER_DIGEST, DIGEST],  // configured digest is second
        hash: "sha256:" + "b".repeat(64),
      }),
    });
    // Must still pass — the configured digest IS present in all_digests.
    expect(r.overall).toBe("pass");
    expect(r.inspected_image_digest).toBe(DIGEST); // the matching one, not all_digests[0]
  });

  it("rejects when configured digest is NOT in any RepoDigests entry", async () => {
    const UNRELATED = "sha256:" + "2".repeat(64);
    const r = await runValidatorJob({
      request: makeRequest(),
      config: makeConfig(),
      cmdRunner: successRunner(),
      imageInspector: () => ({
        ok: true,
        digest: UNRELATED,
        all_digests: [UNRELATED, "sha256:" + "3".repeat(64)],
        hash: "sha256:" + "b".repeat(64),
      }),
    });
    expect(r.overall).toBe("inconclusive");
    expect(r.inconclusive_reason).toBe("image_inspection_failed");
  });
    const r = await runValidatorJob({
      request: makeRequest(),
      config: makeConfig(),
      // cmdRunner returns ok:false → runner treats as spawn error → exit_status null
      cmdRunner: () => ({ ok: false, stdout: "", stderr: "", code: null }),
      imageInspector: matchingInspector(),
    });
    expect(r.overall).toBe("inconclusive");
    expect(r.inconclusive_reason).toBe("execution_incomplete");
  });

  it("returns inconclusive + executor_error when a non-allowlisted command id is requested", async () => {
    const r = await runValidatorJob({
      request: makeRequest({ commands: ["evil-shell"] }),
      config: makeConfig(),
      cmdRunner: successRunner(),
      imageInspector: matchingInspector(),
    });
    // Non-allowlisted command → exit_status null for that command → inconclusive.
    expect(r.overall).toBe("inconclusive");
    expect(r.command_results[0]).toMatchObject({ command: "evil-shell", exit_status: null });
  });
});

describe("runValidatorJob — isolation flag surface", () => {
  it("surfaces network_disabled/non_root/read_only_rootfs=true in the report", async () => {
    const r = await runValidatorJob({
      request: makeRequest(),
      config: makeConfig(),
      cmdRunner: successRunner(),
      imageInspector: matchingInspector(),
    });
    // The runner ALWAYS uses --network=none --read-only --user=1000:1000;
    // these flags are static in the docker run argv, not negotiable.
    expect(r.network_disabled).toBe(true);
    expect(r.non_root).toBe(true);
    expect(r.read_only_rootfs).toBe(true);
    expect(r.resource_limits).toMatchObject({ memory_mb: 256, pids_limit: 32 });
  });
});

describe("runValidatorJob — never returns pass incorrectly", () => {
  it("never returns overall=pass when any isolation evidence is missing", async () => {
    // Even with a successful cmdRunner, if image inspection fails, no pass.
    const r = await runValidatorJob({
      request: makeRequest(),
      config: makeConfig(),
      cmdRunner: successRunner(),
      imageInspector: () => ({ ok: false }),
    });
    expect(r.overall).not.toBe("pass");
  });
});
