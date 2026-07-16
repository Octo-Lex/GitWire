// packages/executor-service/src/health.js
// /health response builder (v0.23.0 Task 2, step 6).
//
// buildHealthResponse() is PURE: it takes {config, probeResult} and returns
// the JSON-able health object. The HTTP server (server.js) just wires HTTP
// to this builder. This keeps the response shape testable without binding a
// port or depending on Docker.
//
// Per the design doc, `ready` is true ONLY when:
//   - the runtime probe reports reachable, AND
//   - validator image identity is complete (both ref + digest set).
//
// `status` stays "ok" even when ready=false — mirrors gitwire-app /health,
// where a process that can answer at all is alive (liveness), and the body
// fields reflect deeper readiness. Operators watch `ready`, load balancers
// watch the HTTP 200.

import { randomUUID } from "node:crypto";

// Per-process instance id. Stable within a process lifetime so operators can
// tell whether /health is being served by the same instance across calls.
// Regenerated only on restart.
const INSTANCE_ID = randomUUID();

/**
 * Build the /health response object from config + a probe result.
 *
 * @param {object} params
 * @param {object} params.config - the frozen config from loadExecutorServiceConfig()
 * @param {{reachable: boolean, container_runtime: string|null, runtime_version: string|null}} params.probeResult
 * @returns {object} JSON-able health object (NOT frozen — Express/json middleware serializes it)
 */
export function buildHealthResponse({ config, probeResult }) {
  const runtimeReachable = Boolean(probeResult && probeResult.reachable);
  const identityComplete = Boolean(config.validatorIdentityComplete());

  // ready requires BOTH runtime reachability AND complete validator identity.
  // Missing either → ready=false. This is the load-bearing readiness signal.
  const ready = runtimeReachable && identityComplete;

  return {
    status: "ok", // liveness-safe; ready reflects deeper readiness
    git_sha: config.git_sha || "unknown",
    built_at: config.built_at || "unknown",
    executor_service_id: config.executor_service_id,
    executor_service_version: config.executor_service_version,
    executor_service_instance_id: INSTANCE_ID,
    deployment_mode: config.deployment_mode,
    container_runtime: probeResult ? probeResult.container_runtime : null,
    runtime_version: probeResult ? probeResult.runtime_version : null,
    validator_image_ref: config.validator_image_ref,
    validator_image_digest: config.validator_image_digest,
    ready,
  };
}
