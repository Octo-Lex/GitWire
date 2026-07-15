// src/lib/resultEligibility.js
//
// Result eligibility derivation (plan-execution conformance model,
// commit 3 of 5).
//
// This PURE module combines the plan-execution relation with backend
// capability, pass-capability, and report-integrity signals to determine
// whether a result is eligible for authoritative pass/fail.
//
// It does NOT choose pass or fail — that's a separate result-mapping step.
// This separation keeps capability/eligibility (what the backend can prove)
// distinct from the factual execution outcome (what the commands returned).
//
// Result mapping (done by the caller, NOT here):
//   eligible + completed validation success → pass
//   eligible + completed validation failure → fail
//   ineligible                             → inconclusive
//   timeout/spawn/infrastructure failure    → inconclusive
//
// Both receipt construction (sandboxRunner.js) and verification
// (validatorReceiptGate.js) call the same eligibility logic. Verification
// must NOT trust a stored eligibility boolean — it independently derives
// the inputs and recomputes.

/**
 * Derive whether a result is eligible for authoritative pass/fail.
 *
 * @param {{
 *   planExecutionRelation: string,        — "exact"|"none"|"divergent"|"unverifiable"
 *   requiredExecutionFeatures: string[],  — features the plan requires
 *   backendExecutionFeatures: string[],   — features the backend advertises (receipt-bound snapshot)
 *   backendPassCapable: boolean,          — backend's static pass-capability claim + reachability
 *   selectedBackendReachable: boolean,    — the selected backend probed reachable
 *   validatorImageIdentityValid: boolean,  — ref + digest + match
 *   reportIntegrityValid: boolean,        — executor report hash verified (executor-service only)
 *   executionEvidenceComplete: boolean,   — structured step evidence present
 *   planSchemaSupported: boolean,          — plan schema version is supported (v2)
 * }} input
 * @returns {{ eligible: boolean, reason_codes: string[] }}
 */
export function deriveResultEligibility(input) {
  const reason_codes = [];

  if (!input || typeof input !== "object") {
    return { eligible: false, reason_codes: ["invalid_input"] };
  }

  const {
    planExecutionRelation,
    requiredExecutionFeatures = [],
    backendExecutionFeatures = [],
    backendPassCapable,
    selectedBackendReachable,
    validatorImageIdentityValid,
    reportIntegrityValid,
    executionEvidenceComplete,
    planSchemaSupported,
  } = input;

  // 1. Plan-execution relation must be exact.
  if (planExecutionRelation !== "exact") {
    reason_codes.push(`plan_execution_not_exact:${planExecutionRelation || "unknown"}`);
  }

  // 2. Required execution features must be a subset of backend features.
  const backendFeatureSet = new Set(backendExecutionFeatures);
  for (const feature of requiredExecutionFeatures) {
    if (!backendFeatureSet.has(feature)) {
      reason_codes.push(`required_feature_missing:${feature}`);
    }
  }

  // 3. Backend must be pass-capable (static claim + structural kind).
  if (backendPassCapable !== true) {
    reason_codes.push("backend_not_pass_capable");
  }

  // 4. Selected backend must be reachable.
  if (selectedBackendReachable !== true) {
    reason_codes.push("selected_backend_not_reachable");
  }

  // 5. Validator image identity must be complete and matched.
  if (validatorImageIdentityValid !== true) {
    reason_codes.push("validator_image_identity_invalid");
  }

  // 6. Report integrity must be valid (executor-service: hash recompute;
  //    other backends: not applicable, treated as valid).
  if (reportIntegrityValid !== true) {
    reason_codes.push("report_integrity_invalid");
  }

  // 7. Execution evidence must be complete (structured step evidence).
  if (executionEvidenceComplete !== true) {
    reason_codes.push("execution_evidence_incomplete");
  }

  // 8. Plan schema must be supported.
  if (planSchemaSupported !== true) {
    reason_codes.push("plan_schema_not_supported");
  }

  return { eligible: reason_codes.length === 0, reason_codes };
}

/**
 * Map an execution outcome to the final validator_result, given eligibility.
 *
 * This is the ONLY function that chooses pass/fail/inconclusive. It combines
 * eligibility with the execution outcome:
 *   eligible + all commands succeeded → pass
 *   eligible + a normative command failed → fail
 *   ineligible → inconclusive
 *   timeout/spawn failure → inconclusive (regardless of eligibility)
 *
 * @param {{
 *   eligible: boolean,
 *   executionOverall: string,  — "pass"|"fail"|"inconclusive" (from the backend)
 *   hasTimeout: boolean,       — any command timed out or spawn failed
 * }} input
 * @returns {{ validator_result: "pass"|"fail"|"inconclusive", reason: string|null }}
 */
export function mapResultOutcome(input) {
  const { eligible, executionOverall, hasTimeout } = input;

  // Timeout/spawn failure always yields inconclusive, even if eligible.
  if (hasTimeout) {
    return { validator_result: "inconclusive", reason: "timeout_or_spawn_failure" };
  }

  if (!eligible) {
    return { validator_result: "inconclusive", reason: "not_eligible_for_authoritative_result" };
  }

  // Eligible — the execution outcome is authoritative.
  if (executionOverall === "pass") {
    return { validator_result: "pass", reason: null };
  }
  if (executionOverall === "fail") {
    return { validator_result: "fail", reason: null };
  }
  // executionOverall is inconclusive — preserve it.
  return { validator_result: "inconclusive", reason: "execution_overall_inconclusive" };
}
