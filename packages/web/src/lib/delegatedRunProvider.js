// src/lib/delegatedRunProvider.js
// Vendor-neutral delegated-run provider contract (Gap 1 Phase 4).
//
// A delegated-run provider executes validator jobs OUTSIDE the app container,
// avoiding the CT 115 Docker-in-LXC constraint. The provider returns a
// receipt-bound run that GitWire maps to pass/fail/inconclusive.
//
// This module defines the CONTRACT only. No concrete provider is enabled.
// NullDelegatedRunProvider is the placeholder used when no provider is
// configured — it always produces inconclusive results with a typed reason.
//
// Per docs/architecture/validator-execution-model.md (Phase 4), the minimum
// contract is:
//   submit validation job   → receive provider run id
//   retrieve logs/artifacts
//   verify receipt hash
//   map provider result to pass/fail/inconclusive

// Required provider operations + the id field.
export const DELEGATED_RUN_PROVIDER_CONTRACT = Object.freeze([
  "id",
  "submitValidationJob",
  "retrieveRun",
  "verifyReceiptHash",
  "mapResult",
]);

// Valid mapped results (mirrors the executor result vocabulary).
const VALID_MAPPED_RESULTS = new Set(["pass", "fail", "inconclusive"]);

/**
 * Validate that an object satisfies the delegated-run provider contract.
 * Throws on any missing field or invalid mapResult output.
 *
 * @param {object} provider
 * @throws {Error} on contract violation
 */
export function validateDelegatedRunProvider(provider) {
  if (!provider || typeof provider !== "object") {
    throw new Error("validateDelegatedRunProvider: provider must be an object");
  }

  for (const field of DELEGATED_RUN_PROVIDER_CONTRACT) {
    if (provider[field] === undefined) {
      throw new Error(`validateDelegatedRunProvider: missing required field: ${field}`);
    }
  }

  if (typeof provider.id !== "string" || provider.id.length === 0) {
    throw new Error("validateDelegatedRunProvider: id must be a non-empty string");
  }
  for (const fn of ["submitValidationJob", "retrieveRun", "verifyReceiptHash", "mapResult"]) {
    if (typeof provider[fn] !== "function") {
      throw new Error(`validateDelegatedRunProvider: ${fn} must be a function`);
    }
  }

  // mapResult must return one of the valid mapped values for a representative
  // input — this catches providers that return arbitrary strings.
  const sample = provider.mapResult({});
  if (!VALID_MAPPED_RESULTS.has(sample)) {
    throw new Error(
      `validateDelegatedRunProvider: mapResult must return pass|fail|inconclusive (got '${sample}')`
    );
  }
}

/**
 * The null/placeholder provider. Used when no concrete delegated-run provider
 * is configured. Always produces inconclusive results with a typed reason —
 * never pass, never fail, never an ambiguous error.
 *
 * SAFETY INVARIANT: this provider NEVER maps anything to "pass". Pass-capable
 * delegated-run execution requires a real, configured provider with
 * receipt-bound evidence. The null provider is a non-pass-capable placeholder
 * by design.
 */
export const NullDelegatedRunProvider = Object.freeze({
  id: "null-delegated-run-provider",

  /**
   * @returns {Promise<{ overall: "inconclusive", inconclusive_reason: string }>}
   */
  async submitValidationJob(_job) {
    return {
      overall: "inconclusive",
      inconclusive_reason: "no_delegated_run_provider_configured",
    };
  },

  /**
   * @returns {Promise<{ logs: null, artifacts: never[] }>}
   */
  async retrieveRun(_runId) {
    return { logs: null, artifacts: [] };
  },

  /**
   * No provider is configured, so there is no receipt to verify.
   * @returns {Promise<boolean>}
   */
  async verifyReceiptHash(_run) {
    return false;
  },

  /**
   * @returns {"inconclusive"}
   */
  mapResult(_providerResult) {
    return "inconclusive";
  },
});

// Self-validate at module load — catches contract drift immediately.
validateDelegatedRunProvider(NullDelegatedRunProvider);
