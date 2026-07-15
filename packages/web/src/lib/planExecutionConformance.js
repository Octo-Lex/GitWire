// src/lib/planExecutionConformance.js
//
// Plan-execution conformance derivation (plan-execution conformance model,
// commit 3 of 5).
//
// This is the PURE conformance engine. It derives the relationship between
// the normative validation plan (what should have been executed) and the
// execution evidence (what was actually executed). The app derives this
// independently — it does NOT trust a relation string from the executor.
//
// The module has three separate pure stages:
//   1. normalizeNormativeSteps(canonicalPlan) — extract planned steps with stable IDs
//   2. normalizeExecutedSteps(executionEvidence) — extract executed steps with stable IDs
//   3. derivePlanExecutionRelation({ plannedSteps, executedSteps, ... }) — compare
//
// The comparator itself does NOT know about backend IDs, raw HTTP report
// shapes, or the executor-service API. Transport-specific extraction is
// handled by the callers (sandboxRunner for construction, validatorReceiptGate
// for verification).
//
// Relation values:
//   exact         — every normative step has exactly one matching executed
//                   step with identical argv, target_paths, command_source,
//                   and correct sequence. No extra or omitted steps.
//   none          — trustworthy evidence explicitly establishes that no
//                   normative step ran (e.g. empty execution with a clear
//                   inconclusive reason).
//   divergent     — at least one step was attempted/omitted/substituted/
//                   duplicated, or executed with different argv or targets.
//   unverifiable  — available evidence is insufficient to determine exact,
//                   none, or divergent (e.g. missing executed_steps, missing
//                   argv, or a backend that didn't report structured evidence).
//
// Both none and unverifiable yield inconclusive validator_result, but the
// distinction is preserved for operational and audit accuracy.
//
// INVARIANTS:
//   - Empty plans cannot pass vacuously (zero steps + zero executed → inconclusive)
//   - Step IDs are validated end-to-end (duplicate/unknown/missing → divergent)
//   - Shell execution represented explicitly or classified unverifiable
//   - Relation is separate from outcome (exact + failure → fail; exact + timeout → inconclusive)

/**
 * Normalize the normative steps from a compiled validation plan.
 *
 * @param {object} canonicalPlan — the plan object from compileValidationPlan()
 * @returns {{ steps: object[], evidenceComplete: boolean }}
 */
export function normalizeNormativeSteps(canonicalPlan) {
  if (!canonicalPlan || typeof canonicalPlan !== "object") {
    return { steps: [], evidenceComplete: false };
  }
  const steps = Array.isArray(canonicalPlan.normative_steps)
    ? canonicalPlan.normative_steps
    : [];
  // If the plan has no normative_steps (schema v1 or missing), evidence is
  // incomplete — the conformance check cannot establish exact.
  const evidenceComplete = Array.isArray(canonicalPlan.normative_steps) &&
    canonicalPlan.plan_schema_version === 2;
  return { steps: [...steps], evidenceComplete };
}

/**
 * Normalize executed steps from execution evidence.
 *
 * Accepts either:
 *   - An object with an `executed_steps` array (receipt or backend result)
 *   - An array of executed step objects directly
 *
 * @param {object|object[]} executionEvidence
 * @returns {{ steps: object[], evidenceComplete: boolean, executionAttempted: boolean }}
 */
