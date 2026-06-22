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
 * TWO-STEP probe per runtime (P1 #2 fix):
 *   1. `<runtime> --version`  — proves the client binary is installed.
 *   2. `<runtime> info`       — touches the daemon/socket. REQUIRED for
 *                               reachable=true. A bare --version only proves
 *                               the client exists, not that the mounted
 *                               socket works; reporting reachable=true on
 *                               client-only would let /health.ready lie.
 *
 * Order: docker → podman. First runtime where BOTH steps succeed wins.
 * If --version succeeds for docker but `info` fails, the probe does NOT fall
 * through to podman on the daemon check — the operator configured docker,
 * and a silent podman fallback would mask the docker-socket problem.
 *
 * @returns {{ reachable: boolean, container_runtime: string|null, runtime_version: string|null }}
 */
export function probeRuntime() {
  for (const runtime of ["docker", "podman"]) {
    // Step 1: client identity.
    const v = runCmd([runtime, "--version"]);
    if (!v.ok || !v.stdout) continue;

    // Step 2: daemon reachability. Without this, reachable=true would be
    // based on client presence alone — false confidence when the socket is
    // missing/unmounted/permission-denied.
    const info = runCmd([runtime, "info"]);
    if (!info.ok) {
      // Client installed but daemon unreachable. Return reachable=false but
      // surface which runtime we attempted, so operators can tell it's a
      // socket/permission issue rather than "no runtime installed."
      return {
        reachable: false,
        container_runtime: runtime,
        runtime_version: parseSemver(v.stdout),
      };
    }

    return {
      reachable: true,
      container_runtime: runtime,
      runtime_version: parseSemver(v.stdout),
    };
  }
  return { reachable: false, container_runtime: null, runtime_version: null };
}
