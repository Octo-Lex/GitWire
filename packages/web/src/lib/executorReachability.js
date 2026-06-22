// src/lib/executorReachability.js
// Executor backend reachability and selection layer (v0.21.0).
//
// This module answers: "Which executor backend is reachable, which is selected,
// and what evidence proves that selection?" It sits on top of the existing
// executorRegistry and adds:
//
// 1. ExecutorKind taxonomy (local-process / container-runtime / delegated-run)
// 2. Reachability probes (is the backend actually available right now?)
// 3. Selection policy (config-driven priority order)
// 4. Health summary (externally observable without SSH)
//
// Design principle: Docker socket unavailable does NOT produce ambiguous
// failure. GitWire records a typed reason and selects an alternative or
// fails closed.

import { execSync } from "node:child_process";
import { resolveValidatorImage } from "./validatorImage.js";

// Lazy logger — avoids runtime init requirement in tests
let _logger = null;
function getLogger() {
  if (!_logger) {
    try {
      // Dynamic require pattern that doesn't crash if runtime isn't initialized
      _logger = {
        info: (obj, msg) => console.debug(`[executorReachability] ${msg}`, obj),
        warn: (obj, msg) => console.warn(`[executorReachability] ${msg}`, obj),
      };
    } catch {
      _logger = { info: () => {}, warn: () => {} };
    }
  }
  return _logger;
}

// ── Executor Kind taxonomy ──────────────────────────────────────────────────
export const EXECUTOR_KINDS = Object.freeze({
  LOCAL_PROCESS:     "local-process",      // nodeExecutorBackend — host spawn, no isolation
  CONTAINER_RUNTIME: "container-runtime",  // dockerExecutorBackend — Docker/Podman isolation
  DELEGATED_RUN:     "delegated-run",      // future: E2B/Modal/Anthropic Sandbox
});

// ── Backend ID → executor kind mapping ──────────────────────────────────────
// Single source of truth. Adding a new backend = adding one line here.
const BACKEND_ID_TO_KIND = Object.freeze({
  "node-executor":     EXECUTOR_KINDS.LOCAL_PROCESS,
  "docker-executor":   EXECUTOR_KINDS.CONTAINER_RUNTIME,
  "executor-service":  EXECUTOR_KINDS.CONTAINER_RUNTIME, // v0.23.0
});

/**
 * Map a registered executor backend id to its executor kind.
 * Throws on unknown ids — never silently default (fail-closed).
 *
 * @param {string} backendId - e.g. "node-executor", "docker-executor"
 * @returns {string} one of EXECUTOR_KINDS
 * @throws {Error} if the backend id is not known
 */
export function executorKindForBackendId(backendId) {
  const kind = BACKEND_ID_TO_KIND[backendId];
  if (!kind) {
    throw new Error(`executorKindForBackendId: unknown backend id '${backendId}'`);
  }
  return kind;
}

// ── Backend_id-level reachability (v0.23.0 Task 3 step 7, rev 3 amendment) ──
//
// PURE helper. The rev 3 design amendment: pass-capability derivation MUST be
// keyed by backend_id, not kind. The current sandboxRunner.js derives
// reachableKinds and checks reachableKinds.has(executorKind) — safe only
// because exactly one backend mapped to container-runtime. Now executor-service
// is registered alongside docker-executor, so a kind-keyed check would pass
// when EITHER backend was reachable even if the SELECTED one was down.
//
// This helper lets the runner derive backend_id-level reachability from a
// backend_id→probe map, decoupled from the kind-keyed /health summary (which
// stays stable for operator readability).

/**
 * Derive backend_id-level reachability for the SELECTED backend.
 *
 * @param {object} params
 * @param {string} params.selectedBackendId - the backend the runner will use
 * @param {Object<string, string>} params.backendKinds - { backend_id → kind }
 * @param {Object<string, {reachable: boolean}>} params.probes - { backend_id → probe }
 * @returns {{ backend_reachable: boolean, backend_id: string, kind: string }}
 * @throws {Error} if selectedBackendId is not in backendKinds (fail-closed)
 */
