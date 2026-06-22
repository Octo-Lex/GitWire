// Tests for executor-service registration + probe (v0.23.0 Task 3, step 6).

import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import {
  EXECUTOR_KINDS,
  executorKindForBackendId,
  probeExecutorService,
} from "../../src/lib/executorReachability.js";
import { getBackend, listBackends } from "../../src/lib/executorRegistry.js";

describe("executor-service backend registration", () => {
  it("is in the registry (registerBackend landed)", () => {
    expect(listBackends()).toContain("executor-service");
  });

  it("can be retrieved by getBackend('executor-service')", () => {
    const b = getBackend("executor-service");
    expect(b.id).toBe("executor-service");
  });
});

describe("executorKindForBackendId — executor-service mapping", () => {
  it("maps executor-service → container-runtime", () => {
    expect(executorKindForBackendId("executor-service")).toBe(EXECUTOR_KINDS.CONTAINER_RUNTIME);
  });
});

describe("probeExecutorService — shape", () => {
  // The probe calls the HTTP client; inject the client via the module's
  // _setExecutorServiceClientForTests seam (production wires the real client).
  // Probe returns the SAME shape as the sibling probes (probeContainerRuntime,
  // probeLocalProcess): reachable/runtime/version + kind.
  it("returns the probe shape: reachable + runtime + version + kind", async () => {
    const { _setExecutorServiceClientForTests } = await import("../../src/lib/executorReachability.js");
    _setExecutorServiceClientForTests(async () => ({
      reachable: true,
      container_runtime: "docker",
      runtime_version: "29.5.0",
    }));
    try {
      const r = await probeExecutorService();
      expect(r).toHaveProperty("reachable", true);
      // Probe uses runtime/version (matches sibling probes), not the client's
      // container_runtime/runtime_version. The probe maps the client's fields.
      expect(r).toHaveProperty("runtime", "docker");
      expect(r).toHaveProperty("version", "29.5.0");
      expect(r).toHaveProperty("kind", EXECUTOR_KINDS.CONTAINER_RUNTIME);
    } finally {
      _setExecutorServiceClientForTests(null);
    }
  });
});

describe("probeExecutorService — unconfigured (no URL)", () => {
  beforeEach(() => {
    delete process.env.GITWIRE_EXECUTOR_SERVICE_URL;
    delete process.env.GITWIRE_EXECUTOR_SERVICE_TOKEN;
  });
  afterEach(() => {
    delete process.env.GITWIRE_EXECUTOR_SERVICE_URL;
    delete process.env.GITWIRE_EXECUTOR_SERVICE_TOKEN;
  });

  it("returns reachable=false when GITWIRE_EXECUTOR_SERVICE_URL is unset", async () => {
    const { _setExecutorServiceClientForTests } = await import("../../src/lib/executorReachability.js");
    // Real client would itself return reachable:false for null URL; we model
    // that by injecting a client that mirrors the production fallback.
    _setExecutorServiceClientForTests(null); // restore real (which reads config)
    const r = await probeExecutorService();
    expect(r.reachable).toBe(false);
  });
});

describe("probeExecutorService — network failure is reachable:false, never throw", () => {
  it("returns reachable:false when the client returns reachable:false", async () => {
    const { _setExecutorServiceClientForTests } = await import("../../src/lib/executorReachability.js");
    _setExecutorServiceClientForTests(async () => ({ reachable: false, detail: "ECONNREFUSED" }));
    try {
      const r = await probeExecutorService();
      expect(r.reachable).toBe(false);
    } finally {
      _setExecutorServiceClientForTests(null);
    }
  });
});
