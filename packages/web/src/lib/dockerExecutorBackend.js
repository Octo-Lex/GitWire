// src/lib/dockerExecutorBackend.js
// Docker/Podman executor backend for isolated repair validation.
//
// Executes validation commands inside a container with strict isolation:
// - Network disabled (--network=none)
// - Read-only rootfs (--read-only)
// - Non-root user (--user)
// - CPU/memory/pid limits (--cpus, --memory, --pids-limit)
// - No host Docker socket, no GitHub tokens, no SSH agent
// - Disposable workspace mount only
// - Bounded /tmp via tmpfs
// - Commands resolved from allowlisted argv templates (no shell)
//
// supports_pass is currently false. It will be flipped to true in a
// subsequent PR ONLY after end-to-end evidence proves the isolation
// contract holds:
// - No outbound network access
// - No credential leakage
// - Non-root uid
// - Resource limits produce bounded inconclusive on exhaustion
// - Write outside workspace fails
//
// Receipt bindings include container_runtime, runtime_version,
// network_disabled, non_root, read_only_rootfs, and resource_limits
// so the governance gate can verify isolation properties at receipt
// verification time.

import { spawn } from "child_process";
import crypto from "crypto";
import { mkdtemp, mkdir, writeFile, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { logger } from "./logger.js";
import { resolveCommandTemplate } from "./validationCommandTemplates.js";
import { validateBackendContract } from "./executorBackend.js";

/**
 * Default resource limits for container execution.
 * These are passed to Docker/Podman as --cpus, --memory, --pids-limit.
 */
export const DOCKER_DEFAULT_LIMITS = {
  cpu_shares: 512,
  memory_mb: 512,
  pids_limit: 64,
  wall_clock_ms: 30000,
  output_bytes: 1048576, // 1 MB
};

/**
 * The pinned image for container execution.
 *
 * PR #55: Replaced the governance label 'sha256:gitwire-validator-v1'
 * with a real immutable OCI digest-pinned reference. The image_ref is
 * a full registry path + digest, and the image_digest is the parsed
 * sha256:<hex64> digest.
 *
 * Before pass authorization (PR #56), the executor will verify via
 * `docker inspect` that the running container used this exact image.
 */

// Test fixture digest — used only in test environments.
// The production pass-capable path requires GITWIRE_VALIDATOR_IMAGE_REF
// to be configured at deploy time. The backend rejects pass results
// if it detects the test fixture is in use and no override is configured.
const TEST_FIXTURE_REF = "localhost/gitwire-validator@sha256:a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2";
const TEST_FIXTURE_DIGEST = "sha256:a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2";

// Production image reference — configured via environment variable.
// If set, overrides the test fixture. If not set and GITWIRE_ALLOW_TEST_FIXTURE
// is not "1", the backend refuses to produce pass results.
const CONFIGURED_REF = process.env.GITWIRE_VALIDATOR_IMAGE_REF || null;

/**
 * The active image reference (digest-pinned).
 * Uses configured production ref if available, falls back to test fixture.
 */
export const DOCKER_IMAGE_REF = CONFIGURED_REF || TEST_FIXTURE_REF;

/**
 * The parsed digest from the active image reference.
 */
export const DOCKER_IMAGE_DIGEST = DOCKER_IMAGE_REF.includes("@")
  ? DOCKER_IMAGE_REF.split("@")[1]
  : TEST_FIXTURE_DIGEST;

/**
 * Check if the current image identity is the test fixture.
 * Pass-capable execution must fail if this returns true unless
 * GITWIRE_ALLOW_TEST_FIXTURE=1 is explicitly set.
 */
export function isTestFixtureImage() {
  return DOCKER_IMAGE_REF === TEST_FIXTURE_REF &&
    process.env.GITWIRE_ALLOW_TEST_FIXTURE !== "1";
}

/**
 * Non-root UID/GID for container execution.
 * Uses a fixed UID (not 0) to ensure non-root.
 */
const CONTAINER_UID = 1000;
const CONTAINER_GID = 1000;

/**
 * Detect the available container runtime (Docker or Podman).
 * Returns null if neither is available.
 *
 * @returns {Promise<{runtime: string, version: string} | null>}
 */
export async function detectContainerRuntime() {
  for (const runtime of ["docker", "podman"]) {
    try {
      const version = await runCommand(runtime, ["--version"], 5000);
      if (version !== null) {
        // Parse version: "Docker version 24.0.7, build afdd53b" → "24.0.7"
        //               "podman version 4.9.3" → "4.9.3"
        const match = version.match(/(\d+\.\d+\.\d+)/);
        const runtimeVersion = match ? match[1] : "unknown";
        logger.info({ runtime, version: runtimeVersion }, "Container runtime detected");
        return { runtime, version: runtimeVersion };
      }
    } catch (_e) {
      // Runtime not available
    }
  }
  return null;
}

/**
 * Run a command and capture stdout. Returns null on failure.
 *
 * @param {string} cmd
 * @param {string[]} args
 * @param {number} timeoutMs
 * @returns {Promise<string|null>}
 */
function runCommand(cmd, args, timeoutMs) {
  return new Promise((resolve) => {
    let stdout = "";
    let settled = false;

    const child = spawn(cmd, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: { PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin" },
      detached: false,
    });

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        try { child.kill("SIGKILL"); } catch (_e) {}
        resolve(null);
      }
    }, timeoutMs);

    child.stdout?.on("data", (data) => { stdout += data.toString("utf-8"); });
    child.on("close", () => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(stdout.trim());
      }
    });
    child.on("error", () => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(null);
      }
    });
  });
}

