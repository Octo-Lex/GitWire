// src/lib/nodeExecutorBackend.js
// Host spawn executor backend — child_process.spawn without isolation.
//
// This backend is NOT a sandbox. It runs on the host process with:
// - No network isolation
// - No non-root enforcement
// - No read-only rootfs
// - No kernel-enforced resource limits (only wall-clock timeout)
//
// Therefore supports_pass is ALWAYS false. All results are inconclusive
// with reason host_spawn_not_isolated.
//
// This backend exists for development and CI environments where a
// container runtime is not available. It can produce fail/inconclusive
// receipts but can NEVER authorize pass.

import { runSandboxExecution } from "./sandboxExecutor.js";
import { validateBackendContract } from "./executorBackend.js";

/**
 * The host spawn executor backend.
 *
 * Implements the ExecutorBackend contract but with supports_pass: false
 * and all isolation properties set to false/none.
 */
const nodeExecutorBackend = {
  id: "node-executor",
  version: "1.0.0",
  image_digest: "sha256:node-executor-v1",

  // ALWAYS false — host spawn is not isolated
  supports_pass: false,

  // Isolation properties — all false/none for host spawn
  container_runtime: "none",
  runtime_version: null,
  network_disabled: false,
  non_root: false,
  read_only_rootfs: false,
  resource_limits: {
    cpu_shares: null,
    memory_mb: null,
    pids_limit: null,
    wall_clock_ms: true,  // wall-clock timeout enforced by JS timer
    output_bytes: true,   // output truncation enforced by JS
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
      container_runtime: this.container_runtime,
      runtime_version: this.runtime_version,
      network_disabled: this.network_disabled,
      non_root: this.non_root,
      read_only_rootfs: this.read_only_rootfs,
      resource_limits: this.resource_limits,
    };
  },

  /**
   * Run validation commands via host spawn.
   *
   * Delegates to the existing sandboxExecutor.runSandboxExecution().
   * The host executor always overrides the result to inconclusive with
   * reason host_spawn_not_isolated.
   *
   * @param {object} params
   * @param {Array<{path, content}>} params.files - patched source files
   * @param {string[]} params.commands - validation command identifiers
   * @param {object} params.limits - resource limits
   * @param {string} params.sandbox_image_digest - pinned digest
   * @returns {Promise<object>} execution result
   */
  async run({ files, commands, limits, sandbox_image_digest }) {
    return runSandboxExecution({ files, commands, limits, sandbox_image_digest });
  },
};

// Validate at module load — fail fast on contract violations
validateBackendContract(nodeExecutorBackend);

export default nodeExecutorBackend;
export { nodeExecutorBackend };
