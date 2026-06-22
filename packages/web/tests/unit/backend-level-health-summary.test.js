// Tests for the async backend-level reachability summary (v0.23.0 Task 4).
//
// getBackendLevelSummary() is the ASYNC companion to the sync
// getReachabilitySummary(). It preserves the kind-keyed summary for dashboards
// (operators reading /health.executor.summary still see the same shape) but
// adds the rev 3 amendment fields:
//   - selected_backend_id       (which backend was selected)
//   - selected_backend_reachable (whether THAT backend — not just its kind —
//                                 is reachable; load-bearing for proof)
//
// The sync getReachabilitySummary() is UNCHANGED (callers that don't need
// backend-level proof keep their sync paths). deploymentInfo.js (which is
// already async) calls getBackendLevelSummary() instead.

import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import {
  getBackendLevelSummary,
  _setExecutorServiceClientForTests,
} from "../../src/lib/executorReachability.js";

describe("getBackendLevelSummary — shape extends the sync summary", () => {
  beforeEach(() => {
    // No executor-service URL configured → probe returns unreachable cleanly.
    delete process.env.GITWIRE_EXECUTOR_SERVICE_URL;
    delete process.env.GITWIRE_EXECUTOR_SERVICE_TOKEN;
    _setExecutorServiceClientForTests(null);
  });
  afterEach(() => _setExecutorServiceClientForTests(null));

  it("returns the same top-level fields as the sync summary (dashboards don't break)", async () => {
    const r = await getBackendLevelSummary();
    expect(r).toHaveProperty("summary");
    expect(r).toHaveProperty("selected_kind");
    expect(r).toHaveProperty("selected_reason");
    expect(r).toHaveProperty("selected_pass_capable");
  });

  it("adds selected_backend_id + selected_backend_reachable (rev 3 amendment)", async () => {
    const r = await getBackendLevelSummary();
    expect(r).toHaveProperty("selected_backend_id");
    expect(r).toHaveProperty("selected_backend_reachable");
    expect(typeof r.selected_backend_reachable).toBe("boolean");
  });
});

describe("getBackendLevelSummary — executor-service not configured", () => {
  beforeEach(() => {
    delete process.env.GITWIRE_EXECUTOR_SERVICE_URL;
    delete process.env.GITWIRE_EXECUTOR_SERVICE_TOKEN;
    _setExecutorServiceClientForTests(null);
  });
  afterEach(() => _setExecutorServiceClientForTests(null));

  it("reports selected_backend_id reflecting the sync selection (docker or node)", async () => {
    const r = await getBackendLevelSummary();
    // Without GITWIRE_EXECUTOR_SERVICE_URL, probeExecutorService returns
    // unreachable; selection falls back to the sync path. selected_backend_id
    // must be a real registered backend, not null/undefined.
    expect(["node-executor", "docker-executor"]).toContain(r.selected_backend_id);
  });

  it("reports selected_backend_reachable for the actually-selected backend", async () => {
    const r = await getBackendLevelSummary();
    // node-executor is always reachable; docker-executor depends on the host.
    // Either way, selected_backend_reachable must reflect the SELECTED backend.
    if (r.selected_backend_id === "node-executor") {
      expect(r.selected_backend_reachable).toBe(true);
    }
  });
});

describe("getBackendLevelSummary — executor-service configured + reachable", () => {
  beforeEach(() => {
    process.env.GITWIRE_EXECUTOR_SERVICE_URL = "http://executor:3003";
    process.env.GITWIRE_EXECUTOR_SERVICE_TOKEN = "t";
    // Inject a fake client that returns ready:true (reachable).
    _setExecutorServiceClientForTests(async () => ({
      reachable: true,
      ready: true,
      container_runtime: "docker",
      runtime_version: "29.5.0",
      executor_service_id: "executor-service",
      executor_service_version: "1.0.0",
    }));
  });
  afterEach(() => {
    delete process.env.GITWIRE_EXECUTOR_SERVICE_URL;
    delete process.env.GITWIRE_EXECUTOR_SERVICE_TOKEN;
    _setExecutorServiceClientForTests(null);
  });

  it("prefers executor-service when configured + reachable + selected", async () => {
    // Force selection to executor-service via the executor-backend env.
    process.env.GITWIRE_EXECUTOR_BACKEND = "executor-service";
    try {
      const r = await getBackendLevelSummary();
      // selected_backend_id must reflect the explicitly-selected backend.
      expect(r.selected_backend_id).toBe("executor-service");
      // And its reachability must come from the async probe (ready:true).
      expect(r.selected_backend_reachable).toBe(true);
    } finally {
      delete process.env.GITWIRE_EXECUTOR_BACKEND;
    }
  });
});

// THE LOAD-BEARING TEST: the sibling-backend same-kind false-positive case
// at the /health level. executor-service is the SELECTED backend but DOWN;
// docker-executor (same kind: container-runtime) is UP. The kind-keyed
// summary will say container-runtime is reachable, but selected_backend_reachable
// must be FALSE because the SELECTED backend (executor-service) is down.
describe("getBackendLevelSummary — sibling same-kind false-positive (rev 3 amendment)", () => {
  beforeEach(() => {
    process.env.GITWIRE_EXECUTOR_SERVICE_URL = "http://executor:3003";
    process.env.GITWIRE_EXECUTOR_SERVICE_TOKEN = "t";
    process.env.GITWIRE_EXECUTOR_BACKEND = "executor-service";
    // Inject a client that returns ready:false → reachable:false.
    // (Simulates: service is down OR not ready; either way, unreachable for proof.)
    _setExecutorServiceClientForTests(async () => ({
      reachable: false,
      ready: false,
      detail: "service not ready",
    }));
  });
  afterEach(() => {
    delete process.env.GITWIRE_EXECUTOR_SERVICE_URL;
    delete process.env.GITWIRE_EXECUTOR_SERVICE_TOKEN;
    delete process.env.GITWIRE_EXECUTOR_BACKEND;
    _setExecutorServiceClientForTests(null);
  });

  it("selected_backend_reachable=false when selected executor-service is down even if docker (sibling) is up", async () => {
    const r = await getBackendLevelSummary();
    expect(r.selected_backend_id).toBe("executor-service");
    // This is the whole point of the rev 3 amendment. The kind-keyed summary
    // might show container-runtime as reachable (because docker-executor is
    // reachable on this host), but the SELECTED backend is executor-service
    // which is down → selected_backend_reachable must be false.
    expect(r.selected_backend_reachable).toBe(false);
  });
});