export function deriveBackendReachability({ selectedBackendId, backendKinds, probes }) {
  const kind = backendKinds[selectedBackendId];
  if (!kind) {
    throw new Error(
      `deriveBackendReachability: unknown backend id '${selectedBackendId}'`
    );
  }
  const probe = probes[selectedBackendId];
  // Missing probe entry → not reachable (fail-safe).
  const backend_reachable = Boolean(probe && probe.reachable);
  return { backend_reachable, backend_id: selectedBackendId, kind };
}

// ── Pass-capability derivation ───────────────────────────────────────────────
// Per-kind static capability crossed with observed reachability.
// local-process is NEVER pass-capable — it has no isolation boundary.
// container-runtime / delegated-run are pass-capable only when reachable.
const PASS_CAPABLE_KINDS = Object.freeze(new Set([
  EXECUTOR_KINDS.CONTAINER_RUNTIME,
  EXECUTOR_KINDS.DELEGATED_RUN,
]));

/**
 * Derive whether a backend kind is pass-capable given observed reachability.
 *
 * local-process → always false (no isolation boundary, per Gap 1 decision).
 * container-runtime → true only if reachable.
 * delegated-run → true only if reachable.
 *
 * @param {string} kind - one of EXECUTOR_KINDS
 * @param {boolean} reachable - observed reachability from the probe
 * @returns {boolean}
 * @throws {Error} on unknown kind (fail-closed — never silently pass-capable)
 */
export function isBackendPassCapable(kind, reachable) {
  if (!Object.values(EXECUTOR_KINDS).includes(kind)) {
    throw new Error(`isBackendPassCapable: unknown executor kind '${kind}'`);
  }
  if (kind === EXECUTOR_KINDS.LOCAL_PROCESS) return false;
  return Boolean(reachable);
}

// ── Reachability result shape ───────────────────────────────────────────────
// Each probe returns:
//   { reachable: boolean, kind: string, detail: string, probed_at: string }

/**
 * Probe whether Docker or Podman is reachable from the current process.
 * @returns {{ reachable: boolean, runtime: string|null, version: string|null, detail: string }}
 */
export function probeContainerRuntime() {
  for (const runtime of ["docker", "podman"]) {
    try {
      const version = execSync(`${runtime} --version`, {
        timeout: 5000,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      }).trim();
      return {
        reachable: true,
        runtime,
        version,
        detail: `${runtime} available: ${version}`,
      };
    } catch {
      // Try next runtime
    }
  }
  return {
    reachable: false,
    runtime: null,
    version: null,
    detail: "Neither docker nor podman found in PATH",
  };
}

/**
 * Probe whether the local Node.js process executor is available.
 * It's always available (it's just child_process.spawn), but it does not
 * provide isolation and cannot authorize pass.
 * @returns {{ reachable: boolean, detail: string }}
 */
export function probeLocalProcess() {
  return {
    reachable: true,
    runtime: "none",
    version: process.version,
    detail: `Node.js ${process.version} local executor always available (no isolation)`,
  };
}

/**
 * Probe a delegated-run provider (placeholder for future E2B/Modal/etc.).
 * Always returns unreachable in v0.21.0 — the interface exists so the
 * selection policy can include it in the priority order.
 * @returns {{ reachable: boolean, detail: string }}
 */
export function probeDelegatedRun() {
  return {
    reachable: false,
    runtime: null,
    version: null,
    detail: "No delegated-run provider configured (interface placeholder for future providers)",
  };
}

// ── Executor-service probe (v0.23.0 Task 3) ─────────────────────────────────
// The executor-service probe is async (HTTP) unlike the other probes (sync
// exec). It is invoked separately from probeAllBackends() — see the
// "Backend-level reachability" groundwork in step 7 for how it integrates
// with kind-keyed summary while preserving backend_id-level proof.

// Test-injectable client. null → use the real fetchExecutorServiceHealth
// reading from config. Mirrors the seam pattern from the other probes.
let _executorServiceClient = null;

/**
 * Test-only seam: inject a fake executor-service client.
 * Pass null to restore the real client.
 *
 * @param {(opts: {url, token}) => Promise<{reachable: boolean, ...}> | null} fn
 */
export function _setExecutorServiceClientForTests(fn) {
  _executorServiceClient = fn;
}

