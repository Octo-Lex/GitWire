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
//
// The probe now issues TWO commands per runtime:
//   1. `docker --version`   — client identity (proves the binary exists)
//   2. `docker info`        — daemon reachability (proves the socket works)
// reachable=true requires BOTH. These helpers let each test fixture answer
// each command independently so we can model client-only, daemon-denied, etc.

function reachableDockerRunner() {
  // Both --version AND info succeed → daemon is reachable.
  return (cmd) => {
    if (cmd[0] === "docker" && cmd[1] === "--version") {
      return { ok: true, stdout: "Docker version 29.5.0, build 98f1464" };
    }
    if (cmd[0] === "docker" && cmd[1] === "info") {
      // `docker info` exits 0 when the daemon is reachable. We don't parse
      // its output (the probe only cares that the command succeeded).
      return { ok: true, stdout: "Server:\n Containers: 1\n Server Version: 29.5.0\n" };
    }
    return { ok: false, stdout: "" };
  };
}

// Client-only: `docker --version` works (binary is installed) but `docker info`
// fails (no socket mounted, daemon down, or permission denied). This is the
// core P1 #2 case — the old probe would falsely report reachable=true here.
function clientOnlyRunner() {
  return (cmd) => {
    if (cmd[0] === "docker" && cmd[1] === "--version") {
      return { ok: true, stdout: "Docker version 29.5.0, build 98f1464" };
    }
    // `docker info` fails — daemon unreachable.
    return { ok: false, stdout: "" };
  };
}

// Daemon-denied: client works, daemon command fails specifically with a
// permission-denied-shaped error (modelled here as ok:false, which is what
// spawnSync returns on non-zero exit). Same outcome as client-only from the
// probe's perspective: reachable=false.
function daemonDeniedRunner() {
  return (cmd) => {
    if (cmd[0] === "docker" && cmd[1] === "--version") {
      return { ok: true, stdout: "Docker version 29.5.0, build 98f1464" };
    }
    // permission denied on the socket
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

// P1 #2 lock-in: client binary exists BUT daemon is unreachable. The probe
// must NOT report reachable=true just because `docker --version` succeeds.
// `docker info` (daemon-touching) must also succeed.
describe("probeRuntime — client-only (daemon unreachable)", () => {
  beforeEach(() => _setCommandRunnerForTests(clientOnlyRunner()));
  afterEach(() => _setCommandRunnerForTests(null));

  it("reports reachable=false when client exists but daemon is unreachable", () => {
    // This is the core P1 #2 fix: without a daemon-touching check, this would
    // falsely return reachable=true and /health.ready could flip to true
    // with no actual runtime behind it.
    expect(probeRuntime().reachable).toBe(false);
  });
});

describe("probeRuntime — daemon permission denied", () => {
  beforeEach(() => _setCommandRunnerForTests(daemonDeniedRunner()));
  afterEach(() => _setCommandRunnerForTests(null));

  it("reports reachable=false when daemon command fails (permission denied)", () => {
    // Models the case where the socket is mounted but the process uid lacks
    // permission to use it. Same outcome: reachable=false.
    expect(probeRuntime().reachable).toBe(false);
  });
});

describe("probeRuntime — client + daemon available", () => {
  beforeEach(() => _setCommandRunnerForTests(reachableDockerRunner()));
  afterEach(() => _setCommandRunnerForTests(null));

  it("reports reachable=true when BOTH client AND daemon respond", () => {
    expect(probeRuntime().reachable).toBe(true);
  });
});

describe("probeRuntime — malformed version output", () => {
  afterEach(() => _setCommandRunnerForTests(null));

  it("returns reachable=true but version='unknown' if version string has no semver", () => {
    // Stub must answer BOTH --version (client) and info (daemon) for the
    // two-step probe to reach reachable=true. The --version output is
    // deliberately malformed (no semver) to exercise the parser fallback.
    _setCommandRunnerForTests((cmd) => {
      if (cmd[0] === "docker" && cmd[1] === "--version") {
        return { ok: true, stdout: "Docker version some-weird-build" };
      }
      if (cmd[0] === "docker" && cmd[1] === "info") {
        return { ok: true, stdout: "Server Version: weird" };
      }
      return { ok: false, stdout: "" };
    });
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
