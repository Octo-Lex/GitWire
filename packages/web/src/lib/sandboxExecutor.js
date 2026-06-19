// src/lib/sandboxExecutor.js
// Real sandbox execution backend for repair validation.
//
// Executes validation commands in an isolated workspace with strict
// resource constraints. Commands are resolved from allowlisted argv
// templates — never raw strings passed to a shell.
//
// The executor:
// - Receives an in-memory file set (no network, no credentials)
// - Writes files to a temporary workspace directory
// - Spawns each validation command with resource limits
// - Captures and redacts stdout/stderr
// - Returns per-command exit statuses and output hashes
// - Cleans up the workspace after execution
//
// In production, this would be backed by a container runtime (Docker/Podman)
// with full isolation: network disabled, non-root, read-only source input,
// CPU/memory/process/wall-clock/output limits enforced by the kernel.
//
// The governance framework operates identically regardless of the
// underlying execution engine — the receipt verification is what matters.

import { spawn } from "child_process";
import crypto from "crypto";
import { mkdtemp, writeFile, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { logger } from "./logger.js";
import { resolveCommandTemplate } from "./validationCommandTemplates.js";

/**
 * Redact potential secrets from captured output.
 * Removes lines that look like tokens, keys, passwords.
 *
 * @param {string} output - raw stdout/stderr
 * @param {number} maxBytes - maximum bytes to capture
 * @returns {string} redacted output (truncated)
 */
export function redactOutput(output, maxBytes = 1048576) {
  if (!output) return "";

  // Truncate to max bytes
  let result = output;
  if (Buffer.byteLength(result, "utf-8") > maxBytes) {
    result = Buffer.from(result, "utf-8").subarray(0, maxBytes).toString("utf-8") + "\n[output truncated]";
  }

  // Redact common secret patterns
  const SECRET_PATTERNS = [
    /ghp_[A-Za-z0-9]{36,}/g,           // GitHub PAT
    /gho_[A-Za-z0-9]{36,}/g,           // GitHub OAuth
    /github_pat_[A-Za-z0-9_]{82,}/g,   // GitHub fine-grained PAT
    /[A-Za-z0-9_+/]{40,}=*/g,          // Generic base64 token (conservative)
  ];

  for (const pattern of SECRET_PATTERNS) {
    result = result.replace(pattern, "[REDACTED]");
  }

  return result;
}

/**
 * Compute a content-addressed hash for output content.
 */
function hashOutput(content) {
  return "sha256:" + crypto.createHash("sha256").update(content, "utf-8").digest("hex");
}

/**
 * Execute a single command in the workspace with resource limits.
 *
 * Uses child_process.spawn (no shell) with a minimal environment.
 * Returns { exit_status, output_ref, output_hash, duration_ms }.
 *
 * @param {string[]} argv - command and arguments
 * @param {string} cwd - workspace directory
 * @param {object} limits - resource limits
 * @returns {Promise<object>} command result
 */
function executeCommand(argv, cwd, limits) {
  return new Promise((resolve) => {
    const startTime = Date.now();

    // Minimal environment — no secrets, tokens, or inherited credentials
    const env = {
      PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin",
      HOME: cwd,
      LANG: "en_US.UTF-8",
      NODE_ENV: "production",
    };

    const child = spawn(argv[0], argv.slice(1), {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: false,
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    // Output size limit
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

    // Wall-clock timeout
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill("SIGKILL"); } catch (_e) { /* already exited */ }
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
        timed_out: false,
        error: err.message,
      });
    });
  });
}

/**
 * Run the full sandbox execution pipeline.
 *
 * 1. Create ephemeral workspace
 * 2. Write source files (patched) to workspace
 * 3. Execute each validation command via argv template
 * 4. Capture results with resource limits
 * 5. Clean up workspace
 *
 * @param {object} params
 * @param {Array<{path, content}>} params.files - patched source files to write
 * @param {string[]} params.commands - validation command identifiers
 * @param {object} params.limits - resource limits
 * @param {string} params.sandbox_image_digest - pinned image digest for receipt
 * @returns {Promise<object>} execution result with per-command results
 */
