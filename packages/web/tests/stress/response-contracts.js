// packages/web/tests/stress/response-contracts.js
//
// GitWire-specific response-contract policy and operation constructors.
//
// This module holds route-specific status catalogs and the convenience
// constructor that couples apiBurstOperation with a responseContract.
// The generic semantic engine (runContractedBurst, enrichResult,
// preflightContracts) lives in burst-runner.js — this module is policy,
// not engine.

import { apiBurstOperation } from "../helpers.js";

/**
 * Frozen status-set constants for HTTP classification. These encode HTTP
 * status policy only — not retry, skip, assertion applicability, or body
 * semantics. Each is deeply frozen to prevent accidental mutation.
 *
 * FIX_ATTEMPT_LEGACY_OUTCOMES is a visible legacy exception: the fix-attempt
 * route currently accepts very broad outcomes including 500. The name makes
 * the concession visible for tightening during functional qualification.
 */
export const STATUS_SETS = Object.freeze({
  READ_OK: Object.freeze([200]),
  READ_OK_OR_RATE_LIMITED: Object.freeze([200, 429]),
  READ_OK_OR_NOT_FOUND_OR_RATE_LIMITED: Object.freeze([200, 404, 429]),
  MUTATION_ACCEPTED: Object.freeze([200, 201, 202]),
  MUTATION_TRIGGER: Object.freeze([200, 201, 202, 204]),
  MUTATION_ACCEPTED_OR_NOT_FOUND: Object.freeze([200, 201, 202, 404]),
  MUTATION_ACCEPTED_OR_BAD_REQUEST_OR_NOT_FOUND: Object.freeze([200, 201, 202, 400, 404]),
  FIX_ATTEMPT_LEGACY_OUTCOMES: Object.freeze([200, 202, 400, 404, 429, 500]),
});

/**
 * Construct a contracted operation descriptor for use with runContractedBurst
 * or runContractedOperation. Wraps apiBurstOperation (which uses
 * prepareApiRequest for PR1 isolation) and attaches a responseContract.
 *
 * @param {string} path
 * @param {Object} options
 * @param {string} [options.kind]
 * @param {string} [options.method="GET"]
 * @param {Object} [options.body]
 * @param {string} [options.contractName] required for mutations
 * @param {"none"|"text"|"json"|"auto"} [options.bodyMode="auto"]
 * @param {boolean} [options.omitAuth=false]
 * @param {number[]} [options.expectedStatuses] if omitted, all transport-completed are expected
 * @param {number[]} [options.assertOnStatuses] restricts which statuses trigger assert
 * @param {Function} [options.assert] semantic assertion callback
 * @returns {{ kind, method, run, responseContract }}
 */
export function apiContractedOperation(path, options = {}) {
  const burst = apiBurstOperation(path, {
    kind: options.kind,
    method: options.method,
    body: options.body,
    contractName: options.contractName,
    bodyMode: options.bodyMode,
    omitAuth: options.omitAuth,
  });
  const responseContract = {};
  if (options.expectedStatuses) {
    responseContract.expectedStatuses = options.expectedStatuses;
  }
  if (options.assertOnStatuses) {
    responseContract.assertOnStatuses = options.assertOnStatuses;
  }
  if (options.assert) {
    responseContract.assert = options.assert;
  }
  return {
    kind: burst.kind,
    method: burst.method,
    run: burst.run,
    responseContract,
  };
}