/**
 * Probe the executor service via HTTP GET /health.
 *
 * Reads GITWIRE_EXECUTOR_SERVICE_URL + _TOKEN from env (lazily, so the module
 * stays import-safe before config loads). Returns unreachable when the URL
 * is unset — the backend is registered but reports not-reachable until an
 * operator configures it. Never throws; failures become reachable:false.
 *
 * @returns {Promise<{ reachable: boolean, kind: string, runtime: string|null, version: string|null, detail: string }>}
 */
export async function probeExecutorService() {
  // When a test client is injected, skip the URL-config guard — the seam
  // exists precisely so tests can exercise the probe without setting env.
  // Production (seam = null) requires the URL to be configured.
  const url = process.env.GITWIRE_EXECUTOR_SERVICE_URL;
  if (!_executorServiceClient && !url) {
    return {
      reachable: false,
      kind: EXECUTOR_KINDS.CONTAINER_RUNTIME,
      runtime: null,
      version: null,
      detail: "GITWIRE_EXECUTOR_SERVICE_URL not configured",
    };
  }
  const token = process.env.GITWIRE_EXECUTOR_SERVICE_TOKEN;
  try {
    // Lazy dynamic import avoids a hard module-load cycle and keeps this
    // function resilient if the client module is ever split out.
    const client = _executorServiceClient ||
      (await import("./executorServiceClient.js")).fetchExecutorServiceHealth;
    const result = await client({ url, token });
    if (!result.reachable) {
      return {
        reachable: false,
        kind: EXECUTOR_KINDS.CONTAINER_RUNTIME,
        runtime: null,
        version: null,
        detail: result.detail || "executor service unreachable",
      };
    }
    return {
      reachable: true,
      kind: EXECUTOR_KINDS.CONTAINER_RUNTIME,
      runtime: result.container_runtime || null,
      version: result.runtime_version || null,
      detail: `executor service ${result.executor_service_id || ""} v${result.executor_service_version || "?"}`.trim(),
    };
  } catch (err) {
    return {
      reachable: false,
      kind: EXECUTOR_KINDS.CONTAINER_RUNTIME,
      runtime: null,
      version: null,
      detail: `executor service probe error: ${err?.message || "unknown"}`,
    };
  }
}

/**
 * Probe all registered backends and return a reachability summary.
 *
 * @param {string[]} [priorityOrder] — backend IDs in priority order (highest first).
 *   Defaults to: container-runtime > delegated-run > local-process
 *   (local-process is last because it cannot authorize pass).
 * @returns {{ backends: Array, selected: object|null, selected_reason: string }}
 */
export function probeAllBackends(priorityOrder) {
  const order = priorityOrder || [
    EXECUTOR_KINDS.CONTAINER_RUNTIME,
    EXECUTOR_KINDS.DELEGATED_RUN,
    EXECUTOR_KINDS.LOCAL_PROCESS,
  ];

  const results = {
    [EXECUTOR_KINDS.CONTAINER_RUNTIME]: probeContainerRuntime(),
    [EXECUTOR_KINDS.LOCAL_PROCESS]: probeLocalProcess(),
    [EXECUTOR_KINDS.DELEGATED_RUN]: probeDelegatedRun(),
  };

  const backends = order.map((kind) => ({
    kind,
    ...results[kind],
    probed_at: new Date().toISOString(),
  }));

  // Select the first reachable backend in priority order
  let selected = null;
  let selectedReason = "no_reachable_backend";

  for (const backend of backends) {
    if (backend.reachable) {
      selected = backend;
      selectedReason = `selected:${backend.kind}`;
      break;
    }
  }

  if (!selected) {
    selectedReason = "all_backends_unreachable";
    getLogger().warn(
      { backends: backends.map((b) => ({ kind: b.kind, reachable: b.reachable })) },
      "No executor backend reachable"
    );
  } else {
    getLogger().info({ selected: selected.kind, runtime: selected.runtime }, "Executor backend selected");
  }

  return { backends, selected, selected_reason: selectedReason };
}

/**
 * Get a compact reachability summary for /health or /readiness.
 * Includes per-backend pass-capability and the selected backend's
 * pass-capability so operators can tell whether the current deployment
 * can produce production-grade validator proof.
 *
 * @param {string[]} [priorityOrder]
 * @returns {{
 *   summary: Array<{kind: string, reachable: boolean, runtime: string|null, pass_capable: boolean}>,
 *   selected_kind: string|null,
 *   selected_reason: string,
 *   selected_pass_capable: boolean,
 * }}
 */