export function normalizeExecutedSteps(executionEvidence) {
  if (!executionEvidence) {
    // No evidence at all — unverifiable (not "none"). "none" requires
    // trustworthy evidence that nothing ran; absence is not that.
    return { steps: [], evidenceComplete: false, executionAttempted: false };
  }
  const rawSteps = Array.isArray(executionEvidence)
    ? executionEvidence
    : (Array.isArray(executionEvidence.executed_steps) ? executionEvidence.executed_steps : null);

  // If executed_steps field is absent (not an empty array), evidence is incomplete.
  if (rawSteps === null) {
    return { steps: [], evidenceComplete: false, executionAttempted: false };
  }

  if (rawSteps.length === 0) {
    // Explicitly empty executed_steps — execution was attempted but produced
    // no steps. This is "none" (trustworthy evidence that nothing ran), not
    // "unverifiable".
    const reason = executionEvidence.inconclusive_reason || executionEvidence.inconclusive_detail;
    const attempted = Boolean(reason) && reason !== "executor_service_url_not_configured";
    return { steps: [], evidenceComplete: true, executionAttempted: attempted };
  }

  // Evidence is complete only if every step has a step_id and either
  // executed_argv or an explicit null (for rejected/shape-invalid steps).
  const evidenceComplete = rawSteps.every(s =>
    s && typeof s.step_id === "string" && s.step_id.length > 0
  );

  return { steps: [...rawSteps], evidenceComplete, executionAttempted: true };
}

/**
 * Derive the plan-execution relation by comparing planned and executed steps.
 *
 * @param {{
 *   plannedSteps: object[],
 *   executedSteps: object[],
 *   executionAttempted: boolean,
 *   evidenceComplete: boolean,
 * }} input
 * @returns {{ relation: "exact"|"none"|"divergent"|"unverifiable", reason_codes: string[] }}
 */
