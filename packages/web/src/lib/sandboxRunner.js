// src/lib/sandboxRunner.js
// Sandboxed verification runner for CI repair proposals.
//
// Resolves a verified patch artifact, applies it to a pinned source
// snapshot, executes bounded required validations in an isolated sandbox,
// and produces a durable execution receipt.
//
// No repository credentials, no network by default, resource-limited.
// Commands are resolved from allowlisted argv templates — never raw
// strings passed to a shell.
//
// The governance framework operates identically regardless of the
// underlying execution engine.

import crypto from "crypto";
import { logger } from "./logger.js";
import { applyArtifact, computeSnapshotHash } from "./artifactApplier.js";
import { getDefaultBackend, getBackend } from "./executorRegistry.js";

// Pinned sandbox image digest.
// In production, this would be the SHA-256 digest of the container image.
// For the Node.js executor, this identifies the executor version.
export const SANDBOX_IMAGE_DIGEST = "sha256:node-executor-v1";

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
 * Build a canonical execution receipt from the sandbox execution results.
 *
 * The receipt is a canonical JSON serialization that binds all execution
 * inputs and outputs. Its hash is content-addressed — same inputs and
 * outputs always produce the same hash. Receipts are immutable and
 * write-once in the durable store.
 *
 * @param {object} params
 * @returns {{ receipt_content: string, receipt_hash: string, receipt_ref: string }}
 */
export function buildExecutionReceipt(params) {
  const {
    execution_backend_id,
    executor_version,
    source_snapshot_hash,
    patch_artifact_hash,
    base_sha,
    input_bundle_hash,
    sandbox_image_digest,
    validation_plan_hash,
    commands_executed,
    per_command_exit_statuses,
    aggregate_exit_status,
    output_refs,
    output_hashes,
    limits_applied,
    result,
    inconclusive_reason,
    // Isolation bindings — bound into the receipt so the verifier can
    // confirm that the execution environment met the isolation contract.
    container_runtime,
    runtime_version,
    network_disabled,
    non_root,
    read_only_rootfs,
    resource_limits,
    image_ref,
    // Gap 1 validator bindings — bound into the receipt so the verifier
    // can confirm the validator result came from a pass-capable backend
    // with proven image identity.
    executor_kind,
    executor_pass_capable,
    validator_image_ref,
    validator_image_digest,
    validator_result,
    validator_result_status,
  } = params;

  const receiptObject = {
    execution_backend_id,
    executor_version,
    source_snapshot_hash,
    patch_artifact_hash,
    base_sha,
    input_bundle_hash,
    sandbox_image_digest,
    validation_plan_hash,
    commands: commands_executed,
    per_command_exit_statuses,
    aggregate_exit_status,
    output_refs,
    output_hashes,
    limits_applied,
    result,
    // Isolation bindings — part of the content-addressed hash
    container_runtime: container_runtime || "none",
    runtime_version: runtime_version || null,
    network_disabled: Boolean(network_disabled),
    non_root: Boolean(non_root),
    read_only_rootfs: Boolean(read_only_rootfs),
    resource_limits: resource_limits || {},
    image_ref: image_ref || null,
    // Gap 1 validator bindings — part of the content-addressed hash.
    executor_kind: executor_kind || null,
    executor_pass_capable: Boolean(executor_pass_capable),
    validator_image_ref: validator_image_ref || null,
    validator_image_digest: validator_image_digest || null,
    validator_result: validator_result || result,
    validator_result_status: validator_result_status || result,
    ...(inconclusive_reason ? { inconclusive_reason } : {}),
    // NO timestamps or DB IDs — hash is content-addressed only
  };

  const receiptContent = JSON.stringify(receiptObject);
  const receiptHash = "sha256:" + crypto.createHash("sha256").update(receiptContent).digest("hex");
  const receiptRef = `receipt:${receiptHash}`;

  // proof_collected_at is a sibling, NOT inside receipt_content. Keeping it
  // out of the hash preserves the content-addressed write-once dedup
  // property (two identical executions stay the same receipt even if run
  // at different times). The durable store's created_at is the canonical
  // persisted timestamp; this sibling is the in-memory observed time.
  return {
    receipt_content: receiptContent,
    receipt_hash: receiptHash,
    receipt_ref: receiptRef,
    proof_collected_at: new Date().toISOString(),
  };
}

/**
 * Run sandboxed verification of a patch artifact against a source snapshot.
 *
 * Pipeline:
 * 1. Build validation plan from envelope
 * 2. Parse and verify artifact base_sha
 * 3. Apply artifact to source files (fail-closed)
 * 4. Execute validation commands via argv templates
 * 5. Build execution receipt
 *
 * @param {object} options
 * @param {string} options.artifactContent - verified patch artifact JSON
 * @param {string} options.base_sha - pinned base SHA
 * @param {object} options.taskEnvelope - proposal task envelope
 * @param {Array<{path, content}>} options.sourceFiles - source at base_sha
 * @param {string} options.source_snapshot_hash - content-addressed snapshot hash
 * @param {string} options.input_bundle_hash - canonical input bundle hash
 * @param {string} options.patch_artifact_hash - artifact hash
 * @param {object} [options.limits] - resource limits override
 * @returns {Promise<object>} structured verification result with receipt data
 */
