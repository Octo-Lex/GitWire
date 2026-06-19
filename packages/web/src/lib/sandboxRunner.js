// src/lib/sandboxRunner.js
// Sandboxed verification runner for CI repair proposals.
//
// Resolves a verified patch artifact, constructs a pinned ephemeral
// workspace, applies the patch in an isolated sandbox, and runs bounded
// required validations. No repository credentials, no network by default,
// resource-limited.
//
// This is a deterministic stub implementation. In production, this would
// be backed by a container runtime (Docker/Podman) with:
// - Ephemeral workspace at exact pinned head_sha
// - Pinned container image digest
// - Read-only source input + disposable writable work area
// - No repository credentials
// - No network by default
// - CPU, memory, process-count, wall-clock, output-size limits
// - Commands from required-validation allowlist only
// - No shell interpolation from untrusted content
//
// The governance framework operates identically regardless of the
// underlying execution engine.

import crypto from "crypto";
import { logger } from "./logger.js";

// Pinned sandbox image digest for the deterministic stub engine.
// In production, this would be the SHA-256 digest of the container image.
export const SANDBOX_IMAGE_DIGEST = "sha256:deterministic-stub-v1";

// Maximum allowed command name length
const MAX_COMMAND_LENGTH = 128;

// Default resource limits applied to every sandbox execution
export const DEFAULT_LIMITS = {
  cpu_shares: 512,
  memory_mb: 512,
  processes: 64,
  wall_clock_ms: 30000,
  output_bytes: 1048576, // 1 MB
};

/**
 * Build a canonical validation plan from the proposal's task envelope.
 *
 * The plan is derived ONLY from task_envelope.required_validation.
 * No open-ended command execution — only the approved allowlist.
 *
 * @param {object} taskEnvelope - the proposal's task envelope
 * @returns {{ commands: string[], validation_plan_hash: string }}
 */
export function buildValidationPlan(taskEnvelope) {
  if (!taskEnvelope || !Array.isArray(taskEnvelope.required_validation)) {
    throw new Error("Task envelope must contain required_validation array");
  }

  const commands = [...taskEnvelope.required_validation].sort(); // canonical order

  // Validate each command
  for (const cmd of commands) {
    if (typeof cmd !== "string" || cmd.length === 0) {
      throw new Error(`Invalid validation command: must be a non-empty string`);
    }
    if (cmd.length > MAX_COMMAND_LENGTH) {
      throw new Error(`Validation command exceeds max length: ${cmd.substring(0, 40)}...`);
    }
    // No shell metacharacters — prevents injection
    // The regex matches: ; & | ` $ ( ) { } < > \n \r \t
    if (/[;&|`$(){}<>\n\r\t]/.test(cmd)) {
      throw new Error(`Validation command contains shell metacharacters: ${cmd}`);
    }
  }

  const planContent = JSON.stringify({
    commands,
    image_digest: SANDBOX_IMAGE_DIGEST,
  });
  const validationPlanHash = "sha256:" + crypto.createHash("sha256").update(planContent).digest("hex");

  return { commands, validation_plan_hash: validationPlanHash };
}

/**
 * Validate that a command set matches the approved validation plan.
 *
 * - Every required command must be present in the executed set
 * - No disallowed commands may be present
 *
 * @param {string[]} executedCommands - commands actually run in sandbox
 * @param {string[]} requiredCommands - commands from the validation plan
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateCommandSet(executedCommands, requiredCommands) {
  const errors = [];

  const executed = new Set(executedCommands || []);
  const required = new Set(requiredCommands || []);

  // All required commands must be present
  for (const cmd of required) {
    if (!executed.has(cmd)) {
      errors.push(`Missing required validation command: ${cmd}`);
    }
  }

  // No disallowed commands
  for (const cmd of executed) {
    if (!required.has(cmd)) {
      errors.push(`Disallowed validation command not in plan: ${cmd}`);
    }
  }

  return errors.length > 0 ? { valid: false, errors } : { valid: true, errors: [] };
}

/**
 * Compute the verification fingerprint.
 *
 * Binds the artifact, base snapshot, input bundle, sandbox image, and
 * validation plan into a single immutable reference. Two verifications
 * with the same fingerprint are identical.
 *
 * @param {object} params
 * @returns {string} verification fingerprint (sha256:...)
 */
export function computeVerificationFingerprint(params) {
  const { patch_artifact_hash, base_sha, input_bundle_hash, sandbox_image_digest, validation_plan_hash } = params;

  const content = JSON.stringify({
    patch_artifact_hash,
    base_sha,
    input_bundle_hash,
    sandbox_image_digest,
    validation_plan_hash,
  });

  return "sha256:" + crypto.createHash("sha256").update(content).digest("hex");
}

/**
 * Run sandboxed verification of a patch artifact.
 *
 * Deterministic stub: validates the plan, "executes" each command in
 * canonical order, and produces structured output with hashes.
 *
 * In production, this would spawn a container with:
 * - Ephemeral workspace at base_sha
 * - Patch artifact applied
 * - Each validation command executed with resource limits
 * - Output captured and hashed
 *
 * @param {object} options
 * @param {string} options.artifactContent - verified patch artifact JSON
 * @param {string} options.base_sha - pinned base SHA
 * @param {object} options.taskEnvelope - proposal task envelope
 * @param {object} [options.limits] - resource limits override
 * @returns {Promise<object>} structured verification result
 */
export async function runSandboxVerification(options) {
  const { artifactContent, base_sha, taskEnvelope, limits } = options;

  if (!artifactContent) throw new Error("artifactContent is required");
  if (!base_sha) throw new Error("base_sha is required");
  if (!taskEnvelope) throw new Error("taskEnvelope is required");

  const appliedLimits = { ...DEFAULT_LIMITS, ...limits };

  // Build validation plan from envelope
  const { commands, validation_plan_hash } = buildValidationPlan(taskEnvelope);

  // Parse artifact to verify it applies
  let parsedArtifact;
  try {
    parsedArtifact = JSON.parse(artifactContent);
  } catch (_e) {
    throw new Error("Cannot verify: patch artifact is not valid JSON");
  }

  if (parsedArtifact.base_sha !== base_sha) {
    throw new Error(
      `Cannot verify: artifact base_sha (${parsedArtifact.base_sha}) does not match pinned base (${base_sha})`
    );
  }

  // No sandbox execution backend is available in this milestone.
  // The deterministic stub CANNOT verify that the patch applies or that
  // validation commands succeed. It returns inconclusive with a structured
  // execution-failure category, which transitions to failed under the
  // current lifecycle.
  //
  // A real implementation must:
  // - reconstruct the repository snapshot at base_sha
  // - apply the verified artifact edits
  // - execute each validation command inside an ephemeral container
  // - capture and hash the output
  // - report per-command exit statuses
  const overall = "inconclusive";
  const commandResults = commands.map((cmd) => ({
    command: cmd,
    exit_status: null, // not executed
    output_ref: null,
    output_hash: null,
  }));

  logger.info(
    { commands: commands.length, overall, validation_plan_hash },
    "Sandbox verification returned inconclusive (execution backend unavailable)"
  );

  return {
    overall,
    commands: commandResults,
    exit_status: null, // not executed
    validation_plan_hash,
    sandbox_image_digest: SANDBOX_IMAGE_DIGEST,
    limits_applied: appliedLimits,
    redacted_summary: "execution_backend_unavailable: no container runtime configured",
    inconclusive_reason: "execution_backend_unavailable",
  };
}