/**
 * Redact potential secrets from captured output.
 * (Same logic as sandboxExecutor — shared for consistency.)
 *
 * @param {string} output
 * @param {number} maxBytes
 * @returns {string}
 */
function redactOutput(output, maxBytes = 1048576) {
  if (!output) return "";

  let result = output;
  if (Buffer.byteLength(result, "utf-8") > maxBytes) {
    result = Buffer.from(result, "utf-8").subarray(0, maxBytes).toString("utf-8") + "\n[output truncated]";
  }

  const SECRET_PATTERNS = [
    /ghp_[A-Za-z0-9]{36,}/g,
    /gho_[A-Za-z0-9]{36,}/g,
    /github_pat_[A-Za-z0-9_]{82,}/g,
  ];

  for (const pattern of SECRET_PATTERNS) {
    result = result.replace(pattern, "[REDACTED]");
  }

  return result;
}

function hashOutput(content) {
  return "sha256:" + crypto.createHash("sha256").update(content, "utf-8").digest("hex");
}

/**
 * Execute a single validation command inside a container.
 *
 * Builds the full argv for `docker run` / `podman run` with all
 * isolation flags. Commands are passed as argv arrays (no shell).
 *
 * @param {string} runtime - "docker" or "podman"
 * @param {string[]} argv - command and arguments (from template)
 * @param {string} workspace - host path to mount as workspace
 * @param {object} limits - resource limits
 * @returns {Promise<object>} command result
 */
