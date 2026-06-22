// Tests for the executor-service runtime probe (v0.23.0 Task 2, step 3-4).
//
// The probe answers: "Is a container runtime reachable through the socket
// mounted into the executor service, and what is its identity?"
//
// Reachability is the load-bearing signal for /health.ready. The probe is
// structured so its command-runner is injectable — tests don't shell out for
// real (CI's unit-test container has no Docker). The injection seam is
// intentionally separate from the public probe function so production callers
// never see it.

import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import {
  probeRuntime,
  _setCommandRunnerForTests,
} from "../src/runtimeProbe.js";

// Helpers: fake command-runner outcomes.
function reachableDockerRunner() {
  // Returns (stdout) per-command. The probe issues `docker --version` then
  // `docker info --format ...`; we answer both.
  return (cmd) => {
    if (cmd[0] === "docker" && cmd[1] === "--version") {
      return { ok: true, stdout: "Docker version 29.5.0, build 98f1464" };
    }
    if (cmd[0] === "docker" && cmd[1] === "info") {
      return {
        ok: true,
        // Probe reads these via --format; we return them as a single
        // structured object the test-only runner can hand back.
        stdout: "docker\t29.5.0",
      };
    }
    return { ok: false, stdout: "" };
  };
}

function failingRunner() {
  return () => ({ ok: false, stdout: "" });
}

describe("probeRuntime — shape", () => {
  beforeEach(() => _setCommandRunnerForTests(reachableDockerRunner()));
  afterEach(() => _setCommandRunnerForTests(null));

  it("returns the documented shape", () => {
    const r = probeRuntime();
    expect(r).toHaveProperty("reachable");
    expect(r).toHaveProperty("container_runtime");
    expect(r).toHaveProperty("runtime_version");
    expect(typeof r.reachable).toBe("boolean");
  });
});

describe("probeRuntime — reachable docker", () => {
  beforeEach(() => _setCommandRunnerForTests(reachableDockerRunner()));
  afterEach(() => _setCommandRunnerForTests(null));

  it("reports reachable=true when docker --version succeeds", () => {
    expect(probeRuntime().reachable).toBe(true);
  });

  it("reports container_runtime='docker'", () => {
    expect(probeRuntime().container_runtime).toBe("docker");
  });

  it("parses runtime_version from the version string", () => {
    const v = probeRuntime().runtime_version;
    expect(v).toBe("29.5.0");
  });
});

describe("probeRuntime — unreachable", () => {
  beforeEach(() => _setCommandRunnerForTests(failingRunner()));
  afterEach(() => _setCommandRunnerForTests(null));

  it("reports reachable=false when docker --version fails", () => {
    expect(probeRuntime().reachable).toBe(false);
  });

  it("reports container_runtime=null when unreachable", () => {
    expect(probeRuntime().container_runtime).toBeNull();
  });

  it("reports runtime_version=null when unreachable", () => {
    expect(probeRuntime().runtime_version).toBeNull();
  });
});

describe("probeRuntime — malformed version output", () => {
  afterEach(() => _setCommandRunnerForTests(null));

  it("returns reachable=true but version='unknown' if version string has no semver", () => {
    _setCommandRunnerForTests(() => ({
      ok: true,
      stdout: "Docker version some-weird-build",
    }));
    const r = probeRuntime();
    expect(r.reachable).toBe(true);
    expect(r.container_runtime).toBe("docker");
    expect(r.runtime_version).toBe("unknown");
  });
});

describe("probeRuntime — seam safety", () => {
  it("_setCommandRunnerForTests(null) restores real (child_process) behaviour", () => {
    // We can't assert what the real result is (sandbox-dependent), only that
    // null doesn't throw and the function still returns the documented shape.
    _setCommandRunnerForTests(null);
    const r = probeRuntime();
    expect(r).toHaveProperty("reachable");
    expect(typeof r.reachable).toBe("boolean");
  });
});
