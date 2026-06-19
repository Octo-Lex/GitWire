// src/lib/isolationProbes.js
// Isolation probe suite for executor backend verification.
//
// Each probe runs inside the same container configuration (image, mounts,
// network, rootfs, user, limits) to verify that the declared isolation
// properties are actually enforced by the runtime.
//
// Probes produce a durable evidence object:
//   { probe_name, expected_result, observed_exit_status, observed_summary,
//     output_hash, passed: boolean }
//
// The probe suite is run by the backend evidence collector. All required
// probes must pass for the backend to become pass-capable (in a future PR).

import crypto from "crypto";
import { spawn } from "child_process";
import { logger } from "./logger.js";
import { validateDigestPinned } from "./imageReference.js";

/**
 * Definition of each isolation probe.
 *
 * @typedef {object} ProbeDefinition
 * @property {string} name - probe identifier
 * @property {string} description - what the probe checks
 * @property {string} expectedResult - human-readable expected outcome
 * @property {string[]} argv - command to run inside container
 * @property {function(number): boolean} checkPass - returns true if exit code indicates the expected outcome
 */

/**
 * All required isolation probes.
 *
 * Each probe is designed so that the EXPECTED isolation property causes
 * the command to behave a specific way:
 *
 * - network_disabled: outbound connection should FAIL (exit non-zero)
 * - no_github_token: GITHUB_TOKEN should be unset (grep returns non-zero)
 * - no_ssh_agent: SSH_AUTH_SOCK should be unset (grep returns non-zero)
 * - non_root_uid: id -u should NOT return 0 (exit 0, output != "0")
 * - read_only_rootfs: write to /etc/ should FAIL (exit non-zero)
 * - workspace_writable: write to /workspace/ should SUCCEED (exit zero)
 * - pid_limit: fork bomb should be bounded (fails or times out)
 * - memory_limit: memory exhaustion should FAIL (exit non-zero/137)
 * - wall_clock_limit: infinite loop should be killed (exit non-zero)
 * - no_docker_socket: /var/run/docker.sock should not exist
 */
export const REQUIRED_PROBES = [
  {
    name: "network_disabled",
    description: "Outbound network connection should fail",
    expectedResult: "connection refused or timeout (non-zero exit)",
    argv: ["sh", "-c", "curl -sf --connect-timeout 2 http://1.2.3.4/ 2>&1; exit $?"],
    checkPass: (code) => code !== 0,
  },
  {
    name: "no_github_token",
    description: "GITHUB_TOKEN environment variable should be absent",
    expectedResult: "GITHUB_TOKEN not found (non-zero exit)",
    argv: ["sh", "-c", "test -z \"${GITHUB_TOKEN}\""],
    checkPass: (code) => code === 0,
  },
  {
    name: "no_ssh_agent",
    description: "SSH_AUTH_SOCK environment variable should be absent",
    expectedResult: "SSH_AUTH_SOCK not found (zero exit from test)",
    argv: ["sh", "-c", "test -z \"${SSH_AUTH_SOCK}\""],
    checkPass: (code) => code === 0,
  },
  {
    name: "non_root_uid",
    description: "Process should not run as root (uid != 0)",
    expectedResult: "id -u returns non-zero value",
    argv: ["sh", "-c", "[ \"$(id -u)\" != \"0\" ]"],
    checkPass: (code) => code === 0,
  },
  {
    name: "read_only_rootfs",
    description: "Write outside /workspace should fail",
    expectedResult: "write to /etc/test fails (non-zero exit)",
    argv: ["sh", "-c", "echo test > /etc/gitwire-probe 2>&1; exit $?"],
    checkPass: (code) => code !== 0,
  },
  {
    name: "workspace_writable",
    description: "Write inside /workspace should succeed",
    expectedResult: "write to /workspace/.probe succeeds (zero exit)",
    argv: ["sh", "-c", "echo ok > /workspace/.probe 2>&1"],
    checkPass: (code) => code === 0,
  },
  {
    name: "pid_limit",
    description: "Process flood should be bounded (fails or killed)",
    expectedResult: "fork bomb is bounded (non-zero exit or timeout)",
    argv: ["sh", "-c", "for i in $(seq 1 1000); do sleep 60 & done 2>&1; exit $?"],
    checkPass: (code) => code !== 0,
  },
  {
    name: "memory_limit",
    description: "Memory exhaustion should fail boundedly",
    expectedResult: "OOM kill or allocation failure (non-zero exit)",
    argv: ["node", "-e", "const a=[];while(true)a.push(Buffer.alloc(1048576))"],
    checkPass: (code) => code !== 0,
  },
  {
    name: "wall_clock_limit",
    description: "Infinite loop should be killed by timeout",
    expectedResult: "process killed by timeout (non-zero exit)",
    argv: ["node", "-e", "while(true){}"],
    checkPass: (code) => code !== 0,
  },
  {
    name: "no_docker_socket",
    description: "Docker socket should not be accessible",
    expectedResult: "/var/run/docker.sock does not exist (non-zero exit)",
    argv: ["sh", "-c", "test ! -e /var/run/docker.sock"],
    checkPass: (code) => code === 0,
  },
];