export function getReachabilitySummary(priorityOrder) {
  const { backends, selected, selected_reason } = probeAllBackends(priorityOrder);

  const summary = backends.map((b) => ({
    kind: b.kind,
    reachable: b.reachable,
    runtime: b.runtime,
    pass_capable: isBackendPassCapable(b.kind, b.reachable),
  }));

  const selected_pass_capable = selected
    ? isBackendPassCapable(selected.kind, selected.reachable)
    : false;

  return {
    summary,
    selected_kind: selected?.kind || null,
    selected_reason,
    selected_pass_capable,
  };
}

// ── Validator readiness ─────────────────────────────────────────────────────
// Typed reasons (never ambiguous empty strings). These are the externally
// observable answers to "can this deployment produce pass-capable validator
// evidence right now?"
export const VALIDATOR_READINESS_REASONS = Object.freeze({
  CONFIGURED_AND_PASS_CAPABLE:       "configured_and_pass_capable",
  SELECTED_BACKEND_NOT_PASS_CAPABLE: "selected_backend_not_pass_capable",
  VALIDATOR_IMAGE_NOT_CONFIGURED:    "validator_image_not_configured",
  NO_REACHABLE_BACKEND:              "no_reachable_backend",
});

/**
 * Async backend-level reachability summary (v0.23.0 Task 4, rev 3 amendment).
 *
 * This is the ASYNC companion to the sync getReachabilitySummary(). It
 * preserves the kind-keyed summary for dashboards/operators (same shape) but
 * adds two fields the rev 3 amendment requires for proof:
 *   - selected_backend_id        (which backend was selected)
 *   - selected_backend_reachable (whether THAT backend — not just its kind —
 *                                  is reachable; load-bearing for proof)
 *
 * Why async + separate from the sync summary: probeExecutorService() is HTTP
 * (async). Forcing the entire legacy reachability API async would churn
 * unrelated callers. Instead, deploymentInfo.js (already async) calls this
 * function; sync callers keep using getReachabilitySummary() unchanged.
 *
 * @param {object} [opts]
 * @param {object} [opts.selectedBackend] - the backend the app will use
 *   (defaults to getDefaultBackend() via lazy dynamic import to avoid a
 *   circular static import with executorRegistry.js)
 * @returns {Promise<object>} summary + selected_kind + selected_reason +
 *   selected_pass_capable + selected_backend_id + selected_backend_reachable
 */
export async function getBackendLevelSummary(opts = {}) {
  // Lazy dynamic import breaks the reachability → registry cycle at
  // module-load time. The registry statically imports reachability; if
  // reachability statically imported back, both modules would half-init.
  const { getDefaultBackend, listBackends } = await import("./executorRegistry.js");
  const selectedBackend = opts.selectedBackend || getDefaultBackend();
  const selectedBackendId = selectedBackend.id;

  // Sync kind-keyed summary (unchanged shape; dashboards keep working).
  const sync = getReachabilitySummary();

  // Build the backend_id → probe map. Sync probes for node/docker run inline;
  // the async executor-service probe is awaited here.
  const backendKinds = {};
  for (const id of listBackends()) {
    try {
      backendKinds[id] = executorKindForBackendId(id);
    } catch {
      // Unknown id in registry but not in BACKEND_ID_TO_KIND — skip.
    }
  }

  const probes = {};
  // Sync probes (the kind-level signals).
  const allSync = probeAllBackends();
  for (const b of allSync.backends) {
    // Map kind → backend_id for the sync probed kinds. For LOCAL_PROCESS and
    // CONTAINER_RUNTIME (docker), the kind-level probe IS the backend signal
    // because there's only one sync backend per kind. (executor-service is
    // handled separately below as the async container-runtime backend.)
    for (const id of Object.keys(backendKinds)) {
      if (backendKinds[id] === b.kind && id !== "executor-service") {
        probes[id] = { reachable: b.reachable };
      }
    }
  }
  // Async probe for executor-service (if registered).
  if (backendKinds["executor-service"]) {
    probes["executor-service"] = await probeExecutorService();
  }

  // Backend_id-level reachability for the SELECTED backend (rev 3 amendment).
  const { backend_reachable } = deriveBackendReachability({
    selectedBackendId,
    backendKinds,
    probes,
  });

  // P2 review fix: derive ALL selected_* fields from the SELECTED backend,
  // not from the sync kind-level summary. Before this fix, a deployment with
  // GITWIRE_EXECUTOR_BACKEND=executor-service + service reachable + no local
  // Docker would emit contradictory state:
  //   selected_backend_id        = executor-service
  //   selected_backend_reachable = true
  //   selected_kind              = local-process       ← WRONG (from sync)
  //   selected_pass_capable      = false               ← WRONG (from sync)
  // The sync summary's selected_* reflect the kind-level selection (which
  // falls back to local-process when Docker is unreachable), NOT the
  // backend-level selection. Overriding them here keeps /health internally
  // consistent: every selected_* field derives from selectedBackendId.
  const selected_kind = backendKinds[selectedBackendId];
  const selected_pass_capable = isBackendPassCapable(selected_kind, backend_reachable);
  const selected_reason = `selected:${selectedBackendId}`;

  return {
    // Keep the kind-keyed summary array for dashboards/operators (unchanged
    // shape — the per-backend reachable/pass_capable list is still useful).
    summary: sync.summary,
    // Override the selected_* fields so they reflect the backend-level
    // selection, not the sync kind-level fallback.
    selected_kind,
    selected_reason,
    selected_pass_capable,
    selected_backend_id: selectedBackendId,
    selected_backend_reachable: backend_reachable,
  };
}

