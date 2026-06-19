// src/lib/executorBackend.js
// Executor backend abstraction for sandboxed repair validation.
//
// Defines the contract that all executor backends must satisfy.
// Each backend describes its isolation properties and implements a run()
// method that executes validation commands against a file set.
//
// Backend properties are bound into the execution receipt and verified
// by the governance gate before any receipt can authorize a lifecycle
// transition (verified, review_ready).
//
// ┌──────────────────────────────────────────────────────────────────┐
// │                  ExecutorBackend Contract                        │
// ├──────────────────────────────────────────────────────────────────┤
// │                                                                  │
// │  id                 string    unique backend identifier          │
// │  version            string    semantic version                   │
// │  image_digest       string    sha256:... pinned image/version    │
// │  supports_pass      boolean   can this backend authorize pass?   │
// │  container_runtime  string    "docker" | "podman" | "none"       │
// │  runtime_version    string|null detected runtime version         │
// │  network_disabled   boolean   true if network is blocked         │
// │  non_root           boolean   true if runs as non-root uid       │
// │  read_only_rootfs   boolean   true if rootfs is read-only        │
// │  resource_limits    object    kernel-enforced limits descriptor  │
// │                                                                  │
// │  describe() → object    returns isolation binding for receipt    │
// │  run({files, commands, limits, image_digest}) → ExecResult       │
// │                                                                  │
// └──────────────────────────────────────────────────────────────────┘
//
// ExecResult shape:
//   overall: "pass" | "fail" | "inconclusive"
//   command_results: Array<{ command, exit_status, output_ref, output_hash, duration_ms, ... }>
//   aggregate_exit_status: number | null
//   inconclusive_reason?: string
//   inconclusive_detail?: string

/**
 * Validate that an object satisfies the ExecutorBackend contract.
 * Throws on any missing or invalid field.
 *
 * @param {object} backend
 * @throws {Error} if the backend does not satisfy the contract
 */
export function validateBackendContract(backend) {
  const required = [
    "id", "version", "image_digest", "supports_pass",
    "container_runtime", "network_disabled", "non_root",
    "read_only_rootfs", "resource_limits",
  ];

  for (const field of required) {
    if (backend[field] === undefined || backend[field] === null) {
      throw new Error(`ExecutorBackend '${backend.id || "unknown"}' missing required field: ${field}`);
    }
  }

  if (typeof backend.id !== "string" || backend.id.length === 0) {
    throw new Error("ExecutorBackend.id must be a non-empty string");
  }
  if (typeof backend.version !== "string" || backend.version.length === 0) {
    throw new Error("ExecutorBackend.version must be a non-empty string");
  }
  if (typeof backend.image_digest !== "string" || !backend.image_digest.startsWith("sha256:")) {
    throw new Error("ExecutorBackend.image_digest must be sha256:...");
  }
  if (typeof backend.supports_pass !== "boolean") {
    throw new Error("ExecutorBackend.supports_pass must be a boolean");
  }
  if (typeof backend.container_runtime !== "string") {
    throw new Error("ExecutorBackend.container_runtime must be a string");
  }
  if (typeof backend.network_disabled !== "boolean") {
    throw new Error("ExecutorBackend.network_disabled must be a boolean");
  }
  if (typeof backend.non_root !== "boolean") {
    throw new Error("ExecutorBackend.non_root must be a boolean");
  }
  if (typeof backend.read_only_rootfs !== "boolean") {
    throw new Error("ExecutorBackend.read_only_rootfs must be a boolean");
  }
  if (typeof backend.resource_limits !== "object") {
    throw new Error("ExecutorBackend.resource_limits must be an object");
  }
  if (typeof backend.describe !== "function") {
    throw new Error("ExecutorBackend.describe must be a function");
  }
  if (typeof backend.run !== "function") {
    throw new Error("ExecutorBackend.run must be a function");
  }
}

/**
 * Allowlist of valid container runtimes.
 */
export const VALID_CONTAINER_RUNTIMES = new Set([
  "none",      // host spawn (no container)
  "docker",    // Docker Engine
  "podman",    // Podman (daemonless)
]);

/**
 * Validate that an isolation binding object has all required fields
 * for receipt construction.
 *
 * @param {object} binding
 * @throws {Error} if any field is missing or invalid
 */
export function validateIsolationBinding(binding) {
  const required = [
    "execution_backend_id", "executor_version", "sandbox_image_digest",
    "container_runtime", "runtime_version", "network_disabled",
    "non_root", "read_only_rootfs", "resource_limits",
  ];

  for (const field of required) {
    if (binding[field] === undefined) {
      throw new Error(`Isolation binding missing required field: ${field}`);
    }
  }

  if (!VALID_CONTAINER_RUNTIMES.has(binding.container_runtime)) {
    throw new Error(
      `Isolation binding container_runtime '${binding.container_runtime}' is not in ${[...VALID_CONTAINER_RUNTIMES].join(", ")}`
    );
  }

  if (typeof binding.network_disabled !== "boolean") {
    throw new Error("Isolation binding network_disabled must be boolean");
  }

  if (typeof binding.non_root !== "boolean") {
    throw new Error("Isolation binding non_root must be boolean");
  }

  if (typeof binding.read_only_rootfs !== "boolean") {
    throw new Error("Isolation binding read_only_rootfs must be boolean");
  }

  if (typeof binding.resource_limits !== "object") {
    throw new Error("Isolation binding resource_limits must be an object");
  }
}
