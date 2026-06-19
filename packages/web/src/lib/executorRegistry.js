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
 * Currently node-executor (non-isolated, development).
 * Will be configurable via environment variable.
 *
 * @returns {object}
 */
export function getDefaultBackend() {
  const defaultId = process.env.GITWIRE_EXECUTOR_BACKEND || "node-executor";
  return getBackend(defaultId);
}

// ── Register built-in backends ──────────────────────────────────────────

registerBackend(nodeExecutorBackend);
registerBackend(dockerExecutorBackend);
