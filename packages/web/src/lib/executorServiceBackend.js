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
   * Run validation commands via the executor service.
   *
   * v0.23.0 Task 3 PLACEHOLDER: returns inconclusive with a typed reason.
   * Task 5 replaces this with a real POST /v1/validate call.
   *
   * @param {object} _params
   * @returns {Promise<object>} inconclusive ExecResult
   */
  async run(_params) {
    return {
      overall: "inconclusive",
      command_results: [],
      aggregate_exit_status: null,
      inconclusive_reason: "executor_service_validate_not_implemented",
      inconclusive_detail: "POST /v1/validate is implemented in Task 5 (v0.23.0)",
    };
  },
};

// Validate at module load — fail fast on contract violations.
validateBackendContract(executorServiceBackend);