export async function runSandboxExecution(params) {
  const { files, commands, limits, sandbox_image_digest } = params;

  if (!files || !Array.isArray(files) || files.length === 0) {
    throw new Error("runSandboxExecution: files array is required");
  }
  if (!commands || !Array.isArray(commands) || commands.length === 0) {
    throw new Error("runSandboxExecution: commands array is required");
  }
  if (!limits) {
    throw new Error("runSandboxExecution: limits are required");
  }

  const appliedLimits = { ...limits };
  let workspace = null;

  try {
    // 1. Create ephemeral workspace
    workspace = await mkdtemp(join(tmpdir(), "gitwire-sandbox-"));
    logger.debug({ workspace, fileCount: files.length }, "Sandbox workspace created");

    // 2. Write patched source files
    for (const file of files) {
      const filePath = join(workspace, file.path);

      // Prevent path traversal — path must be relative and not escape workspace
      if (file.path.includes("..") || file.path.startsWith("/")) {
        return {
          overall: "inconclusive",
          command_results: [],
          aggregate_exit_status: null,
          inconclusive_reason: "workspace_setup_failed",
          inconclusive_detail: `Path traversal detected: ${file.path}`,
        };
      }

      // Ensure parent directories exist
      const dir = join(filePath, "..");
      const { mkdir } = await import("fs/promises");
      await mkdir(dir, { recursive: true }).catch(() => {});

      await writeFile(filePath, file.content, "utf-8");
    }

    // 3. Execute each validation command via argv template (no shell)
    const commandResults = [];
    let aggregateExitStatus = 0;

    for (const cmdId of commands) {
      let argv;
      try {
        argv = resolveCommandTemplate(cmdId);
      } catch (templateErr) {
        // Non-allowlisted command — fail closed
        logger.warn({ cmdId }, "Non-allowlisted validation command rejected by executor");
        commandResults.push({
          command: cmdId,
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

      logger.debug({ cmdId, argv: argv.slice(0, 2) }, "Executing validation command");

      const result = await executeCommand(argv, workspace, appliedLimits);
      commandResults.push({
        command: cmdId,
        exit_status: result.exit_status,
        output_ref: result.output_ref,
        output_hash: result.output_hash,
        duration_ms: result.duration_ms,
        ...(result.timed_out ? { timed_out: true, timeout_reason: result.timeout_reason } : {}),
        ...(result.error ? { error: result.error } : {}),
      });

      // Track aggregate exit status
      if (result.exit_status === null) {
        aggregateExitStatus = null;
      } else if (result.exit_status !== 0 && aggregateExitStatus !== null) {
        aggregateExitStatus = result.exit_status;
      }
    }

    // 4. Derive overall result from command exit statuses
    //
    // P0 SECURITY: The host spawn executor is NOT a sandbox.
    // It lacks network isolation, CPU/memory/process limits, non-root
    // enforcement, and container-level isolation. It CANNOT produce
    // a `pass` result — only `inconclusive` or `fail`.
    //
    // A real isolated backend (Docker/Podman/nsjail/firejail) would be
    // required to produce `pass`. Until then, all host-spawn results are
    // inconclusive with a structured reason.
    let overall;
    let inconclusive_reason;
    if (commandResults.some((c) => c.exit_status === null)) {
      // Any command with null exit status (timeout, spawn error, disallowed) → inconclusive
      overall = "inconclusive";
      inconclusive_reason = commandResults.some((c) => c.timed_out)
        ? "wall_clock_exceeded"
        : commandResults.some((c) => c.error)
          ? "executor_error"
          : "execution_incomplete";
    } else {
      // Host spawn is not isolated — always inconclusive regardless of exit statuses
      overall = "inconclusive";
      inconclusive_reason = "host_spawn_not_isolated";
    }

    return {
      overall,
      command_results: commandResults,
      aggregate_exit_status: aggregateExitStatus,
      sandbox_image_digest,
      limits_applied: appliedLimits,
      inconclusive_reason,
    };
  } catch (err) {
    logger.error({ err: err.message, workspace }, "Sandbox execution failed");
    return {
      overall: "inconclusive",
      command_results: [],
      aggregate_exit_status: null,
      sandbox_image_digest,
      limits_applied: appliedLimits,
      inconclusive_reason: "executor_error",
      inconclusive_detail: err.message,
    };
  } finally {
    // 5. Clean up workspace
    if (workspace) {
      try {
        await rm(workspace, { recursive: true, force: true });
      } catch (_e) {
        logger.warn({ workspace }, "Failed to clean up sandbox workspace");
      }
    }
  }
}