/**
 * Produce the validator readiness block for /health.
 *
 * Composes the executor pass-capability view with validator image
 * configuration. The result answers: "Can this deployment produce
 * production-grade validator proof?"
 *
 * IMPORTANT — `configured` and `pass_capable` are INDEPENDENT signals:
 *   configured   = "is the validator image identity set in config?"
 *   pass_capable = "can the currently-selected backend actually produce pass proof?"
 * A deployment can be configured=true but pass_capable=false (image set, but
 * local-process selected). Operators need both signals; collapsing them hides
 * the "you configured it, but the runtime can't honor it" case.
 *
 * @param {object} [executorSummary] - optional executor summary to derive
 *   selected_kind/selected_pass_capable from. v0.23.0 Task 4 P2 fix: when
 *   /health has already computed the backend-level summary (which derives
 *   selected_* from selectedBackendId, not from the sync kind-level fallback),
 *   pass it here so validator readiness uses the SAME selection. When omitted,
 *   falls back to the sync getReachabilitySummary() (backward compat).
 * @returns {{ configured: boolean, pass_capable: boolean, reason: string }}
 */
export function getValidatorReadiness(executorSummary) {
  // P2 review fix: prefer the passed-in backend-level summary (which derives
  // selected_* from selectedBackendId); fall back to the sync summary only
  // when no summary was passed (backward compat for non-/health callers).
  const { selected_kind, selected_pass_capable } = executorSummary || getReachabilitySummary();

  // Read validator image config via the dedicated resolver so the
  // "is it configured?" signal is the SAME definition used by the receipt
  // path. Top-of-file static import.
  const validatorImage = resolveValidatorImage();
  const configured = Boolean(validatorImage.configured);

  // No reachable backend at all → not pass-capable. configured is still
  // reported independently (operator may have set the image even though
  // nothing is reachable).
  if (!selected_kind) {
    return {
      configured,
      pass_capable: false,
      reason: VALIDATOR_READINESS_REASONS.NO_REACHABLE_BACKEND,
    };
  }

  // Backend reachable but not pass-capable (e.g. local-process on CT 115).
  // Report configured independently — this is the key operator signal.
  if (!selected_pass_capable) {
    return {
      configured,
      pass_capable: false,
      reason: VALIDATOR_READINESS_REASONS.SELECTED_BACKEND_NOT_PASS_CAPABLE,
    };
  }

  // Backend IS pass-capable. Now the deciding factor is validator image
  // identity. If it's not configured, we're reachable-and-isolated but
  // have nothing pinned to run.
  if (!configured) {
    return {
      configured: false,
      pass_capable: false,
      reason: VALIDATOR_READINESS_REASONS.VALIDATOR_IMAGE_NOT_CONFIGURED,
    };
  }

  return {
    configured: true,
    pass_capable: true,
    reason: VALIDATOR_READINESS_REASONS.CONFIGURED_AND_PASS_CAPABLE,
  };
}