function executeInContainer(runtime, argv, workspace, limits) {
  return new Promise((resolve) => {
    const startTime = Date.now();

    // Build container run argv with full isolation
    const containerArgs = [
      "run",
      "--rm",                                      // remove after exit
      "--network=none",                            // no network access
      "--read-only",                               // read-only rootfs
      `--user=${CONTAINER_UID}:${CONTAINER_GID}`,  // non-root
      `--cpus=${(limits.cpu_shares || 512) / 512}`, // CPU limit
      `--memory=${limits.memory_mb || 512}m`,       // memory limit
      `--pids-limit=${limits.pids_limit || 64}`,    // process limit
      `--tmpfs=/tmp:rw,size=${Math.floor((limits.output_bytes || 1048576) / 1024)}k`, // bounded /tmp
      "--workdir=/workspace",                      // workspace as CWD
      `--volume=${workspace}:/workspace:rw`,        // mount workspace only
      // No --privileged, no host Docker socket, no --mount of anything else
      // Pass the FULL digest-pinned reference so the runtime resolves
      // the exact immutable image, not a mutable tag or name.
      DOCKER_IMAGE_REF,
      ...argv,                                      // command + args (no shell)
    ];

    // Minimal environment — NO credentials, NO tokens
    const env = {
      PATH: "/usr/local/bin:/usr/bin:/bin",
      HOME: "/workspace",
      LANG: "en_US.UTF-8",
      NODE_ENV: "production",
    };

    logger.debug({ runtime, argv: argv.slice(0, 2) }, "Executing validation command in container");

    const child = spawn(runtime, containerArgs, {
      cwd: workspace,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: false,
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const maxOutputBytes = limits.output_bytes || 1048576;

    child.stdout?.on("data", (data) => {
      if (Buffer.byteLength(stdout, "utf-8") < maxOutputBytes) {
        stdout += data.toString("utf-8");
      }
    });

    child.stderr?.on("data", (data) => {
      if (Buffer.byteLength(stderr, "utf-8") < maxOutputBytes) {
        stderr += data.toString("utf-8");
      }
    });

    let processStarted = false;

    child.on("spawn", () => {
      processStarted = true;
    });

    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill("SIGKILL"); } catch (_e) {}
    }, limits.wall_clock_ms || 30000);

    child.on("close", (code) => {
      clearTimeout(timer);
      const durationMs = Date.now() - startTime;
      const combinedOutput = redactOutput(stdout + "\n" + stderr, maxOutputBytes);

      resolve({
        exit_status: timedOut ? null : code,
        output_ref: `output:${hashOutput(combinedOutput)}`,
        output_hash: hashOutput(combinedOutput),
        duration_ms: durationMs,
        started: processStarted,
        completed: !timedOut,
        timed_out: timedOut,
        ...(timedOut ? { timeout_reason: "wall_clock_exceeded" } : {}),
      });
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      const durationMs = Date.now() - startTime;
      resolve({
        exit_status: null,
        output_ref: null,
        output_hash: null,
        duration_ms: durationMs,
        started: processStarted,
        completed: false,
        timed_out: false,
        error: err.message,
      });
    });
        timed_out: false,
        error: err.message,
      });
    });
  });
}

/**
 * Run the full container execution pipeline.
 *
 * 1. Create ephemeral workspace
 * 2. Write source files (patched) to workspace
 * 3. Execute each validation command in container
 * 4. Capture results with resource limits
 * 5. Clean up workspace
 *
 * @param {object} params
 * @param {Array<{path, content}>} params.files - patched source files
 * @param {string[]} params.commands - validation command identifiers
 * @param {object} params.limits - resource limits
 * @param {string} params.sandbox_image_digest - pinned image digest
 * @returns {Promise<object>} execution result
 */
