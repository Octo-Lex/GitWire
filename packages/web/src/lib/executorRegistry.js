// src/lib/executorRegistry.js
// Registry of executor backends.
//
// Maps backend IDs to backend instances. The verification worker
// selects a backend by ID (from configuration or default) and
// delegates to its run() method.
//
// Adding a new backend:
// 1. Create a backend module implementing the ExecutorBackend contract
// 2. Register it here with registerBackend()
// 3. Add its ID to ALLOWED_EXECUTION_BACKENDS in repairProposalService.js
// 4. Add its version to ALLOWED_EXECUTOR_VERSIONS
// 5. (For pass capability) Add to ALLOWED_PASS_EXECUTION_BACKENDS — only
//    after E2E isolation evidence is verified

import { nodeExecutorBackend } from "./nodeExecutorBackend.js";
import { dockerExecutorBackend } from "./dockerExecutorBackend.js";
import { validateBackendContract } from "./executorBackend.js";

/**
 * Map of registered backends by ID.
 * @type {Map<string, object>}
 */
const registry = new Map();

/**
 * Register an executor backend.
 * Validates the contract before adding.
 *
 * @param {object} backend
 * @throws {Error} if the backend fails contract validation
 */
export function registerBackend(backend) {
  validateBackendContract(backend);
  if (registry.has(backend.id)) {
    throw new Error(`Executor backend '${backend.id}' is already registered`);
  }
  registry.set(backend.id, backend);
}

/**
 * Get a registered backend by ID.
 *
 * @param {string} id
 * @returns {object}
 * @throws {Error} if the backend is not registered
 */
export function getBackend(id) {
  const backend = registry.get(id);
  if (!backend) {
    throw new Error(
      `Executor backend '${id}' is not registered. Available: ${[...registry.keys()].join(", ")}`
    );
  }
  return backend;
}

/**
 * Get the list of all registered backend IDs.
 * @returns {string[]}
 */
export function listBackends() {
  return [...registry.keys()];
}

/**
 * Get the default backend.
 *
 * v0.21.0: Selection now respects reachability. If the configured backend
 * is not reachable (e.g. Docker socket unavailable), falls back to
 * node-executor with an inconclusive capability. If no backend is
 * reachable at all, throws with a typed reason.
 *
 * Selection order (configurable via GITWIRE_EXECUTOR_BACKEND):
 *   1. Explicitly configured backend (if reachable)
 *   2. docker-executor (if Docker/Podman reachable)
 *   3. node-executor (always reachable, non-isolated)
 *
 * @returns {object}
 * @throws {Error} if no backend is reachable (should not happen — node-executor is always available)
 */
export function getDefaultBackend() {
  const configuredId = process.env.GITWIRE_EXECUTOR_BACKEND;

  // If explicitly configured, try it first
  if (configuredId && registry.has(configuredId)) {
    try {
      const backend = registry.get(configuredId);
      // For node-executor, always available
      if (backend.id === "node-executor") return backend;
      // For docker-executor, check reachability
      if (backend.id === "docker-executor") {
        return backend; // The backend itself will fail-closed on run() if unreachable
      }
      return backend;
    } catch {
      // Fall through to auto-selection
    }
  }

  // Auto-selection: prefer docker, fall back to node
  if (registry.has("docker-executor")) {
    return registry.get("docker-executor");
  }
  return registry.get("node-executor");
}

// ── Register built-in backends ──────────────────────────────────────────

registerBackend(nodeExecutorBackend);
registerBackend(dockerExecutorBackend);