/**
 * Get the list of required probe names.
 * @returns {string[]}
 */
export function getRequiredProbeNames() {
  return REQUIRED_PROBES.map((p) => p.name);
}

/**
 * Validate that a set of probe results includes all required probes.
 *
 * @param {Array<object>} probeResults
 * @returns {{ valid: boolean, missing: string[] }}
 */
export function validateProbeCompleteness(probeResults) {
  const required = getRequiredProbeNames();
  const present = new Set(probeResults.map((r) => r.probe_name));

  const missing = required.filter((name) => !present.has(name));

  return {
    valid: missing.length === 0,
    missing,
  };
}

/**
 * Validate that all probe results passed.
 *
 * @param {Array<object>} probeResults
 * @returns {{ valid: boolean, failures: string[] }}
 */
export function validateProbeResults(probeResults) {
  const failures = probeResults
    .filter((r) => !r.passed)
    .map((r) => `${r.probe_name}: ${r.observed_summary || "no summary"}`);

  return {
    valid: failures.length === 0,
    failures,
  };
}

/**
 * Compute the content-addressed hash of a probe suite result set.
 * Probes are sorted by name before hashing for canonical ordering.
 *
 * @param {Array<object>} probeResults
 * @returns {string} sha256:<hex64>
 */
export function computeProbeSuiteHash(probeResults) {
  const sorted = [...probeResults].sort((a, b) =>
    a.probe_name.localeCompare(b.probe_name)
  );

  // Hash only the binding fields (name, expected, observed, passed)
  const canonical = JSON.stringify(
    sorted.map((r) => ({
      probe_name: r.probe_name,
      expected_result: r.expected_result,
      observed_exit_status: r.observed_exit_status,
      observed_summary: r.observed_summary,
      output_hash: r.output_hash,
      passed: r.passed,
    }))
  );

  return "sha256:" + crypto.createHash("sha256").update(canonical).digest("hex");
}

/**
 * Build a probe result object from raw execution output.
 *
 * @param {object} probe - ProbeDefinition
 * @param {number} exitStatus - observed exit code
 * @param {string} summary - redacted output summary
 * @returns {object} probe result
 */
export function buildProbeResult(probe, exitStatus, summary) {
  const outputHash = "sha256:" + crypto.createHash("sha256").update(summary || "", "utf-8").digest("hex");
  const passed = probe.checkPass(exitStatus);

  return {
    probe_name: probe.name,
    description: probe.description,
    expected_result: probe.expectedResult,
    observed_exit_status: exitStatus,
    observed_summary: summary ? summary.substring(0, 500) : "",
    output_hash: outputHash,
    passed,
  };
}

/**
 * Run a single probe inside a container using the specified runtime and isolation config.
 *
 * @param {object} params
 * @param {string} params.runtime - "docker" or "podman"
 * @param {string} params.imageRef - immutable image reference (digest-pinned)
 * @param {object} params.limits - resource limits
 * @param {number} params.uid - non-root UID
 * @param {number} params.gid - non-root GID
 * @param {string} params.workspace - host workspace path
 * @returns {Promise<object>} probe execution result
 */
export async function runProbeInContainer({ runtime, imageRef, limits, uid, gid, workspace, probe }) {
  return new Promise((resolve) => {
    validateDigestPinned(imageRef);

    const containerArgs = [
      "run", "--rm",
      "--network=none",
      "--read-only",
      `--user=${uid}:${gid}`,
      `--cpus=${(limits.cpu_shares || 512) / 512}`,
      `--memory=${limits.memory_mb || 512}m`,
      `--pids-limit=${limits.pids_limit || 64}`,
      `--tmpfs=/tmp:rw,size=${Math.floor((limits.output_bytes || 1048576) / 1024)}k`,
      "--workdir=/workspace",
      `--volume=${workspace}:/workspace:rw`,
      // Pass the FULL digest-pinned reference so the runtime resolves
      // the exact immutable image, not a mutable tag or name.
      imageRef,
      ...probe.argv,
    ];

    const env = {
      PATH: "/usr/local/bin:/usr/bin:/bin",
      HOME: "/workspace",
      LANG: "en_US.UTF-8",
      NODE_ENV: "production",
    };

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const startTime = Date.now();

    const child = spawn(runtime, containerArgs, {
      cwd: workspace,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: false,
    });

    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill("SIGKILL"); } catch (_e) {}
    }, limits.wall_clock_ms || 10000);

    child.stdout?.on("data", (data) => { stdout += data.toString("utf-8").substring(0, 500); });
    child.stderr?.on("data", (data) => { stderr += data.toString("utf-8").substring(0, 500); });

    child.on("close", (code) => {
      clearTimeout(timer);
      const durationMs = Date.now() - startTime;
      const exitStatus = timedOut ? 137 : code;
      const summary = (stdout + "\n" + stderr).trim();

      resolve({
        exit_status: exitStatus,
        summary,
        duration_ms: durationMs,
        timed_out: timedOut,
      });
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({
        exit_status: 1,
        summary: `spawn error: ${err.message}`,
        duration_ms: Date.now() - startTime,
        timed_out: false,
      });
    });
  });
}
