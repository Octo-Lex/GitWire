// src/lib/validatorReceiptGate.js
// Pure Gap 1 validator receipt gate checks (checks 3f-3j).
//
// Extracted from verifyExecutionReceiptAgainstLockedProposal() so the pass
// gate's Gap 1 logic is unit-testable without a DB. The verifier imports and
// calls validateGap1ValidatorBindings(receipt); this module owns the rules.
//
// A pass receipt is accepted only when ALL of:
//   3f. executor_kind is present and NOT local-process
//   3g. executor_pass_capable === true
//   3h. validator_image_ref is present and digest-pinned
//   3i. validator_image_digest is present
//   3j. validator_result_status === "pass"
//
// IMPORTANT: this helper validates PASS receipts only. The caller
// (verifyExecutionReceiptAgainstLockedProposal) is itself only invoked from
// the pass path (see repairProposalService.js ~line 2163: guarded by
// `if (result === "pass")`). Non-pass receipts (inconclusive/fail) legitimately
// lack validator identity — e.g. a local-process diagnostic receipt — and must
// NOT be routed through this helper. Calling it on a non-pass receipt would
// wrongly reject valid diagnostic evidence.

import { isDigestPinned } from "./imageReference.js";

/**
 * Validate the Gap 1 validator bindings on a pass receipt.
 * Throws on any violation; returns nothing on success.
 *
 * Intended exclusively for pass receipts. See module header.
 *
 * @param {object} receipt - parsed execution receipt object
 * @throws {Error} on any Gap 1 binding violation
 */
export function validateGap1ValidatorBindings(receipt) {
  if (!receipt || typeof receipt !== "object") {
    throw new Error("validateGap1ValidatorBindings: receipt must be an object");
  }

  // 3f. executor_kind present and not local-process.
  if (!receipt.executor_kind) {
    throw new Error(
      "Execution receipt missing executor_kind — pass requires Gap 1 executor binding"
    );
  }
  if (receipt.executor_kind === "local-process") {
    throw new Error(
      "Execution receipt executor_kind is local-process — local-process cannot authorize pass"
    );
  }

  // 3g. executor_pass_capable must be exactly true.
  if (receipt.executor_pass_capable !== true) {
    throw new Error(
      "Execution receipt executor_pass_capable must be true for a pass receipt"
    );
  }

  // 3h. validator_image_ref present and digest-pinned.
  if (!receipt.validator_image_ref) {
    throw new Error(
      "Execution receipt missing validator_image_ref — pass requires immutable validator image identity"
    );
  }
  if (!isDigestPinned(receipt.validator_image_ref)) {
    throw new Error(
      `Execution receipt validator_image_ref '${receipt.validator_image_ref}' is invalid: not digest-pinned`
    );
  }

  // 3i. validator_image_digest present.
  if (!receipt.validator_image_digest) {
    throw new Error(
      "Execution receipt missing validator_image_digest — pass requires immutable validator image identity"
    );
  }

  // 3j. validator_result_status must be 'pass'.
  if (receipt.validator_result_status !== "pass") {
    throw new Error(
      `Execution receipt validator_result_status is '${receipt.validator_result_status}', must be 'pass'`
    );
  }
}
