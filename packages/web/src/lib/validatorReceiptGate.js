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
import {
  normalizeNormativeSteps,
  normalizeExecutedSteps,
  derivePlanExecutionRelation,
} from "./planExecutionConformance.js";
import { deriveResultEligibility } from "./resultEligibility.js";

/**
 * Validate the Gap 1 validator bindings on a pass receipt.
 * Throws on any violation; returns nothing on success.
 *
 * Intended exclusively for pass receipts. See module header.
 *
 * @param {object} receipt - parsed execution receipt object
 * @param {object} [canonicalPlan] - the canonical validation plan (for conformance check 3m)
 * @param {object} [rawReport] - the resolved raw executor report (for conformance check 3m)
 * @throws {Error} on any Gap 1 binding violation
 */
export function validateGap1ValidatorBindings(receipt, canonicalPlan, rawReport) {
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

  // 3k. (v0.23.0 Task 6) executor_report bindings required for executor-service.
  // When the backend is executor-service, the receipt MUST carry
  // executor_report_hash + executor_report_ref so the verifier can resolve
  // the raw report and recompute the hash. Without these, the pass evidence
  // is unverifiable — the app could have written an arbitrary hash.
  if (receipt.execution_backend_id === "executor-service") {
    if (!receipt.executor_report_ref) {
      throw new Error(
        "Execution receipt missing executor_report_ref — executor-service pass requires verifiable report evidence"
      );
    }
    if (!receipt.executor_report_hash) {
      throw new Error(
        "Execution receipt missing executor_report_hash — executor-service pass requires verifiable report evidence"
      );
    }
  }

  // 3m. (plan-execution conformance) The plan_execution_relation must be
  // "exact" and must match the app's independent recomputation. The verifier
  // does NOT trust the stored relation — it recomputes from the canonical
  // plan + the receipt's executed_steps (or the raw executor report, if
  // available from the caller).
  //
  // This is the load-bearing conformance check: a receipt whose plan says
  // descriptor but whose execution ran legacy cannot pass, regardless of
  // exit statuses or backend identity.
  //
  // For executor-service: rawReport is available (hash-verified) — use it.
  // For docker/node: rawReport is null — fall back to receipt.executed_steps.
  const execEvidence = rawReport || (receipt.executed_steps ? { executed_steps: receipt.executed_steps } : null);
  if (canonicalPlan && execEvidence) {
    const normResult = normalizeNormativeSteps(canonicalPlan);
    const execNormResult = normalizeExecutedSteps(execEvidence);
    const recomputed = derivePlanExecutionRelation({
      plannedSteps: normResult.steps,
      executedSteps: execNormResult.steps,
      executionAttempted: execNormResult.executionAttempted,
      evidenceComplete: normResult.evidenceComplete && execNormResult.evidenceComplete,
    });

    if (recomputed.relation !== "exact") {
      throw new Error(
        `Execution receipt plan_execution_relation recomputed as '${recomputed.relation}' (reasons: ${recomputed.reason_codes.join(", ")}) — pass requires exact conformance`
      );
    }

    // If the receipt carries a stored relation, it must match the recomputation.
    if (receipt.plan_execution_relation && receipt.plan_execution_relation !== recomputed.relation) {
      throw new Error(
        `Execution receipt plan_execution_relation '${receipt.plan_execution_relation}' does not match recomputed '${recomputed.relation}'`
      );
    }
  } else if (receipt.plan_execution_relation && receipt.plan_execution_relation !== "exact") {
    // No canonical plan or execution evidence available to recompute — but the
    // stored relation says non-exact. Reject.
    throw new Error(
      `Execution receipt plan_execution_relation is '${receipt.plan_execution_relation}' — pass requires exact conformance`
    );
  } else if (!receipt.plan_execution_relation) {
    // Schema-v1 receipt (no stored relation) — cannot establish exact.
    throw new Error(
      "Execution receipt missing plan_execution_relation — schema-v1 receipts without structured conformance evidence cannot establish exact"
    );
  }
}

/**
 * Validate plan-execution conformance with the canonical plan and raw report.
 *
 * This is a separate entry point so the verifier (which has the canonicalPlan
 * and rawReport in scope) can pass them explicitly. The receipt-only check
 * above is a fallback when those aren't available.
 *
 * @param {object} receipt - parsed execution receipt
 * @param {object} canonicalPlan - the plan from buildValidationPlanForRecorder
 * @param {object} [rawReport] - the resolved raw executor report (executor-service only)
 * @throws {Error} on any conformance violation
 */
export function validatePlanExecutionConformance(receipt, canonicalPlan, rawReport) {
  if (!receipt || typeof receipt !== "object") {
    throw new Error("validatePlanExecutionConformance: receipt must be an object");
  }

  const normResult = normalizeNormativeSteps(canonicalPlan);
  const execNormResult = normalizeExecutedSteps(rawReport || receipt);
  const recomputed = derivePlanExecutionRelation({
    plannedSteps: normResult.steps,
    executedSteps: execNormResult.steps,
    executionAttempted: execNormResult.executionAttempted,
    evidenceComplete: normResult.evidenceComplete && execNormResult.evidenceComplete,
  });

  if (recomputed.relation !== "exact") {
    throw new Error(
      `Plan-execution conformance check failed: relation is '${recomputed.relation}' (reasons: ${recomputed.reason_codes.join(", ")}) — pass requires exact conformance`
    );
  }

  if (receipt.plan_execution_relation && receipt.plan_execution_relation !== recomputed.relation) {
    throw new Error(
      `Receipt plan_execution_relation '${receipt.plan_execution_relation}' does not match recomputed '${recomputed.relation}'`
    );
  }
}