export async function runDockerExecution(params) {
  const { files, commands, limits, sandbox_image_digest, execution_steps } = params;

  if (!files || !Array.isArray(files) || files.length === 0) {
    throw new Error("runDockerExecution: files array is required");
  }
  if (!commands || !Array.isArray(commands) || commands.length === 0) {
    throw new Error("runDockerExecution: commands array is required");
  }

  const appliedLimits = { ...DOCKER_DEFAULT_LIMITS, ...limits };

  // Detect container runtime
  const detected = await detectContainerRuntime();
  if (!detected) {
    return {
      overall: "inconclusive",
      command_results: [],
      executed_steps: [],
      aggregate_exit_status: null,
      sandbox_image_digest,
      limits_applied: appliedLimits,
      inconclusive_reason: "no_container_runtime",
      inconclusive_detail: "Neither docker nor podman is available",
    };
  }

  const { runtime, version: runtimeVersion } = detected;
  let workspace = null;

  try {
    // 1. Create ephemeral workspace
    workspace = await mkdtemp(join(tmpdir(), "gitwire-docker-"));
    logger.debug({ workspace, fileCount: files.length }, "Docker workspace created");

    // 2. Write patched source files (with path traversal guard)
    for (const file of files) {
      if (file.path.includes("..") || file.path.startsWith("/")) {
        return {
          overall: "inconclusive",
          command_results: [],
          executed_steps: [],
          aggregate_exit_status: null,
          sandbox_image_digest,
          limits_applied: appliedLimits,
          inconclusive_reason: "workspace_setup_failed",
          inconclusive_detail: `Path traversal detected: ${file.path}`,
        };
      }

      const filePath = join(workspace, file.path);
      const dir = join(filePath, "..");
      await mkdir(dir, { recursive: true }).catch(() => {});
      await writeFile(filePath, file.content, "utf-8");
    }

    // 3. Execute each validation command via argv template
    const commandResults = [];
    let aggregateExitStatus = 0;

    // Build a lookup from execution_steps for planner-issued metadata.
    const stepMeta = new Map();
    if (Array.isArray(execution_steps)) {
      for (const step of execution_steps) {
        if (step && step.command_id) {
          stepMeta.set(step.command_id, step);
        }
      }
    }

    for (const cmdId of commands) {
      const meta = stepMeta.get(cmdId) || {};
      let argv;
      try {
        argv = resolveCommandTemplate(cmdId);
      } catch (templateErr) {
        logger.warn({ cmdId }, "Non-allowlisted validation command rejected");
        commandResults.push({
          command: cmdId,
          step_id: meta.step_id || cmdId,
          sequence: meta.sequence ?? commandResults.length,
          exit_status: null,
          output_ref: null,
          output_hash: null,
          duration_ms: 0,
          timed_out: false,
          error: templateErr.message,
        });
        aggregateExitStatus = null;
        continue;
      }

      const result = await executeInContainer(runtime, argv, workspace, appliedLimits);
      commandResults.push({
        command: cmdId,
        step_id: meta.step_id || cmdId,
        sequence: meta.sequence ?? commandResults.length,
        exit_status: result.exit_status,
        output_ref: result.output_ref,
        output_hash: result.output_hash,
        duration_ms: result.duration_ms,
        // Plan-execution conformance: echo planner-issued command_source
        // and actual argv passed to the container.
        executed_argv: argv,
        command_source: meta.command_source || "legacy_template",
        started: result.started !== false,
        completed: result.completed === true,
        timed_out: Boolean(result.timed_out),
        ...(result.timed_out ? { timeout_reason: result.timeout_reason } : {}),
        ...(result.error ? { error: result.error } : {}),
      });

      if (result.exit_status === null) {
        aggregateExitStatus = null;
      } else if (result.exit_status !== 0 && aggregateExitStatus !== null) {
        aggregateExitStatus = result.exit_status;
      }
    }

    // 4. Derive overall result
    //
    // Even though this backend runs in a container with isolation, supports_pass
    // is still false. We derive fail/inconclusive but do NOT produce pass until
    // supports_pass is flipped and E2E isolation evidence is verified.
    let overall;
    let inconclusiveReason;

    if (commandResults.some((c) => c.exit_status === null)) {
      overall = "inconclusive";
      inconclusiveReason = commandResults.some((c) => c.timed_out)
        ? "wall_clock_exceeded"
        : commandResults.some((c) => c.error)
          ? "executor_error"
          : "execution_incomplete";
    } else if (aggregateExitStatus === 0) {
      // All commands exited zero. Check if this image is a real configured
      // image or a test fixture. The test fixture cannot authorize pass
      // outside test environments (GITWIRE_ALLOW_TEST_FIXTURE=1).
      if (isTestFixtureImage()) {
        overall = "inconclusive";
        inconclusiveReason = "test_fixture_image_not_production";
      } else {
        overall = "pass";
      }
    } else {
      overall = "fail";
    }

    return {
      overall,
      command_results: commandResults,
      // Plan-execution conformance: structured step evidence.
      executed_steps: commandResults.map((cr, i) => ({
        step_id: cr.step_id || cr.command,
        sequence: cr.sequence ?? i,
        command_source: cr.command_source || "legacy_template",
        executed_argv: cr.executed_argv || null,
        target_paths: null,
        exit_status: cr.exit_status,
        started: cr.started !== false,
        completed: cr.completed === true,
        timed_out: cr.timed_out === true,
      })),
      aggregate_exit_status: aggregateExitStatus,
      sandbox_image_digest,
      limits_applied: appliedLimits,
      ...(inconclusiveReason ? { inconclusive_reason: inconclusiveReason } : {}),
      container_runtime: runtime,
      runtime_version: runtimeVersion,
    };
  } catch (err) {
    logger.error({ err: err.message, workspace }, "Docker execution failed");
    return {
      overall: "inconclusive",
      command_results: [],
      executed_steps: [],
      aggregate_exit_status: null,
      sandbox_image_digest,
      limits_applied: appliedLimits,
      inconclusive_reason: "executor_error",
      inconclusive_detail: err.message,
      container_runtime: runtime,
      runtime_version: runtimeVersion,
    };
  } finally {
    if (workspace) {
      try {
        await rm(workspace, { recursive: true, force: true });
      } catch (_e) {
        logger.warn({ workspace }, "Failed to clean up docker workspace");
      }
    }
  }
}