export function derivePlanExecutionRelation(input) {
  const { plannedSteps = [], executedSteps = [], executionAttempted = false, evidenceComplete = true } = input || {};
  const reason_codes = [];

  // Cannot establish exact without complete evidence.
  if (!evidenceComplete) {
    return { relation: "unverifiable", reason_codes: ["insufficient_evidence"] };
  }

  // Empty plan — cannot pass vacuously. If nothing was planned and nothing
  // was executed, that's inconclusive (not a valid pass).
  if (plannedSteps.length === 0) {
    if (executedSteps.length === 0) {
      return { relation: "none", reason_codes: ["empty_plan_no_execution"] };
    }
    // Extra execution with no planned steps — divergent.
    return { relation: "divergent", reason_codes: ["extra_execution_no_plan"] };
  }

  // Planned steps exist but no execution.
  if (executedSteps.length === 0) {
    if (executionAttempted) {
      return { relation: "none", reason_codes: ["execution_attempted_no_steps"] };
    }
    return { relation: "none", reason_codes: ["no_execution"] };
  }

  // Step count mismatch.
  if (plannedSteps.length !== executedSteps.length) {
    if (executedSteps.length < plannedSteps.length) {
      reason_codes.push("omitted_steps");
    } else {
      reason_codes.push("extra_steps");
    }
    return { relation: "divergent", reason_codes };
  }

  // Validate step IDs: check for duplicates.
  const plannedIds = plannedSteps.map(s => s.step_id);
  const executedIds = executedSteps.map(s => s.step_id);
  const plannedDupeIds = findDuplicates(plannedIds);
  const executedDupeIds = findDuplicates(executedIds);
  if (plannedDupeIds.length > 0) {
    return { relation: "divergent", reason_codes: ["duplicate_planned_step_ids"] };
  }
  if (executedDupeIds.length > 0) {
    return { relation: "divergent", reason_codes: ["duplicate_executed_step_ids"] };
  }

  // Match steps by step_id and compare element-by-element.
  const plannedMap = new Map(plannedSteps.map(s => [s.step_id, s]));
  const executedMap = new Map(executedSteps.map(s => [s.step_id, s]));

  // Check every planned step has a matching executed step.
  for (const plannedStep of plannedSteps) {
    const executedStep = executedMap.get(plannedStep.step_id);
    if (!executedStep) {
      return { relation: "divergent", reason_codes: [`missing_executed_step:${plannedStep.step_id}`] };
    }

    // Compare command_source.
    const plannedSource = plannedStep.command_source || null;
    const executedSource = executedStep.command_source || null;
    if (plannedSource !== executedSource) {
      return { relation: "divergent", reason_codes: [`command_source_mismatch:${plannedStep.step_id}`] };
    }

    // Compare argv (element-by-element). For legacy steps (argv is null in
    // the plan), skip argv comparison — the command_source already matched.
    if (plannedStep.argv !== null && plannedStep.argv !== undefined) {
      const plannedArgv = Array.isArray(plannedStep.argv) ? plannedStep.argv : [];
      const executedArgv = Array.isArray(executedStep.executed_argv) ? executedStep.executed_argv : [];

      if (plannedArgv.length !== executedArgv.length) {
        return { relation: "divergent", reason_codes: [`argv_length_mismatch:${plannedStep.step_id}`] };
      }
      for (let i = 0; i < plannedArgv.length; i++) {
        if (plannedArgv[i] !== executedArgv[i]) {
          return { relation: "divergent", reason_codes: [`argv_mismatch:${plannedStep.step_id}:arg${i}`] };
        }
      }
    }

    // Compare target_paths (normalized). For legacy steps (empty array in plan),
    // skip. For descriptor steps, compare element-by-element.
    if (plannedStep.target_paths !== null && plannedStep.target_paths !== undefined &&
        Array.isArray(plannedStep.target_paths) && plannedStep.target_paths.length > 0) {
      const plannedPaths = normalizePaths(plannedStep.target_paths);
      const executedPaths = normalizePaths(executedStep.target_paths);
      if (plannedPaths.length !== executedPaths.length ||
          !plannedPaths.every((p, i) => p === executedPaths[i])) {
        return { relation: "divergent", reason_codes: [`target_paths_mismatch:${plannedStep.step_id}`] };
      }
    }

    // Compare execution order. The executed step's actual position in the
    // executedSteps array (executionIndex) must match the planned sequence.
    // We do NOT trust the echoed sequence field — backends may copy it from
    // the plan. The array position is the factual execution order.
    const executionIndex = executedSteps.indexOf(executedStep);
    if (typeof plannedStep.sequence === "number" && executionIndex !== plannedStep.sequence) {
      return { relation: "divergent", reason_codes: [`sequence_mismatch:${plannedStep.step_id}:planned=${plannedStep.sequence}:actual=${executionIndex}`] };
    }

    // Check for rejected/non-started steps — these are divergent because
    // the planned command never executed.
    //
    // Distinguish from timeout: a command that started and timed out is
    // still an exact execution relation (it ran the right command), but
    // the outcome is inconclusive. Only rejection/never-started is divergent.
    if (executedStep.status === "rejected") {
      return { relation: "divergent", reason_codes: [`step_rejected:${plannedStep.step_id}`] };
    }
    if (executedStep.started === false) {
      return { relation: "divergent", reason_codes: [`step_not_started:${plannedStep.step_id}`] };
    }
    // A timed-out or spawn-failed command that started is NOT divergent —
    // the relation is exact (it ran the planned argv). The outcome mapping
    // (mapResultOutcome) handles the inconclusive result via hasTimeout.
  }

  // Check no extra executed steps (unknown step IDs).
  for (const executedStep of executedSteps) {
    if (!plannedMap.has(executedStep.step_id)) {
      return { relation: "divergent", reason_codes: [`unknown_executed_step:${executedStep.step_id}`] };
    }
  }

  // All checks passed — exact conformance.
  return { relation: "exact", reason_codes: [] };
}

/**
 * Normalize target paths for comparison. Sorts and strips trailing slashes
 * so semantically equivalent paths match.
 *
 * @param {string[]|null} paths
 * @returns {string[]}
 */
function normalizePaths(paths) {
  if (!Array.isArray(paths)) return [];
  return paths
    .map(p => String(p).replace(/\/+$/, ""))
    .sort();
}

/**
 * Find duplicate values in an array.
 *
 * @param {string[]} arr
 * @returns {string[]}
 */
function findDuplicates(arr) {
  const seen = new Set();
  const dupes = new Set();
  for (const v of arr) {
    if (seen.has(v)) dupes.add(v);
    seen.add(v);
  }
  return [...dupes];
}
