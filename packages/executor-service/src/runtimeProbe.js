// packages/executor-service/src/runtimeProbe.js
// Container-runtime reachability probe (v0.23.0 Task 2, step 4).
//
// Answers: "Is a container runtime reachable through the socket mounted into
// the executor service, and what is its identity?" Reachability is the load-
// bearing signal for /health.ready.
//
// Default implementation shells out to `docker --version` + `docker info`.
// A test-only seam (_setCommandRunnerForTests) lets tests inject a fake
// runner instead of depending on Docker being installed in the test
// container. Production code leaves the seam null → uses spawnSync.

import { spawnSync } from "node:child_process";

const VERSION_TIMEOUT_MS = 5000;

// Test-injectable command runner. Default null → real spawnSync.
// Signature: (cmd: string[]) => { ok: boolean, stdout: string }
let _cmdRunner = null;

/**
 * Test-only seam: inject a fake command runner.
 * Pass null to restore real child_process behaviour.
 *
 * @param {((cmd: string[]) => { ok: boolean, stdout: string }) | null} runner
 */
export function _setCommandRunnerForTests(runner) {
  _cmdRunner = runner;
}

function runCmd(cmd) {
  if (_cmdRunner) return _cmdRunner(cmd);
  try {
    const r = spawnSync(cmd[0], cmd.slice(1), {
      encoding: "utf-8",
      timeout: VERSION_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (r.error || r.status !== 0) return { ok: false, stdout: "" };
    return { ok: true, stdout: r.stdout || "" };
  } catch {
    return { ok: false, stdout: "" };
  }
}

// Parse the first semver-looking token out of a version string.
// "Docker version 29.5.0, build 98f1464" → "29.5.0"
// Returns "unknown" if no x.y.z token is present.
function parseSemver(s) {
  const m = (s || "").match(/(\d+\.\d+\.\d+)/);
  return m ? m[1] : "unknown";
}

/**
 * Probe whether a container runtime (Docker first, Podman fallback) is
 * reachable from this process and return its identity.
 *
 * Order: docker → podman. First one that answers `--version` wins. The
 * CT-115 v0.23.0 deployment mounts the CT-local Docker socket, so Docker is
 * expected in production; Podman is a fallback for other deployments.
 *
 * @returns {{ reachable: boolean, container_runtime: string|null, runtime_version: string|null }}
 */
export function probeRuntime() {
  for (const runtime of ["docker", "podman"]) {
    const v = runCmd([runtime, "--version"]);
    if (v.ok && v.stdout) {
      return {
        reachable: true,
        container_runtime: runtime,
        runtime_version: parseSemver(v.stdout),
      };
    }
  }
  return { reachable: false, container_runtime: null, runtime_version: null };
}