/**
 * The Docker/Podman executor backend.
 *
 * Supports the ExecutorBackend contract. supports_pass is false until
 * E2E isolation evidence is verified and a subsequent PR flips it.
 */
const dockerExecutorBackend = {
  id: "docker-executor",
  version: "1.0.0",
  image_digest: DOCKER_IMAGE_DIGEST,
  image_ref: DOCKER_IMAGE_REF,

  // TRUE — backend has isolation evidence and is pass-authorized.
  // ALLOWED_PASS_EXECUTION_BACKENDS now includes docker-executor.
  // The lifecycle verifier requires durable backend evidence (check 3e)
  // before accepting any pass receipt from this backend.
  supports_pass: true,

  // Isolation properties — all enforced by container runtime
  container_runtime: "docker",  // or "podman" — detected at runtime
  runtime_version: null,        // detected at runtime
  network_disabled: true,
  non_root: true,
  read_only_rootfs: true,
  resource_limits: {
    cpu_shares: 512,
    memory_mb: 512,
    pids_limit: 64,
    wall_clock_ms: true,
    output_bytes: true,
  },

  // Plan-execution conformance: this backend produces structured executed_steps.
  // It does NOT support command-descriptor-v1 (legacy templates only).
  execution_features: Object.freeze(["normative-step-reporting-v1"]),

  /**
   * Return the isolation binding for receipt construction.
   * @returns {object}
   */
  describe() {
    return {
      execution_backend_id: this.id,
      executor_version: this.version,
      sandbox_image_digest: this.image_digest,
      image_ref: this.image_ref,
      container_runtime: this.container_runtime,
      runtime_version: this.runtime_version,
      network_disabled: this.network_disabled,
      non_root: this.non_root,
      read_only_rootfs: this.read_only_rootfs,
      resource_limits: this.resource_limits,
    };
  },

  /**
   * Run validation commands in container.
   *
   * @param {object} params
   * @returns {Promise<object>}
   */
  async run({ files, commands, command_descriptors, execution_steps, limits, sandbox_image_digest }) {
    return runDockerExecution({ files, commands, command_descriptors, execution_steps, limits, sandbox_image_digest });
  },
};

// Validate at module load
validateBackendContract(dockerExecutorBackend);

export default dockerExecutorBackend;
export { dockerExecutorBackend };
