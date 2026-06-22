// Tests for backend_id-level reachability (v0.23.0 Task 3, step 7).
//
// The rev 3 design amendment: pass-capability derivation MUST be keyed by
// backend_id, not kind. The current sandboxRunner.js:297-302 derives
// reachableKinds and checks reachableKinds.has(executorKind) — safe only
// because exactly one backend (docker-executor) maps to container-runtime.
// Once executor-service is registered alongside it, that check would pass
// when EITHER backend was reachable even if the SELECTED one was down.
//
// This helper is the load-bearing groundwork: a pure function the runner
// uses to derive backend_id-level reachability, decoupled from the
// kind-keyed /health summary.

import { describe, it, expect } from "@jest/globals";
import { deriveBackendReachability } from "../../src/lib/executorReachability.js";

const KIND_RT = "container-runtime";
const KIND_LP = "local-process";

describe("deriveBackendReachability — selected backend reachable", () => {
  it("returns backend_reachable=true when the selected backend id is reachable", () => {
    const r = deriveBackendReachability({
      selectedBackendId: "executor-service",
      backendKinds: { "executor-service": KIND_RT, "docker-executor": KIND_RT, "node-executor": KIND_LP },
      probes: {
        "executor-service": { reachable: true },
        "docker-executor": { reachable: false },
        "node-executor": { reachable: true },
      },
    });
    expect(r.backend_reachable).toBe(true);
    expect(r.backend_id).toBe("executor-service");
    expect(r.kind).toBe(KIND_RT);
  });
});

describe("deriveBackendReachability — selected backend UNREACHABLE, sibling kind reachable", () => {
  // THE CORE CASE: the kind is reachable (docker-executor works) but the
  // SELECTED backend (executor-service) is down. The old kind-keyed logic
  // would return reachable=true here — a false positive that could let a
  // pass-capable receipt be built against an unreachable backend.
  it("returns backend_reachable=false when only a sibling of the same kind is reachable", () => {
    const r = deriveBackendReachability({
      selectedBackendId: "executor-service",
      backendKinds: { "executor-service": KIND_RT, "docker-executor": KIND_RT, "node-executor": KIND_LP },
      probes: {
        "executor-service": { reachable: false },
        "docker-executor": { reachable: true },  // sibling same-kind, reachable
        "node-executor": { reachable: true },
      },
    });
    expect(r.backend_reachable).toBe(false);
    expect(r.backend_id).toBe("executor-service");
  });
});

describe("deriveBackendReachability — docker-executor selected, executor-service up", () => {
  // Symmetric case: the docker-executor is selected but executor-service (the
  // sibling) is the reachable one. backend_reachable must reflect the
  // SELECTED backend, not the sibling.
  it("returns backend_reachable=false when docker-executor selected + executor-service up", () => {
    const r = deriveBackendReachability({
      selectedBackendId: "docker-executor",
      backendKinds: { "executor-service": KIND_RT, "docker-executor": KIND_RT, "node-executor": KIND_LP },
      probes: {
        "executor-service": { reachable: true },
        "docker-executor": { reachable: false },
        "node-executor": { reachable: true },
      },
    });
    expect(r.backend_reachable).toBe(false);
  });
});

describe("deriveBackendReachability — local-process", () => {
  it("always reachable for local-process (preserves existing semantics)", () => {
    const r = deriveBackendReachability({
      selectedBackendId: "node-executor",
      backendKinds: { "node-executor": KIND_LP },
      probes: { "node-executor": { reachable: true } },
    });
    expect(r.backend_reachable).toBe(true);
    expect(r.kind).toBe(KIND_LP);
  });
});

describe("deriveBackendReachability — robustness", () => {
  it("returns backend_reachable=false when selected backend id has no probe entry", () => {
    const r = deriveBackendReachability({
      selectedBackendId: "executor-service",
      backendKinds: { "executor-service": KIND_RT },
      probes: {}, // no probe for the selected backend
    });
    expect(r.backend_reachable).toBe(false);
  });

  it("throws on unknown selectedBackendId (fail-closed)", () => {
    expect(() =>
      deriveBackendReachability({
        selectedBackendId: "made-up",
        backendKinds: { "executor-service": KIND_RT },
        probes: {},
      })
    ).toThrow(/unknown backend id/);
  });

  it("returns the documented shape: { backend_reachable, backend_id, kind }", () => {
    const r = deriveBackendReachability({
      selectedBackendId: "executor-service",
      backendKinds: { "executor-service": KIND_RT },
      probes: { "executor-service": { reachable: true } },
    });
    expect(r).toHaveProperty("backend_reachable");
    expect(r).toHaveProperty("backend_id");
    expect(r).toHaveProperty("kind");
    expect(typeof r.backend_reachable).toBe("boolean");
  });
});
