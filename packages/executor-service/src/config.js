// packages/executor-service/src/config.js
// Configuration loader for the executor service (v0.23.0 Task 2).
//
// Reads env vars and returns a frozen config object. The loader's job is
// PARSING, not policy: missing required values come back as null so /health
// can report ready=false rather than crash on boot. The runtime probe +
// validator-identity check decide readiness, not the config loader.
//
// All env vars are optional at boot. The service starts even when validator
// identity is unconfigured — it just reports ready=false until an operator
// sets GITWIRE_VALIDATOR_IMAGE_REF + _DIGEST.

// Stable backend identifier. Matches BACKEND_ID_TO_KIND in the app's
// executorReachability.js ("executor-service" → container-runtime).
const EXECUTOR_SERVICE_ID = "executor-service";

// Valid deployment modes. deployment_mode is observability-only — it never
// participates in pass-capability derivation, verifier branching, or policy.
const VALID_DEPLOYMENT_MODES = Object.freeze(["compose-local", "remote", "vm"]);

const DEFAULT_DEPLOYMENT_MODE = "compose-local";
const DEFAULT_PORT = 3003;
const DEFAULT_VERSION = "1.0.0";

/**
 * Load and validate executor-service config from environment.
 *
 * @returns {Readonly<object>} frozen config with validatorIdentityComplete() helper
 * @throws {Error} on unrecoverable parse errors (bad PORT, unknown deployment_mode)
 */
export function loadExecutorServiceConfig() {
  // ── deployment_mode (observability only) ────────────────────────────────
  const deployment_mode = process.env.EXECUTOR_DEPLOYMENT_MODE || DEFAULT_DEPLOYMENT_MODE;
  if (!VALID_DEPLOYMENT_MODES.includes(deployment_mode)) {
    throw new Error(
      `Invalid EXECUTOR_DEPLOYMENT_MODE '${deployment_mode}'. ` +
      `Must be one of: ${VALID_DEPLOYMENT_MODES.join(", ")}`
    );
  }

  // ── port ────────────────────────────────────────────────────────────────
  const portRaw = process.env.PORT !== undefined ? process.env.PORT : String(DEFAULT_PORT);
  const port = Number.parseInt(portRaw, 10);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(
      `Invalid PORT '${portRaw}'. Must be an integer in 1..65535.`
    );
  }

  // ── service identity ────────────────────────────────────────────────────
  const executor_service_id = EXECUTOR_SERVICE_ID;
  const executor_service_version = process.env.GITWIRE_EXECUTOR_SERVICE_VERSION || DEFAULT_VERSION;

  // ── auth token (shared with app; null when unset, NOT a boot error) ─────
  const service_token = process.env.GITWIRE_EXECUTOR_SERVICE_TOKEN || null;

  // ── validator image identity (null when unset; readiness decides) ───────
  const validator_image_ref = process.env.GITWIRE_VALIDATOR_IMAGE_REF || null;
  const validator_image_digest = process.env.GITWIRE_VALIDATOR_IMAGE_DIGEST || null;

  // ── build identity (from Dockerfile ENV; normalize missing to "unknown") ─
  const git_sha = process.env.GITWIRE_COMMIT_SHA || "unknown";
  const built_at = process.env.GITWIRE_BUILT_AT || "unknown";

  /**
   * True only when both ref and digest are set. Used by /health to compute
   * `ready`. Does NOT cross-check the ref's embedded digest against the
   * standalone digest — that's the runtime probe's job (it inspects the
   * actual image and returns inspected_image_digest for the app to verify).
   */
  function validatorIdentityComplete() {
    return Boolean(validator_image_ref) && Boolean(validator_image_digest);
  }

  return Object.freeze({
    executor_service_id,
    executor_service_version,
    deployment_mode,
    port,
    service_token,
    validator_image_ref,
    validator_image_digest,
    git_sha,
    built_at,
    validatorIdentityComplete,
    valid_deployment_modes: VALID_DEPLOYMENT_MODES,
  });
}
