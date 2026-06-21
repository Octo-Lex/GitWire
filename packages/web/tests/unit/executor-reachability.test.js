// tests/unit/executor-reachability.test.js
// Tests for v0.21.0 executor reachability and selection layer.

import { describe, it, expect, beforeEach } from "@jest/globals";
import {
  EXECUTOR_KINDS,
  probeLocalProcess,
  probeDelegatedRun,
  probeAllBackends,
  getReachabilitySummary,
  isBackendPassCapable,
  executorKindForBackendId,
  getValidatorReadiness,
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

describe("Backend pass-capability derivation", () => {
  it("local-process is never pass-capable", () => {
    expect(isBackendPassCapable(EXECUTOR_KINDS.LOCAL_PROCESS, true)).toBe(false);
    expect(isBackendPassCapable(EXECUTOR_KINDS.LOCAL_PROCESS, false)).toBe(false);
  });

  it("container-runtime is pass-capable only when reachable", () => {
    expect(isBackendPassCapable(EXECUTOR_KINDS.CONTAINER_RUNTIME, true)).toBe(true);
    expect(isBackendPassCapable(EXECUTOR_KINDS.CONTAINER_RUNTIME, false)).toBe(false);
  });

  it("delegated-run is pass-capable only when reachable", () => {
    expect(isBackendPassCapable(EXECUTOR_KINDS.DELEGATED_RUN, true)).toBe(true);
    expect(isBackendPassCapable(EXECUTOR_KINDS.DELEGATED_RUN, false)).toBe(false);
  });

  it("unknown kind throws (no silent default to pass)", () => {
    expect(() => isBackendPassCapable("gpu-cluster", true)).toThrow(/unknown executor kind/);
  });
});

describe("executorKindForBackendId", () => {
  it("maps node-executor → local-process", () => {
    expect(executorKindForBackendId("node-executor")).toBe(EXECUTOR_KINDS.LOCAL_PROCESS);
  });

  it("maps docker-executor → container-runtime", () => {
    expect(executorKindForBackendId("docker-executor")).toBe(EXECUTOR_KINDS.CONTAINER_RUNTIME);
  });

  it("throws on unknown backend id (fail-closed)", () => {
    expect(() => executorKindForBackendId("made-up")).toThrow(/unknown backend id/);
  });
});

describe("getReachabilitySummary — pass-capability extension", () => {
  it("summary entries include pass_capable", () => {
    const { summary } = getReachabilitySummary();
    for (const entry of summary) {
      expect(typeof entry.pass_capable).toBe("boolean");
    }
  });

  it("local-process summary entry is never pass_capable", () => {
    const { summary } = getReachabilitySummary();
    const lp = summary.find((s) => s.kind === EXECUTOR_KINDS.LOCAL_PROCESS);
    expect(lp.pass_capable).toBe(false);
  });

  it("returns selected_pass_capable boolean", () => {
    const result = getReachabilitySummary();
    expect(typeof result.selected_pass_capable).toBe("boolean");
  });

  it("selected_pass_capable is false when local-process is selected", () => {
    // In CI/test envs Docker is unavailable, so local-process is selected
    const { selected_kind, selected_pass_capable } = getReachabilitySummary();
    if (selected_kind === EXECUTOR_KINDS.LOCAL_PROCESS) {
      expect(selected_pass_capable).toBe(false);
    }
  });
});

describe("getValidatorReadiness", () => {
  // Ensure a clean validator-image env for these tests (Task 4 module reads it).
  beforeEach(() => {
    delete process.env.GITWIRE_VALIDATOR_IMAGE_REF;
    delete process.env.GITWIRE_VALIDATOR_IMAGE_DIGEST;
  });

  it("returns the doc-specified validator block shape", () => {
    const v = getValidatorReadiness();
    expect(v).toHaveProperty("configured");
    expect(v).toHaveProperty("pass_capable");
    expect(v).toHaveProperty("reason");
    expect(typeof v.pass_capable).toBe("boolean");
  });

  it("pass_capable is false when validator image is not configured", () => {
    // beforeEach clears the image env, so regardless of which backend the
    // live probe selects, identity is incomplete → never pass-capable.
    const v = getValidatorReadiness();
    expect(v.pass_capable).toBe(false);
  });

  it("reason is a typed string (not ambiguous)", () => {
    const v = getValidatorReadiness();
    expect(typeof v.reason).toBe("string");
    expect(v.reason.length).toBeGreaterThan(0);
    // Must be one of the typed reasons, never a bare empty string
    expect(v.reason).toMatch(
      /^(configured_and_pass_capable|selected_backend_not_pass_capable|validator_image_not_configured|no_reachable_backend)$/
    );
  });

  // FIX #2 lock-in: `configured` and `pass_capable` are INDEPENDENT.
  // `configured` must reflect whether the operator set the validator image
  // env vars, regardless of which backend the live probe happens to select.
  // This test is environment-independent (Docker may or may not be present).
  it("configured tracks the image env vars, independent of selected backend", () => {
    const REF = "registry.example.com/v@sha256:" + "a".repeat(64);
    const DIGEST = "sha256:" + "a".repeat(64);

    // Baseline: no image env → configured=false
    const before = getValidatorReadiness();
    expect(before.configured).toBe(false);

    // Set the image env → configured flips true, independent of pass_capable.
    // pass_capable follows whatever the selected backend + image identity say;
    // we assert on `reason` shape, not a specific selected backend.
    process.env.GITWIRE_VALIDATOR_IMAGE_REF = REF;
    process.env.GITWIRE_VALIDATOR_IMAGE_DIGEST = DIGEST;
    try {
      const after = getValidatorReadiness();
      expect(after.configured).toBe(true);
      // When the backend is not pass-capable, configured stays true — that is
      // the whole point of fix #2. When it IS pass-capable, reason flips to
      // configured_and_pass_capable. Both are valid; what must NOT happen is
      // configured=false while the image env is set.
      expect(["configured_and_pass_capable", "selected_backend_not_pass_capable"])
        .toContain(after.reason);
    } finally {
      delete process.env.GITWIRE_VALIDATOR_IMAGE_REF;
      delete process.env.GITWIRE_VALIDATOR_IMAGE_DIGEST;
    }
  });

  // Local-process-specific invariant: when local-process is the selected
  // backend (no Docker reachable), configuring the image yields
  // configured=true, pass_capable=false, reason=selected_backend_not_pass_capable.
  // Skipped automatically when container-runtime IS reachable, since the
  // invariant only applies to the local-process case.
  it("configured=true but not pass-capable when local-process is selected", () => {
    const { selected_kind } = getReachabilitySummary();
    if (selected_kind !== EXECUTOR_KINDS.LOCAL_PROCESS) return; // Docker present here

    const REF = "registry.example.com/v@sha256:" + "a".repeat(64);
    const DIGEST = "sha256:" + "a".repeat(64);
    process.env.GITWIRE_VALIDATOR_IMAGE_REF = REF;
    process.env.GITWIRE_VALIDATOR_IMAGE_DIGEST = DIGEST;
    try {
      const v = getValidatorReadiness();
      expect(v.configured).toBe(true);
      expect(v.pass_capable).toBe(false);
      expect(v.reason).toBe("selected_backend_not_pass_capable");
    } finally {
      delete process.env.GITWIRE_VALIDATOR_IMAGE_REF;
      delete process.env.GITWIRE_VALIDATOR_IMAGE_DIGEST;
    }
  });
});
