// Tests for the executor-service backend (v0.23.0 Task 3, step 3-4).
//
// The backend implements the ExecutorBackend contract so it can register
// alongside node-executor and docker-executor. For Task 3, run() is a
// PLACEHOLDER that returns inconclusive with a typed reason — POST /v1/validate
// is Task 5. describe() returns real values for /health and receipt binding.

import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
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

describe("executorServiceBackend — run() (Task 5: real POST /v1/validate)", () => {
  const ORIG_ENV = { ...process.env };

  beforeEach(() => {
    delete process.env.GITWIRE_EXECUTOR_SERVICE_URL;
    delete process.env.GITWIRE_EXECUTOR_SERVICE_TOKEN;
    delete process.env.GITWIRE_VALIDATOR_IMAGE_REF;
    delete process.env.GITWIRE_VALIDATOR_IMAGE_DIGEST;
  });
  afterEach(() => {
    for (const k of Object.keys(ORIG_ENV)) process.env[k] = ORIG_ENV[k];
  });

  it("returns inconclusive when GITWIRE_EXECUTOR_SERVICE_URL is not configured", async () => {
    const r = await executorServiceBackend.run({
      files: [{ path: "x", content: "y" }],
      commands: ["lint"],
      limits: {},
      sandbox_image_digest: "sha256:" + "a".repeat(64),
    });
    expect(r.overall).toBe("inconclusive");
    expect(r.inconclusive_reason).toBe("executor_service_url_not_configured");
  });

  it("calls POST /v1/validate and returns the service's response when configured", async () => {
    process.env.GITWIRE_EXECUTOR_SERVICE_URL = "http://executor:3003";
    process.env.GITWIRE_EXECUTOR_SERVICE_TOKEN = "t";
    process.env.GITWIRE_VALIDATOR_IMAGE_REF = "reg/v@sha256:" + "a".repeat(64);
    process.env.GITWIRE_VALIDATOR_IMAGE_DIGEST = "sha256:" + "a".repeat(64);

    // Inject a fake fetch that returns a pass response.
    const { _setFetchForTests } = await import("../../src/lib/executorServiceClient.js");
    _setFetchForTests(async () => ({
      ok: true, status: 200,
      json: async () => ({
        report_schema_version: 1,
        executor_service_id: "executor-service",
        executor_service_version: "1.0.0",
        overall: "pass",
        aggregate_exit_status: 0,
        executor_report_hash: "sha256:" + "f".repeat(64),
        executor_report_ref: "executor-report:sha256:" + "f".repeat(64),
        command_results: [{ command: "lint", exit_status: 0, output_hash: "sha256:x", duration_ms: 5 }],
        network_disabled: true, non_root: true, read_only_rootfs: true,
      }),
    }));
    try {
      const r = await executorServiceBackend.run({
        files: [{ path: "x", content: "y" }],
        commands: ["lint"],
        limits: {},
        sandbox_image_digest: "sha256:" + "a".repeat(64),
      });
      expect(r.overall).toBe("pass");
      expect(r.executor_report_hash).toMatch(/^sha256:/);
      expect(r.command_results).toHaveLength(1);
    } finally {
      _setFetchForTests(null);
    }
  });

  it("returns inconclusive when the service returns inconclusive", async () => {
    process.env.GITWIRE_EXECUTOR_SERVICE_URL = "http://executor:3003";
    process.env.GITWIRE_EXECUTOR_SERVICE_TOKEN = "t";
    process.env.GITWIRE_VALIDATOR_IMAGE_REF = "reg/v@sha256:" + "a".repeat(64);
    process.env.GITWIRE_VALIDATOR_IMAGE_DIGEST = "sha256:" + "a".repeat(64);

    const { _setFetchForTests } = await import("../../src/lib/executorServiceClient.js");
    _setFetchForTests(async () => ({
      ok: true, status: 200,
      json: async () => ({ overall: "inconclusive", inconclusive_reason: "image_inspection_failed" }),
    }));
    try {
      const r = await executorServiceBackend.run({
        files: [{ path: "x", content: "y" }],
        commands: ["lint"],
        limits: {},
        sandbox_image_digest: "sha256:" + "a".repeat(64),
      });
      expect(r.overall).toBe("inconclusive");
      expect(r.inconclusive_reason).toBe("image_inspection_failed");
      // P1 #3: even on inconclusive, command_results + aggregate_exit_status
      // MUST be present so sandboxRunner's .map()/.filter() don't crash.
      expect(r.command_results).toEqual([]);
      expect(r.aggregate_exit_status).toBeNull();
    } finally {
      _setFetchForTests(null);
    }
  });

  it("returns inconclusive on network error (fetch rejects)", async () => {
    process.env.GITWIRE_EXECUTOR_SERVICE_URL = "http://executor:3003";
    process.env.GITWIRE_EXECUTOR_SERVICE_TOKEN = "t";
    process.env.GITWIRE_VALIDATOR_IMAGE_REF = "reg/v@sha256:" + "a".repeat(64);
    process.env.GITWIRE_VALIDATOR_IMAGE_DIGEST = "sha256:" + "a".repeat(64);

    const { _setFetchForTests } = await import("../../src/lib/executorServiceClient.js");
    _setFetchForTests(async () => { throw new Error("ECONNREFUSED"); });
    try {
      const r = await executorServiceBackend.run({
        files: [{ path: "x", content: "y" }],
        commands: ["lint"],
        limits: {},
        sandbox_image_digest: "sha256:" + "a".repeat(64),
      });
      expect(r.overall).toBe("inconclusive");
      expect(r.inconclusive_reason).toBe("executor_error");
      // P1 #3: normalized to complete ExecResult shape.
      expect(r.command_results).toEqual([]);
      expect(r.aggregate_exit_status).toBeNull();
    } finally {
      _setFetchForTests(null);
    }
  });

  // P1 #3 lock-in: a non-200 response from postValidate synthesizes
  // { overall: "inconclusive", inconclusive_reason: "executor_error" } WITHOUT
  // command_results or aggregate_exit_status. The backend MUST normalize it
  // so sandboxRunner doesn't crash.
  it("normalizes non-200 responses to complete ExecResult shape", async () => {
    process.env.GITWIRE_EXECUTOR_SERVICE_URL = "http://executor:3003";
    process.env.GITWIRE_EXECUTOR_SERVICE_TOKEN = "t";
    process.env.GITWIRE_VALIDATOR_IMAGE_REF = "reg/v@sha256:" + "a".repeat(64);
    process.env.GITWIRE_VALIDATOR_IMAGE_DIGEST = "sha256:" + "a".repeat(64);

    const { _setFetchForTests } = await import("../../src/lib/executorServiceClient.js");
    _setFetchForTests(async () => ({ ok: false, status: 401 }));
    try {
      const r = await executorServiceBackend.run({
        files: [{ path: "x", content: "y" }],
        commands: ["lint"],
        limits: {},
        sandbox_image_digest: "sha256:" + "a".repeat(64),
      });
      expect(r.overall).toBe("inconclusive");
      expect(r.inconclusive_reason).toBe("executor_error");
      expect(r.command_results).toEqual([]);
      expect(r.aggregate_exit_status).toBeNull();
    } finally {
      _setFetchForTests(null);
    }
  });
});
