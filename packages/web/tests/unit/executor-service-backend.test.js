// Tests for the executor-service backend (v0.23.0 Task 3, step 3-4).
//
// The backend implements the ExecutorBackend contract so it can register
// alongside node-executor and docker-executor. For Task 3, run() is a
// PLACEHOLDER that returns inconclusive with a typed reason — POST /v1/validate
// is Task 5. describe() returns real values for /health and receipt binding.

import { describe, it, expect } from "@jest/globals";
import { executorServiceBackend } from "../../src/lib/executorServiceBackend.js";
import { validateBackendContract } from "../../src/lib/executorBackend.js";

describe("executorServiceBackend — ExecutorBackend contract", () => {
  it("satisfies validateBackendContract (registers cleanly)", () => {
    expect(() => validateBackendContract(executorServiceBackend)).not.toThrow();
  });

  it("has stable id='executor-service'", () => {
    expect(executorServiceBackend.id).toBe("executor-service");
  });

  it("has version 1.0.0 (matches the executor service's reported version)", () => {
    expect(executorServiceBackend.version).toBe("1.0.0");
  });

  it("has image_digest shaped sha256:...", () => {
    expect(executorServiceBackend.image_digest).toMatch(/^sha256:[0-9a-f]+$/);
  });

  it("advertises supports_pass=true (pass-capable backend by contract)", () => {
    expect(executorServiceBackend.supports_pass).toBe(true);
  });

  it("declares container_runtime='docker' (the v0.23.0 CT-local default)", () => {
    expect(executorServiceBackend.container_runtime).toBe("docker");
  });

  it("declares the isolation contract (all flags true)", () => {
    expect(executorServiceBackend.network_disabled).toBe(true);
    expect(executorServiceBackend.non_root).toBe(true);
    expect(executorServiceBackend.read_only_rootfs).toBe(true);
    expect(executorServiceBackend.resource_limits).toBeInstanceOf(Object);
  });
});

describe("executorServiceBackend — describe()", () => {
  const d = executorServiceBackend.describe();

  it("returns the isolation binding shape", () => {
    expect(d).toHaveProperty("execution_backend_id");
    expect(d).toHaveProperty("executor_version");
    expect(d).toHaveProperty("sandbox_image_digest");
    expect(d).toHaveProperty("container_runtime");
    expect(d).toHaveProperty("network_disabled");
    expect(d).toHaveProperty("non_root");
    expect(d).toHaveProperty("read_only_rootfs");
    expect(d).toHaveProperty("resource_limits");
  });

  it("execution_backend_id === backend.id (consistency)", () => {
    expect(d.execution_backend_id).toBe(executorServiceBackend.id);
  });

  it("exposes image_ref for receipt binding (the validator image, not the backend's own)", () => {
    expect(d).toHaveProperty("image_ref");
  });
});

describe("executorServiceBackend — run() placeholder (Task 3)", () => {
  it("returns inconclusive with a typed reason (POST /v1/validate is Task 5)", async () => {
    const r = await executorServiceBackend.run({
      files: [{ path: "x", content: "y" }],
      commands: ["lint"],
      limits: {},
      sandbox_image_digest: "sha256:" + "a".repeat(64),
    });
    expect(r.overall).toBe("inconclusive");
    expect(r.inconclusive_reason).toBe("executor_service_validate_not_implemented");
    expect(r.aggregate_exit_status).toBeNull();
    expect(r.command_results).toEqual([]);
  });

  it("never returns pass (Task 5 must land before pass is possible)", async () => {
    const r = await executorServiceBackend.run({
      files: [{ path: "x", content: "y" }],
      commands: ["lint"],
      limits: {},
      sandbox_image_digest: "sha256:" + "a".repeat(64),
    });
    expect(r.overall).not.toBe("pass");
  });
});
