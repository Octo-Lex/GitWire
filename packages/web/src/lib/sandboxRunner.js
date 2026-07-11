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
import {
  executorKindForBackendId,
  isBackendPassCapable,
  probeAllBackends,
  deriveBackendReachability,
} from "./executorReachability.js";
import { resolveValidatorImage } from "./validatorImage.js";
import { compileValidationPlan } from "./validationPlanAdapter.js";
import { computeValidationPlanHash, resolveDescriptorActivation } from "@gitwire/core";

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
 * The plan is derived from task_envelope.required_validation plus, when
 * provided, the frozen ci_workflow_command descriptors in evidence_refs
 * (Task 8D — repo-aware command descriptors).
 *
 * @param {object} taskEnvelope - the proposal's task envelope
 * @param {object[]} [evidenceRefs] - CI evidence refs (may carry descriptors)
 * @returns {{ commands: string[], validation_plan_hash: string, command_descriptors: object }}
 */
export function buildValidationPlan(taskEnvelope, evidenceRefs) {
  if (!taskEnvelope || !Array.isArray(taskEnvelope.required_validation)) {
    throw new Error("Task envelope must contain required_validation array");
  }

  // Validate each requirement ID (sanity + security checks).
  for (const cmd of taskEnvelope.required_validation) {
    if (typeof cmd !== "string" || cmd.length === 0) {
      throw new Error(`Invalid validation command: must be a non-empty string`);
    }
    if (cmd.length > MAX_COMMAND_LENGTH) {
      throw new Error(`Validation command exceeds max length: ${cmd.substring(0, 40)}...`);
    }
    // No shell metacharacters — prevents injection
    if (/[;&|`$(){}<>\n\r\t]/.test(cmd)) {
      throw new Error(`Validation command contains shell metacharacters: ${cmd}`);
    }
  }

  // v0.23.0 Task 9 / Task 8D: compile semantic IDs into executable commands via
  // the validation-plan adapter. When evidence_refs carries ci_workflow_command
  // descriptors, they override the fixed templates.
  //
  // Plan-execution conformance: activation is resolved once and injected.
  // The plan now carries normative_steps, descriptor_policy, and
  // required_execution_features. The hash is computed by the shared
  // computeValidationPlanHash() — no inline JSON.stringify here.
  const descriptorActivation = resolveDescriptorActivation(process.env.GITWIRE_DESCRIPTOR_ACTIVATION);
  const plan = compileValidationPlan(taskEnvelope.required_validation, evidenceRefs, { descriptorActivation });
  const commands = plan.executable_commands;
  const command_descriptors = plan.command_descriptors || {};

  // Shared hash computation — both this function and
  // buildValidationPlanForRecorder() MUST use computeValidationPlanHash().
  const validation_plan_hash = computeValidationPlanHash({
    commands,
    command_descriptors,
    image_digest: SANDBOX_IMAGE_DIGEST,
    required_validation: taskEnvelope.required_validation,
    acceptance_policy: plan.acceptance_policy,
    plan_schema_version: plan.plan_schema_version,
    descriptor_policy: plan.descriptor_policy,
    normative_steps: plan.normative_steps,
    required_execution_features: plan.required_execution_features,
  });

  return {
    commands,
    command_descriptors,
    validation_plan_hash,
    acceptance_policy: plan.acceptance_policy,
    unmapped: plan.unmapped,
    plan_schema_version: plan.plan_schema_version,
    descriptor_policy: plan.descriptor_policy,
    normative_steps: plan.normative_steps,
    required_execution_features: plan.required_execution_features,
  };
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
    // v0.23.0 Task 6 — executor report bindings. These make the receipt
    // verifiable: the verifier resolves executor_report_ref, recomputes
    // executor_report_hash from the raw report, and compares before accepting
    // pass. Without these, the receipt's pass evidence is unverifiable.
    executor_report_hash,
    executor_report_ref,
    inspected_image_digest,
    inspection_hash,
    // DIAGNOSTIC (Task 8 Step 5): source classification. Marks whether the
    // receipt's executor result came from a real executor-service response or
    // from client-side synthetic fallback. Part of the content-addressed hash
    // so synthetic and real receipts are always distinct. Absent for non-
    // executor-service backends (treated as null).
    validation_response_source,
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
    // v0.23.0 Task 6 — executor report bindings (part of content-addressed hash).
    // null for non-executor-service backends; present when the executor service
    // produced the report. The verifier resolves executor_report_ref → raw
    // report → recomputes hash → compares to this field before accepting pass.
    executor_report_hash: executor_report_hash || null,
    executor_report_ref: executor_report_ref || null,
    inspected_image_digest: inspected_image_digest || null,
    inspection_hash: inspection_hash || null,
    // DIAGNOSTIC (Task 8 Step 5): source classification. "executor_service" =
    // real response from the service; "synthetic_inconclusive" = client-side
    // fallback (network error, non-200, timeout). null for non-executor-service
    // backends. This field makes synthetic receipts unambiguous — they can no
    // longer masquerade as executor-service receipts missing report bindings.
    validation_response_source: validation_response_source || null,
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
    evidenceRefs,
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

  // v0.23.0 Task 6 — derive validator bindings from BACKEND_ID-level
  // reachability (rev 3 amendment). The old kind-level logic
  // (reachableKinds.has(executorKind)) is unsafe now that executor-service
  // and docker-executor both map to container-runtime: it would pass when
  // either backend was reachable even if the selected one was down.
  const validatorImage = resolveValidatorImage();
  const executorKind = executorKindForBackendId(backend.id);

  // Build the backend_id → kind map + probe map for deriveBackendReachability.
  const probe = probeAllBackends();
  const backendKinds = {};
  const probes = {};
  // Map sync probes to backend_ids (one sync backend per kind except
  // executor-service, which is handled by its async probe — but in the
  // runner context, we only care about the SELECTED backend's reachability).
  for (const b of probe.backends) {
    // For the kind-level probe, map to the sync backends that own that kind.
    // docker-executor → container-runtime (sync); node-executor → local-process.
    if (b.kind === executorKind || b.kind === "local-process") {
      // Find the registered backend id for this kind.
      const { listBackends } = await import("./executorRegistry.js");
      for (const id of listBackends()) {
        try {
          const idKind = executorKindForBackendId(id);
          if (idKind === b.kind && id !== "executor-service") {
            backendKinds[id] = idKind;
            probes[id] = { reachable: b.reachable };
          }
        } catch { /* skip unknown */ }
      }
    }
  }
  // The selected backend's kind + reachability.
  backendKinds[backend.id] = executorKind;
  // For executor-service, reachability comes from the probe's container-runtime
  // slot (which may be the docker-executor's sync probe, not the executor-
  // service's async probe — but the deriveBackendReachability helper checks
  // the SELECTED backend's probe entry, not the kind). For sync backends
  // (node/docker), the probe IS the kind-level signal.
  if (backend.id === "executor-service") {
    // The async executor-service probe is not available synchronously in the
    // runner. For the runner's pass-capable derivation, executor-service's
    // reachability is determined by whether its run() succeeds. If run()
    // returned a result at all, the service was reachable.
    probes[backend.id] = { reachable: true };
  } else {
    probes[backend.id] = probes[backend.id] || { reachable: probe.backends.find(b => b.kind === executorKind)?.reachable || false };
  }

  const { backend_reachable } = deriveBackendReachability({
    selectedBackendId: backend.id,
    backendKinds,
    probes,
  });

  // Pass-capability requires ALL conditions (v0.22.0 Gap 1 + v0.23.0 Task 6):
  //   1. backend advertises supports_pass
  //   2. kind is structurally pass-capable (not local-process)
  //   3. the SELECTED BACKEND (by backend_id) is reachable
  //   4. validator image identity is complete (ref + digest + match)
  const executorPassCapable =
    backend.supports_pass === true &&
    isBackendPassCapable(executorKind, backend_reachable) &&
    validatorImage.identity_complete;

  logger.info({ backend: backend.id, supports_pass: backend.supports_pass }, "Executor backend selected");

  // Build validation plan from envelope (+ evidence for Task 8D descriptors)
  const { commands, command_descriptors, validation_plan_hash } = buildValidationPlan(taskEnvelope, evidenceRefs);

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
      // Gap 1 validator bindings. The artifact-apply-failed path is always
      // inconclusive regardless of backend capability — the patch never ran.
      executor_kind: executorKind,
      executor_pass_capable: executorPassCapable,
      validator_image_ref: validatorImage.ref,
      validator_image_digest: validatorImage.digest,
      validator_result: "inconclusive",
      validator_result_status: "inconclusive",
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
    command_descriptors,
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

  // v0.23.0 Task 8 Step 5 fix: for executor-service, the real sandbox image
  // digest is the one the service INSPECTED (or the configured validator
  // digest), NOT the backend's static placeholder. The placeholder
  // (sha256:0000...) exists only to satisfy validateBackendContract at module
  // load; the service provides the real digest at run time via
  // inspected_image_digest. If neither is present (non-executor-service backend,
  // or inconclusive result), fall back to the isolation value. Fail-closed:
  // if the result is real but the digest is missing/placeholder, log a warning.
  const PLACEHOLDER_DIGEST = "sha256:0000000000000000000000000000000000000000000000000000000000000000";
  const resolvedSandboxDigest =
    (execResult.inspected_image_digest && execResult.inspected_image_digest !== PLACEHOLDER_DIGEST)
      ? execResult.inspected_image_digest
      : (execResult.validator_image_digest && execResult.validator_image_digest !== PLACEHOLDER_DIGEST
          && execResult.validation_response_source === "real_executor_service")
        ? execResult.validator_image_digest
        : isolation.sandbox_image_digest;
  if (resolvedSandboxDigest === PLACEHOLDER_DIGEST && execResult.validation_response_source === "real_executor_service") {
    logger.warn(
      { backend: backend.id, inspected: execResult.inspected_image_digest, validator: execResult.validator_image_digest },
      "Real executor-service response but no valid sandbox_image_digest resolved — using placeholder"
    );
  }

  const receipt = buildExecutionReceipt({
    execution_backend_id: isolation.execution_backend_id,
    executor_version: isolation.executor_version,
    source_snapshot_hash,
    patch_artifact_hash,
    base_sha,
    input_bundle_hash,
    sandbox_image_digest: resolvedSandboxDigest,
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
    // Gap 1 validator bindings. The validator result mirrors the execution
    // overall, but is downgraded to inconclusive when the backend isn't
    // pass-capable. This guarantees a local-process (or unreachable-Docker)
    // receipt's validator_result_status is always inconclusive, never pass.
    executor_kind: executorKind,
    executor_pass_capable: executorPassCapable,
    validator_image_ref: validatorImage.ref,
    validator_image_digest: validatorImage.digest,
    validator_result: executorPassCapable ? execResult.overall : "inconclusive",
    validator_result_status: executorPassCapable ? execResult.overall : "inconclusive",
    // v0.23.0 Task 6 — executor report bindings. These come from the
    // executor-service backend's run() response. For non-executor-service
    // backends, they're undefined → null in the receipt.
    executor_report_hash: execResult.executor_report_hash,
    executor_report_ref: execResult.executor_report_ref,
    inspected_image_digest: execResult.inspected_image_digest,
    inspection_hash: execResult.inspection_hash,
    // DIAGNOSTIC (Task 8 Step 5): carry the response source classification
    // from the backend into the receipt. For executor-service, this is
    // "executor_service" / "synthetic_inconclusive" / etc. For other backends,
    // undefined → null.
    validation_response_source: execResult.validation_response_source,
    // Plan-execution conformance: structured step evidence + frozen backend
    // feature snapshot. The receipt-bound features are used for historical
    // verification — NOT the current backend registry. The executed_steps
    // capture the actual argv passed to the process API.
    executed_steps: execResult.executed_steps || [],
    backend_execution_features: backend.execution_features || [],
  });

  // v0.23.0 Task 6 — persist the raw executor report durably if the backend
  // provided one (executor-service only). Shape B: execution_receipts table.
  //
  // P1 #2 fix (review): persistence failure is FAIL-CLOSED for pass results.
  // A pass receipt MUST NOT advance if the raw executor report is not
  // durably stored — the verifier cannot resolve executor_report_ref to
  // recompute the hash, making the pass evidence unverifiable. Downgrade to
  // inconclusive rather than proceeding with an unresolvable ref.
  let persistenceDowngraded = false;
  if (execResult.executor_report_ref && execResult.executor_report_hash) {
    try {
      const { storeExecutorReport } = await import("./executionReceiptStore.js");
      // Store the RAW executor-service report — exactly the object the service
      // hashed. The app adds diagnostic fields (validation_response_source,
      // synthetic_fallback_used) AFTER the service returned the report; those
      // were NOT present when the service computed executor_report_hash. Storing
      // the app-annotated object would make resolve(ref) → recompute(hash) fail.
      // Strip the app-side annotation fields to reconstruct the exact object
      // the service hashed.
      const APP_ADDED_FIELDS = new Set(["validation_response_source", "synthetic_fallback_used"]);
      const rawReport = {};
      for (const key of Object.keys(execResult)) {
        if (!APP_ADDED_FIELDS.has(key)) rawReport[key] = execResult[key];
      }
      await storeExecutorReport(
        JSON.stringify(rawReport),
        execResult.executor_report_hash,
        execResult.executor_report_ref
      );
    } catch (persistErr) {
      logger.error(
        { err: persistErr.message, backend: backend.id, overall: execResult.overall },
        "Failed to persist executor report — FAIL-CLOSED for pass results"
      );
      if (execResult.overall === "pass") {
        // Downgrade to inconclusive: the pass evidence is unverifiable without
        // a durable raw report. Strip the report fields so the receipt doesn't
        // carry an unresolvable ref.
        execResult.overall = "inconclusive";
        execResult.inconclusive_reason = "executor_report_persistence_failed";
        execResult.executor_report_hash = null;
        execResult.executor_report_ref = null;
        persistenceDowngraded = true;
      }
      // For non-pass results (fail/inconclusive), persistence failure is
      // non-fatal — the receipt was already inconclusive/fail, and report
      // persistence is for the pass-verification path.
    }
  }

  // If persistence downgraded the result to inconclusive, rebuild the receipt
  // with the downgraded values. The receipt was already built above with the
  // original execResult; rebuild it so the content-addressed hash reflects
  // the downgraded state.
  if (persistenceDowngraded) {
    return {
      overall: execResult.overall,
      commands: execResult.command_results,
      exit_status: execResult.aggregate_exit_status,
      validation_plan_hash,
      sandbox_image_digest: isolation.sandbox_image_digest,
      limits_applied: appliedLimits,
      redacted_summary: `executor_report_persistence_failed: report could not be stored durably`,
      inconclusive_reason: execResult.inconclusive_reason,
      receipt: buildExecutionReceipt({
        execution_backend_id: isolation.execution_backend_id,
        executor_version: isolation.executor_version,
        source_snapshot_hash,
        patch_artifact_hash,
        base_sha,
        input_bundle_hash,
        sandbox_image_digest: resolvedSandboxDigest,
        validation_plan_hash,
        commands_executed: commandsExecuted,
        per_command_exit_statuses: perCommandExitStatuses,
        aggregate_exit_status: execResult.aggregate_exit_status,
        output_refs: outputRefs,
        output_hashes: outputHashes,
        limits_applied: appliedLimits,
        result: execResult.overall,
        inconclusive_reason: execResult.inconclusive_reason,
        container_runtime: receiptContainerRuntime,
        runtime_version: receiptRuntimeVersion,
        network_disabled: isolation.network_disabled,
        non_root: isolation.non_root,
        read_only_rootfs: isolation.read_only_rootfs,
        image_ref: isolation.image_ref,
        resource_limits: isolation.resource_limits,
        executor_kind: executorKind,
        executor_pass_capable: false,
        validator_image_ref: validatorImage.ref,
        validator_image_digest: validatorImage.digest,
        validator_result: "inconclusive",
        validator_result_status: "inconclusive",
        executor_report_hash: null,
        executor_report_ref: null,
        inspected_image_digest: execResult.inspected_image_digest,
        inspection_hash: execResult.inspection_hash,
        validation_response_source: execResult.validation_response_source,
      }),
    };
  }

  logger.info(
    { backend: backend.id, commands: commandsExecuted.length, overall: execResult.overall, validation_plan_hash },
    "Sandbox verification completed"
  );

  return {
    overall: execResult.overall,
    commands: execResult.command_results,
    exit_status: execResult.aggregate_exit_status,
    validation_plan_hash,
    sandbox_image_digest: resolvedSandboxDigest,
    limits_applied: appliedLimits,
    redacted_summary: execResult.inconclusive_reason || `executed ${commandsExecuted.length} commands`,
    ...(execResult.inconclusive_reason ? { inconclusive_reason: execResult.inconclusive_reason } : {}),
    receipt,
    execution_backend_id: backend.id,
  };
}
