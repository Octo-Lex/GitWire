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
import { probeContainerRuntime } from "./executorReachability.js";

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

// ── Test-injectable reachability probe ──────────────────────────────────────
// getDefaultBackend() needs to know whether container-runtime is reachable to
// make auto-selection honest. The real probe shells out to `docker --version`,
// which is non-deterministic in tests (Docker may or may not be installed).
// This seam lets tests override the probe for deterministic coverage of both
// branches. Production code leaves it null → uses the real probeContainerRuntime.
let _containerRuntimeProbeOverride = null;

/**
 * Test-only seam: override the container-runtime reachability probe.
 * Pass `null` to restore the real probe.
 *
 * @param {(() => { reachable: boolean, runtime: string|null }) | null} probe
 */
export function _setContainerRuntimeProbeForTests(probe) {
  _containerRuntimeProbeOverride = probe;
}

function containerRuntimeReachable() {
  const probe = _containerRuntimeProbeOverride || probeContainerRuntime;
  return Boolean(probe().reachable);
}

/**
 * Get the default backend, reachability-honest for AUTO-selection (Gap 1 fix #4).
 *
 * v0.21.0 claimed reachability-aware selection but the body just returned
 * the configured/registered backend without probing. On CT 115 that meant
 * docker-executor was silently selected even though the app container has
 * no Docker socket — the failure only surfaced later as an ambiguous
 * executor error.
 *
 * Selection contract (per Task 7.5 spec):
 *
 *   EXPLICIT selection (GITWIRE_EXECUTOR_BACKEND set to a registered id):
 *     The operator named a backend. Return it as-is. Explicit selection is
 *     NOT reachability-aware — the runner's pass-capability logic (Task 7)
 *     safely downgrades the receipt when the runtime is unreachable, so
 *     selection itself stays simple and predictable.
 *
 *   AUTO selection (no GITWIRE_EXECUTOR_BACKEND, or set to an unknown id):
 *     Reachability-aware. Prefer docker-executor when container-runtime is
 *     reachable; otherwise fall back to node-executor (always available).
 *
 *   Unknown configured backend: NOT a hard error. Falls through to
 *     reachability-aware auto-selection (fail-safe fallback, never throws).
 *
 * Explicit getBackend(id) is unchanged; callers who know they want a
 * specific backend can still request it directly.
 *
 * @returns {object} — never throws (node-executor is always available)
 */
export function getDefaultBackend() {
  const configuredId = process.env.GITWIRE_EXECUTOR_BACKEND;

  // EXPLICIT selection: if the operator named a registered backend, honor it.
  // Reachability is handled downstream (runner + receipt + gate), not here.
  if (configuredId && registry.has(configuredId)) {
    return registry.get(configuredId);
  }

  // AUTO selection (no configured id, or configured id not registered):
  // reachability-aware. Prefer docker-executor when a runtime is reachable,
  // otherwise the always-available node-executor fallback.
  if (containerRuntimeReachable() && registry.has("docker-executor")) {
    return registry.get("docker-executor");
  }
  return registry.get("node-executor");
}

// ── Register built-in backends ──────────────────────────────────────────

registerBackend(nodeExecutorBackend);
registerBackend(dockerExecutorBackend);
