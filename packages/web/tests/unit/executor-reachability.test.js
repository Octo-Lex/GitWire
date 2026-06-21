// tests/unit/executor-reachability.test.js
// Tests for v0.21.0 executor reachability and selection layer.

import { describe, it, expect } from "@jest/globals";
import {
  EXECUTOR_KINDS,
  probeLocalProcess,
  probeDelegatedRun,
  probeAllBackends,
  getReachabilitySummary,
} from "../../src/lib/executorReachability.js";

describe("EXECUTOR_KINDS enum", () => {
  it("has stable typed values", () => {
    expect(EXECUTOR_KINDS.LOCAL_PROCESS).toBe("local-process");
    expect(EXECUTOR_KINDS.CONTAINER_RUNTIME).toBe("container-runtime");
    expect(EXECUTOR_KINDS.DELEGATED_RUN).toBe("delegated-run");
  });

  it("is frozen", () => {
    expect(Object.isFrozen(EXECUTOR_KINDS)).toBe(true);
  });
});

describe("probeLocalProcess", () => {
  it("is always reachable", () => {
    const result = probeLocalProcess();
    expect(result.reachable).toBe(true);
  });

  it("reports runtime as none (no isolation)", () => {
    const result = probeLocalProcess();
    expect(result.runtime).toBe("none");
  });

  it("includes Node.js version in detail", () => {
    const result = probeLocalProcess();
    expect(result.detail).toContain("Node.js");
    expect(result.detail).toContain(process.version);
  });
});

describe("probeDelegatedRun", () => {
  it("is unreachable in v0.21.0 (placeholder)", () => {
    const result = probeDelegatedRun();
    expect(result.reachable).toBe(false);
  });

  it("explains why it is unavailable", () => {
    const result = probeDelegatedRun();
    expect(result.detail).toContain("No delegated-run provider configured");
  });
});

describe("probeAllBackends", () => {
  it("probes all three backend kinds", () => {
    const { backends } = probeAllBackends();
    expect(backends).toHaveLength(3);
    const kinds = backends.map((b) => b.kind);
    expect(kinds).toContain(EXECUTOR_KINDS.CONTAINER_RUNTIME);
    expect(kinds).toContain(EXECUTOR_KINDS.LOCAL_PROCESS);
    expect(kinds).toContain(EXECUTOR_KINDS.DELEGATED_RUN);
  });

  it("always selects a reachable backend (never null)", () => {
    const { selected } = probeAllBackends();
    expect(selected).not.toBeNull();
    // Selected is either container-runtime (if Docker/Podman is available)
    // or local-process (always available fallback)
    expect([EXECUTOR_KINDS.CONTAINER_RUNTIME, EXECUTOR_KINDS.LOCAL_PROCESS]).toContain(selected.kind);
  });

  it("returns a typed selected_reason", () => {
    const { selected_reason } = probeAllBackends();
    expect(selected_reason).toContain("selected:");
  });

  it("respects priority order", () => {
    // Force local-process to highest priority
    const { selected } = probeAllBackends([
      EXECUTOR_KINDS.LOCAL_PROCESS,
      EXECUTOR_KINDS.CONTAINER_RUNTIME,
      EXECUTOR_KINDS.DELEGATED_RUN,
    ]);
    expect(selected.kind).toBe(EXECUTOR_KINDS.LOCAL_PROCESS);
  });

  it("each backend entry has probed_at timestamp", () => {
    const { backends } = probeAllBackends();
    for (const b of backends) {
      expect(b.probed_at).toBeDefined();
      expect(typeof b.probed_at).toBe("string");
    }
  });
});

describe("getReachabilitySummary", () => {
  it("returns compact summary without sensitive details", () => {
    const result = getReachabilitySummary();
    expect(result).toHaveProperty("summary");
    expect(result).toHaveProperty("selected_kind");
    expect(result).toHaveProperty("selected_reason");
    expect(Array.isArray(result.summary)).toBe(true);
  });

  it("summary entries have kind, reachable, runtime only", () => {
    const { summary } = getReachabilitySummary();
    for (const entry of summary) {
      expect(entry).toHaveProperty("kind");
      expect(entry).toHaveProperty("reachable");
      expect(entry).toHaveProperty("runtime");
      // Should NOT have detail or version (sensitive/internal)
      expect(entry).not.toHaveProperty("detail");
    }
  });

  it("selected_kind is local-process when container-runtime is unreachable", () => {
    // In the test environment, Docker is not available
    const { selected_kind, summary } = getReachabilitySummary();
    const containerEntry = summary.find((s) => s.kind === EXECUTOR_KINDS.CONTAINER_RUNTIME);
    if (containerEntry && !containerEntry.reachable) {
      expect(selected_kind).toBe(EXECUTOR_KINDS.LOCAL_PROCESS);
    }
  });
});
