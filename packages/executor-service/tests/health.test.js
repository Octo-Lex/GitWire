// Tests for the /health response builder (v0.23.0 Task 2, step 5-6).
//
// buildHealthResponse() is a PURE function: it takes {config, probeResult}
// and returns the JSON-able health object. The HTTP server (server.js) just
// wires HTTP to this builder. This keeps the response shape testable without
// binding a port or depending on Docker.

import { describe, it, expect } from "@jest/globals";
import { buildHealthResponse } from "../src/health.js";

// ── Helpers ────────────────────────────────────────────────────────────────
function baseConfig(overrides = {}) {
  return {
    executor_service_id: "executor-service",
    executor_service_version: "1.0.0",
    deployment_mode: "compose-local",
    port: 3003,
    service_token: null,
    validator_image_ref: null,
    validator_image_digest: null,
    validatorIdentityComplete: () => Boolean(overrides.validator_image_ref) && Boolean(overrides.validator_image_digest),
    ...overrides,
  };
}

const runtimeReachable = { reachable: true, container_runtime: "docker", runtime_version: "29.5.0" };
const runtimeUnreachable = { reachable: false, container_runtime: null, runtime_version: null };

// ── Shape (acceptance) ─────────────────────────────────────────────────────
describe("buildHealthResponse — required fields present", () => {
  const r = buildHealthResponse({
    config: baseConfig({ validator_image_ref: "r@sha256:" + "a".repeat(64), validator_image_digest: "sha256:" + "a".repeat(64) }),
    probeResult: runtimeReachable,
  });

  // The 10 fields from the v0.23.0 design doc's GET /health contract:
  for (const field of [
    "status",
    "executor_service_id",
    "executor_service_version",
    "executor_service_instance_id",
    "deployment_mode",
    "container_runtime",
    "runtime_version",
    "validator_image_ref",
    "validator_image_digest",
    "ready",
  ]) {
    it(`includes ${field}`, () => {
      expect(r).toHaveProperty(field);
    });
  }
});

describe("buildHealthResponse — field values", () => {
  it("status='ok' regardless of ready (liveness-safe, like gitwire-app /health)", () => {
    const r = buildHealthResponse({ config: baseConfig(), probeResult: runtimeUnreachable });
    expect(r.status).toBe("ok");
  });

  it("executor_service_id='executor-service'", () => {
    const r = buildHealthResponse({ config: baseConfig(), probeResult: runtimeReachable });
    expect(r.executor_service_id).toBe("executor-service");
  });

  it("executor_service_version mirrors config", () => {
    const r = buildHealthResponse({ config: baseConfig({ executor_service_version: "1.2.3" }), probeResult: runtimeReachable });
    expect(r.executor_service_version).toBe("1.2.3");
  });

  it("executor_service_instance_id is a string (uuid-shaped)", () => {
    const r = buildHealthResponse({ config: baseConfig(), probeResult: runtimeReachable });
    expect(typeof r.executor_service_instance_id).toBe("string");
    expect(r.executor_service_instance_id.length).toBeGreaterThan(0);
  });

  it("deployment_mode mirrors config", () => {
    const r = buildHealthResponse({ config: baseConfig({ deployment_mode: "remote" }), probeResult: runtimeReachable });
    expect(r.deployment_mode).toBe("remote");
  });

  it("container_runtime + runtime_version mirror the probe", () => {
    const r = buildHealthResponse({ config: baseConfig(), probeResult: runtimeReachable });
    expect(r.container_runtime).toBe("docker");
    expect(r.runtime_version).toBe("29.5.0");
  });
});

// ── ready logic (load-bearing) ─────────────────────────────────────────────
describe("buildHealthResponse — ready flag", () => {
  it("ready=false when runtime is unreachable (regardless of validator config)", () => {
    const r = buildHealthResponse({
      config: baseConfig({ validator_image_ref: "r@sha256:" + "a".repeat(64), validator_image_digest: "sha256:" + "a".repeat(64) }),
      probeResult: runtimeUnreachable,
    });
    expect(r.ready).toBe(false);
  });

  it("ready=false when validator identity is missing (regardless of runtime)", () => {
    const r = buildHealthResponse({ config: baseConfig(), probeResult: runtimeReachable });
    expect(r.ready).toBe(false);
  });

  it("ready=false when both runtime AND validator identity are missing", () => {
    const r = buildHealthResponse({ config: baseConfig(), probeResult: runtimeUnreachable });
    expect(r.ready).toBe(false);
  });

  it("ready=true ONLY when runtime is reachable AND validator identity is complete", () => {
    const r = buildHealthResponse({
      config: baseConfig({ validator_image_ref: "r@sha256:" + "a".repeat(64), validator_image_digest: "sha256:" + "a".repeat(64) }),
      probeResult: runtimeReachable,
    });
    expect(r.ready).toBe(true);
  });

  it("ready=false when validator has ref but no digest (partial identity)", () => {
    const r = buildHealthResponse({
      config: baseConfig({ validator_image_ref: "r@sha256:" + "a".repeat(64), validator_image_digest: null }),
      probeResult: runtimeReachable,
    });
    expect(r.ready).toBe(false);
  });
});

// ── instance id stability within a process ─────────────────────────────────
describe("buildHealthResponse — instance id stability", () => {
  it("the instance id is stable across calls within one process", () => {
    const a = buildHealthResponse({ config: baseConfig(), probeResult: runtimeReachable });
    const b = buildHealthResponse({ config: baseConfig(), probeResult: runtimeReachable });
    expect(a.executor_service_instance_id).toBe(b.executor_service_instance_id);
  });
});
