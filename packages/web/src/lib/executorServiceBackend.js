// src/lib/executorServiceBackend.js
// Executor-service backend (v0.23.0 Task 3).
//
// Implements the ExecutorBackend contract so the executor-service can register
// alongside node-executor and docker-executor. For Task 3, run() is a
// PLACEHOLDER that returns inconclusive with a typed reason — POST /v1/validate
// is Task 5, not here. describe() returns real values so /health and receipt
// binding have something concrete to work with once reachability/registration
// land (later steps in this task).
//
// The backend advertises supports_pass=true matches the design contract:
// executor-service is a pass-capable backend by design (when reachable + the
// validator identity is complete + isolation evidence is proven). The
// pass-capable DERIVATION in the runner still gates on those conditions;
// supports_pass=true here is the backend's static claim, not the runtime proof.
//
// IMAGE_IDENTITY NOTE: unlike node/docker executors which have a fixed
// image_digest baked in at module load, the executor-service's validator
// image identity is configured at runtime (GITWIRE_VALIDATOR_IMAGE_REF/_DIGEST).
// The backend exposes a module-level image_digest that satisfies the contract
// (validateBackendContract requires a sha256:... value); describe() returns
// the configured image_ref when available, null otherwise. The runner's
// pass-capable derivation (Task 7, rev 3 amendment) refuses to authorize pass
// when identity is incomplete, so the static placeholder digest here is never
// sufficient on its own.

import { validateBackendContract } from "./executorBackend.js";

/**
 * Normalize an executor-service response to the complete ExecResult shape that
 * sandboxRunner.js expects. The service returns a rich report on success, but
 * postValidate() synthesizes failure responses with only overall/reason/detail
 * — missing command_results and aggregate_exit_status. sandboxRunner does
 * execResult.command_results.map(...) unconditionally, so a missing array
 * crashes. This helper ensures every return has both fields.
 *
 * @param {object} response - raw response from postValidate or the service
 * @returns {object} normalized with command_results + aggregate_exit_status always present
 */
function normalizeExecResult(response) {
  return {
    ...response,
    // Ensure command_results is always an array (empty on failure/inconclusive).
    command_results: Array.isArray(response.command_results) ? response.command_results : [],
    // Ensure aggregate_exit_status is always present (null on failure/inconclusive).
    aggregate_exit_status: response.aggregate_exit_status ?? null,
    // Ensure overall is one of the three valid values.
    overall: ["pass", "fail", "inconclusive"].includes(response.overall) ? response.overall : "inconclusive",
  };
}

// Static module-level digest. Real validator identity comes from config and
// is bound into receipts at run time; this satisfies the contract at module
// load (validateBackendContract requires a sha256: value). The runner's
// pass-capable derivation requires the configured validator image identity
// in addition — this placeholder alone never authorizes pass.
const PLACEHOLDER_IMAGE_DIGEST = "sha256:" + "0".repeat(64);

// Configured validator image identity, read lazily so the module is import-safe
// before config loads. Null until the operator sets the env vars.
function readConfiguredImageRef() {
  return process.env.GITWIRE_VALIDATOR_IMAGE_REF || null;
}

/**
 * The executor-service backend.
 *
 * v0.23.0 Task 3: registration + describe() + run() placeholder.
 * Task 5 replaces run() with a real POST /v1/validate call.
 */
export const executorServiceBackend = {
  id: "executor-service",
  version: "1.0.0",
  image_digest: PLACEHOLDER_IMAGE_DIGEST,
  image_ref: null, // populated by describe() from config at call time

  // Pass-capable backend by design. The runner's derivation still gates on
  // reachability + validator identity + isolation evidence; supports_pass=true
  // alone never authorizes pass (rev 3 amendment, four+ condition conjunction).
  supports_pass: true,

  // Static isolation declaration — matches the contract the executor service
  // enforces on every validator run (network=none, read-only, non-root,
  // resource-limited). The service's actual /health response is the live
  // evidence; these are the backend's declared contract values.
  container_runtime: "docker",
  runtime_version: null, // detected per-run via the service's /health
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

  /**
   * Return the isolation binding for receipt construction.
   * @returns {object}
   */
  describe() {
    return {
      execution_backend_id: this.id,
      executor_version: this.version,
      sandbox_image_digest: this.image_digest,
      // image_ref is the configured validator image (or null when unset).
      // The runner cross-checks this against the service's /health response.
      image_ref: readConfiguredImageRef(),
      container_runtime: this.container_runtime,
      runtime_version: this.runtime_version,
      network_disabled: this.network_disabled,
      non_root: this.non_root,
      read_only_rootfs: this.read_only_rootfs,
      resource_limits: this.resource_limits,
    };
  },

  /**
   * Run validation commands via the executor service (POST /v1/validate).
   *
   * v0.23.0 Task 5: real implementation. Reads GITWIRE_EXECUTOR_SERVICE_URL +
   * _TOKEN + validator image identity from env, constructs the request body,
   * calls postValidate, and returns the service's response. When the URL
   * isn't configured, returns inconclusive with a typed reason (not a crash).
   *
   * @param {object} params
   * @param {Array<{path: string, content: string}>} params.files
   * @param {string[]} params.commands - allowlisted command IDs (lint/test/build/typecheck)
   * @param {object} params.limits - wall_clock_ms/memory_mb/pids_limit/output_bytes
   * @param {string} params.sandbox_image_digest - ignored (the service inspects the real image)
   * @returns {Promise<object>} the executor service's validate response
   */
  async run({ files, commands, limits, sandbox_image_digest: _ignored }) {
    const url = process.env.GITWIRE_EXECUTOR_SERVICE_URL;
    if (!url) {
      return {
        overall: "inconclusive",
        command_results: [],
        aggregate_exit_status: null,
        inconclusive_reason: "executor_service_url_not_configured",
        inconclusive_detail: "GITWIRE_EXECUTOR_SERVICE_URL not set",
      };
    }
    const token = process.env.GITWIRE_EXECUTOR_SERVICE_TOKEN;
    const validator_image_ref = process.env.GITWIRE_VALIDATOR_IMAGE_REF;
    const validator_image_digest = process.env.GITWIRE_VALIDATOR_IMAGE_DIGEST;

    // Lazy dynamic import avoids a static cycle and keeps the module import-safe
    // before the client is loaded.
    const { postValidate } = await import("./executorServiceClient.js");

    const requestBody = {
      request_id: `backend-${Date.now()}`,
      files: files || [],
      commands: commands || [],
      limits: limits || {},
      validator_image_ref,
      validator_image_digest,
      expected_executor_policy: {
        network_disabled: true,
        non_root: true,
        read_only_rootfs: true,
        resource_limits: true,
      },
    };

    const response = await postValidate({ url, token, body: requestBody });
    // P1 #3 fix: normalize EVERY return to the complete ExecResult shape that
    // sandboxRunner expects. postValidate synthesizes failure responses with
    // only { overall, inconclusive_reason, inconclusive_detail } — missing
    // command_results and aggregate_exit_status. sandboxRunner immediately
    // does execResult.command_results.map(...) and .filter(...), so a missing
    // array crashes the runner instead of producing an inconclusive receipt.
    //
    // On success, the response already has command_results + aggregate_exit_status;
    // this normalization is a no-op for well-formed responses.
    return normalizeExecResult(response);
  },
};

// Validate at module load — fail fast on contract violations.
validateBackendContract(executorServiceBackend);
