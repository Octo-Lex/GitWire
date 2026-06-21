// Tests that getDefaultBackend() is reachability-honest for AUTO-selection
// while preserving EXPLICIT configured selection (Gap 1 fix #4).
//
// Deterministic: uses the test-only _setContainerRuntimeProbeForTests() seam
// to control reachability without depending on the sandbox's actual Docker.
//
// Regression focus (per Task 7.5 spec):
//   - no configured backend + Docker reachable    → docker-executor
//   - no configured backend + Docker unreachable  → node-executor
//   - configured node-executor                    → node-executor
//   - configured docker-executor                  → docker-executor (even if unreachable)
//   - unknown configured backend                  → fail-safe fallback

import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import {
  getDefaultBackend,
  getBackend,
  _setContainerRuntimeProbeForTests,
} from "../../src/lib/executorRegistry.js";

describe("getDefaultBackend — auto-selection is reachability-aware", () => {
  beforeEach(() => {
    delete process.env.GITWIRE_EXECUTOR_BACKEND;
  });
  afterEach(() => {
    delete process.env.GITWIRE_EXECUTOR_BACKEND;
    _setContainerRuntimeProbeForTests(null); // restore real probe
  });

  it("no configured backend + Docker reachable → docker-executor", () => {
    _setContainerRuntimeProbeForTests(() => ({ reachable: true, runtime: "docker" }));
    expect(getDefaultBackend().id).toBe("docker-executor");
  });

  it("no configured backend + Docker unreachable → node-executor", () => {
    _setContainerRuntimeProbeForTests(() => ({ reachable: false, runtime: null }));
    expect(getDefaultBackend().id).toBe("node-executor");
  });
});

describe("getDefaultBackend — explicit configured selection is honored", () => {
  beforeEach(() => {
    delete process.env.GITWIRE_EXECUTOR_BACKEND;
  });
  afterEach(() => {
    delete process.env.GITWIRE_EXECUTOR_BACKEND;
    _setContainerRuntimeProbeForTests(null);
  });

  it("configured node-executor → node-executor", () => {
    process.env.GITWIRE_EXECUTOR_BACKEND = "node-executor";
    _setContainerRuntimeProbeForTests(() => ({ reachable: true, runtime: "docker" }));
    expect(getDefaultBackend().id).toBe("node-executor");
  });

  it("configured docker-executor → docker-executor, even if reachability fails closed", () => {
    // Explicit selection means explicit selection. The runner's pass-capability
    // logic (Task 7) safely downgrades the receipt; selection itself is NOT
    // reachability-aware when the operator named a backend explicitly.
    process.env.GITWIRE_EXECUTOR_BACKEND = "docker-executor";
    _setContainerRuntimeProbeForTests(() => ({ reachable: false, runtime: null }));
    expect(getDefaultBackend().id).toBe("docker-executor");
  });

  it("configured docker-executor → docker-executor when Docker IS reachable too", () => {
    process.env.GITWIRE_EXECUTOR_BACKEND = "docker-executor";
    _setContainerRuntimeProbeForTests(() => ({ reachable: true, runtime: "docker" }));
    expect(getDefaultBackend().id).toBe("docker-executor");
  });
});

describe("getDefaultBackend — unknown configured backend is fail-safe", () => {
  beforeEach(() => {
    delete process.env.GITWIRE_EXECUTOR_BACKEND;
  });
  afterEach(() => {
    delete process.env.GITWIRE_EXECUTOR_BACKEND;
    _setContainerRuntimeProbeForTests(null);
  });

  it("unknown configured backend falls back to reachability-aware auto-selection", () => {
    // An unknown id is not in the registry. Selection must NOT throw and must
    // fall back to the auto-selection path (reachability-aware).
    process.env.GITWIRE_EXECUTOR_BACKEND = "nonexistent-backend";
    _setContainerRuntimeProbeForTests(() => ({ reachable: false, runtime: null }));
    expect(getDefaultBackend().id).toBe("node-executor");
  });

  it("unknown configured backend + Docker reachable → docker-executor via auto-fallback", () => {
    process.env.GITWIRE_EXECUTOR_BACKEND = "nonexistent-backend";
    _setContainerRuntimeProbeForTests(() => ({ reachable: true, runtime: "docker" }));
    expect(getDefaultBackend().id).toBe("docker-executor");
  });
});

describe("getBackend — explicit selection unchanged", () => {
  it("getBackend('docker-executor') still works for explicit selection", () => {
    // Explicit getBackend(id) is the direct-lookup path; reachability honesty
    // applies to DEFAULT selection only. This contract is unchanged.
    expect(getBackend("docker-executor").id).toBe("docker-executor");
  });

  it("getBackend('node-executor') still works", () => {
    expect(getBackend("node-executor").id).toBe("node-executor");
  });

  it("getBackend(unknown) throws (fail-closed direct lookup)", () => {
    expect(() => getBackend("made-up")).toThrow();
  });
});