export async function runSandboxVerification(options) {
  const {
    artifactContent,
    base_sha,
    taskEnvelope,
    sourceFiles,
    source_snapshot_hash,
    input_bundle_hash,
    patch_artifact_hash,
    limits,
    backend_id,
  } = options;

  if (!artifactContent) throw new Error("artifactContent is required");
  if (!base_sha) throw new Error("base_sha is required");
  if (!taskEnvelope) throw new Error("taskEnvelope is required");
  if (!sourceFiles) throw new Error("sourceFiles is required");
  if (!source_snapshot_hash) throw new Error("source_snapshot_hash is required");

  // Select executor backend
  const backend = backend_id ? getBackend(backend_id) : getDefaultBackend();
  const isolation = backend.describe();
  const appliedLimits = { ...DEFAULT_LIMITS, ...limits };

  logger.info({ backend: backend.id, supports_pass: backend.supports_pass }, "Executor backend selected");

  // Build validation plan from envelope
  const { commands, validation_plan_hash } = buildValidationPlan(taskEnvelope);

  // Parse artifact
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

  // Apply artifact to source files (fail-closed on any mismatch)
  const applyResult = applyArtifact(sourceFiles, parsedArtifact);
  if (!applyResult.applied) {
    // Patch application failed — produce inconclusive result with receipt
    const receipt = buildExecutionReceipt({
      execution_backend_id: isolation.execution_backend_id,
      executor_version: isolation.executor_version,
      source_snapshot_hash,
      patch_artifact_hash,
      base_sha,
      input_bundle_hash,
      sandbox_image_digest: isolation.sandbox_image_digest,
      validation_plan_hash,
      commands_executed: [],
      per_command_exit_statuses: [],
      aggregate_exit_status: null,
      output_refs: [],
      output_hashes: [],
      limits_applied: appliedLimits,
      result: "inconclusive",
      inconclusive_reason: "artifact_apply_failed",
      container_runtime: isolation.container_runtime,
      runtime_version: isolation.runtime_version,
      network_disabled: isolation.network_disabled,
      non_root: isolation.non_root,
      read_only_rootfs: isolation.read_only_rootfs,
      image_ref: isolation.image_ref,
      resource_limits: isolation.resource_limits,
    });

    logger.warn(
      { base_sha, failure: applyResult.failure },
      "Sandbox verification: artifact apply failed"
    );

    return {
      overall: "inconclusive",
      commands: [],
      exit_status: null,
      validation_plan_hash,
      sandbox_image_digest: isolation.sandbox_image_digest,
      limits_applied: appliedLimits,
      redacted_summary: `artifact_apply_failed: ${applyResult.failure}`,
      inconclusive_reason: "artifact_apply_failed",
      receipt,
    };
  }

  // Execute validation commands via selected backend
  const execResult = await backend.run({
    files: applyResult.files,
    commands,
    limits: appliedLimits,
    sandbox_image_digest: isolation.sandbox_image_digest,
  });

  // Build execution receipt from actual execution results
  const commandsExecuted = execResult.command_results.map((c) => c.command);
  const perCommandExitStatuses = execResult.command_results.map((c) => c.exit_status);
  const outputRefs = execResult.command_results.filter((c) => c.output_ref).map((c) => c.output_ref);
  const outputHashes = execResult.command_results.filter((c) => c.output_hash).map((c) => c.output_hash);

  // Use runtime-detected isolation properties if the backend overrides them
  const receiptContainerRuntime = execResult.container_runtime || isolation.container_runtime;
  const receiptRuntimeVersion = execResult.runtime_version || isolation.runtime_version;

  const receipt = buildExecutionReceipt({
    execution_backend_id: isolation.execution_backend_id,
    executor_version: isolation.executor_version,
    source_snapshot_hash,
    patch_artifact_hash,
    base_sha,
    input_bundle_hash,
    sandbox_image_digest: isolation.sandbox_image_digest,
    validation_plan_hash,
    commands_executed: commandsExecuted,
    per_command_exit_statuses: perCommandExitStatuses,
    aggregate_exit_status: execResult.aggregate_exit_status,
    output_refs: outputRefs,
    output_hashes: outputHashes,
    limits_applied: appliedLimits,
    result: execResult.overall,
    ...(execResult.inconclusive_reason ? { inconclusive_reason: execResult.inconclusive_reason } : {}),
    container_runtime: receiptContainerRuntime,
    runtime_version: receiptRuntimeVersion,
    network_disabled: isolation.network_disabled,
    non_root: isolation.non_root,
    read_only_rootfs: isolation.read_only_rootfs,
      image_ref: isolation.image_ref,
    resource_limits: isolation.resource_limits,
  });

  logger.info(
    { backend: backend.id, commands: commandsExecuted.length, overall: execResult.overall, validation_plan_hash },
    "Sandbox verification completed"
  );

  return {
    overall: execResult.overall,
    commands: execResult.command_results,
    exit_status: execResult.aggregate_exit_status,
    validation_plan_hash,
    sandbox_image_digest: isolation.sandbox_image_digest,
    limits_applied: appliedLimits,
    redacted_summary: execResult.inconclusive_reason || `executed ${commandsExecuted.length} commands`,
    ...(execResult.inconclusive_reason ? { inconclusive_reason: execResult.inconclusive_reason } : {}),
    receipt,
    execution_backend_id: backend.id,
  };
}
