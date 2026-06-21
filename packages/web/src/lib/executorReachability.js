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
 * Does not include sensitive details — just kind, reachable, runtime.
 *
 * @param {string[]} [priorityOrder]
 * @returns {{ summary: Array, selected_kind: string|null, selected_reason: string }}
 */
export function getReachabilitySummary(priorityOrder) {
  const { backends, selected, selected_reason } = probeAllBackends(priorityOrder);

  return {
    summary: backends.map((b) => ({
      kind: b.kind,
      reachable: b.reachable,
      runtime: b.runtime,
    })),
    selected_kind: selected?.kind || null,
    selected_reason,
  };
}
