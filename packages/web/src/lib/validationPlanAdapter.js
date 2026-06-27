// src/lib/validationPlanAdapter.js
// Validation-plan adapter (v0.23.0 Task 9, extended Task 8D).
//
// Translates semantic required_validation IDs into executable executor command
// IDs. This is the reconciliation layer between the CI-evidence vocabulary
// (policy_scope_check, test_or_build_result) and the executor-service's
// allowlisted command templates (lint, test, build, typecheck).
//
// Task 8D — repo-aware command descriptors:
// When CI evidence carries a frozen ci_workflow_command descriptor whose
// semantic_id matches a required_validation entry, the descriptor TAKES
// PRECEDENCE over the fixed template. This is what lets the verifier run the
// target repo's actual command (e.g. `npx --no-install eslint app.js`) instead
// of the GitWire baseline's `npm run lint --`.
//
//   descriptor absent                         → legacy fallback command ID
//   descriptor present + shape-valid          → descriptor used (pending executor policy)
//   descriptor present + shape-INVALID        → explicit shape_invalid artifact
//                                               (NEVER silently dropped, NEVER falls back)
//
// The output command_descriptors object is canonicalized via the SHARED
// @gitwire/core helper so sandboxRunner.buildValidationPlan() and
// repairProposalService.buildValidationPlanForRecorder() produce byte-identical
// validation_plan_hash values.

import { validateDescriptorShape, canonicalizePlan } from "@gitwire/core";

// Mappings:
//   test_or_build_result → commands [test, build], acceptance "pass if either"
//   policy_scope_check    → no executor commands, app-side predicate only
//   lint/test/build/typecheck → pass through as executable
//
// The semantic-to-executable mapping table. Frozen — adding a new semantic ID
// = adding one entry here. Each entry maps to:
//   commands: string[]     → executable command IDs for the executor
//   acceptance: string     → the acceptance policy for this requirement
//   app_side_only: boolean → true = no executor commands (predicate-only)
export const VALIDATION_PLAN_MAPPINGS = Object.freeze({
  test_or_build_result: {
    commands: ["test", "build"],
    acceptance: "test_or_build",
    app_side_only: false,
  },
  lint_result: {
    commands: ["lint"],
    acceptance: "lint_pass",
    app_side_only: false,
  },
  policy_scope_check: {
    commands: [],
    acceptance: "policy_scope_predicate",
    app_side_only: true,
  },
});

// Semantic IDs that are eligible for a repo-aware descriptor override.
const DESCRIPTOR_ELIGIBLE_SEMANTICS = new Set(["lint_result", "test_or_build_result"]);

// Already-executable command IDs that pass through without translation.
const EXECUTABLE_COMMAND_IDS = new Set(["lint", "test", "build", "typecheck"]);

/**
 * Find the frozen ci_workflow_command descriptor in evidence whose
 * descriptor.semantic_id matches the given semantic ID, if any.
 *
 * @param {string} semanticId
 * @param {object[]} [evidenceRefs]
 * @returns {object|null} the descriptor object, or null
 */
function findDescriptorForSemantic(semanticId, evidenceRefs) {
  if (!Array.isArray(evidenceRefs)) return null;
  for (const ref of evidenceRefs) {
    if (ref && ref.type === "ci_workflow_command" && ref.descriptor &&
        ref.descriptor.semantic_id === semanticId) {
      return ref.descriptor;
    }
  }
  return null;
}

/**
 * Compile a list of semantic required_validation IDs into an executable
 * validation plan.
 *
 * @param {string[]} requiredValidation — semantic IDs from the CI-evidence envelope
 * @param {object[]} [evidenceRefs] — CI evidence refs (may carry ci_workflow_command
 *   descriptors). Optional for backward compatibility; when omitted, legacy
 *   behavior is preserved.
 * @returns {{
 *   executable_commands: string[],     — deduplicated, sorted executor command IDs
 *   acceptance_policy: string,         — how to interpret the command results
 *   unmapped: string[],                — IDs that have no mapping (for diagnostics)
 *   command_descriptors: Record<string, object>, — Task 8D: keyed descriptors
 * }}
 */
export function compileValidationPlan(requiredValidation, evidenceRefs) {
  const executableSet = new Set();
  const unmapped = [];
  const policies = [];
  const rawDescriptors = {};

  for (const id of requiredValidation || []) {
    // ── Task 8D: repo-aware descriptor override ──────────────────────────
    // For descriptor-eligible semantics, prefer a frozen ci_workflow_command
    // descriptor over the fixed template.
    if (DESCRIPTOR_ELIGIBLE_SEMANTICS.has(id)) {
      const descriptor = findDescriptorForSemantic(id, evidenceRefs);
      if (descriptor) {
        // Task 8D blocker fix: if the extractor already classified this
        // descriptor as shape_invalid (it carries specific path reasons such
        // as glob/absolute/traversal failures), preserve those original
        // reasons verbatim. Re-running generic shape validation here would
        // replace the specific path reasons with generic "argv must be..." /
        // "target_paths must be..." messages, losing the actionable detail.
        if (descriptor.policy_status === "shape_invalid") {
          const cmdId = descriptor.command_id || ("invalid_" + id);
          executableSet.add(cmdId);
          rawDescriptors[cmdId] = {
            command_id: cmdId,
            semantic_id: descriptor.semantic_id || id,
            source: descriptor.source || "ci_workflow",
            policy_status: "shape_invalid",
            shape_reasons: Array.isArray(descriptor.shape_reasons) && descriptor.shape_reasons.length > 0
              ? [...descriptor.shape_reasons]
              : ["descriptor shape invalid (no specific reasons carried)"],
          };
          const mapping = VALIDATION_PLAN_MAPPINGS[id];
          if (mapping) policies.push(mapping.acceptance);
          continue;
        }

        const shape = validateDescriptorShape(descriptor);
        if (shape.ok) {
          // Valid descriptor → use it. Add its command_id to the executable
          // plan and register the descriptor (pending executor policy).
          const cmdId = descriptor.command_id;
          executableSet.add(cmdId);
          rawDescriptors[cmdId] = {
            ...descriptor,
            policy_status: descriptor.policy_status || "pending_executor_validation",
          };
        } else {
          // Shape-INVALID → explicit rejected artifact. Preserve identity so
          // the executor-service records a rejected result. Do NOT fall back
          // to the legacy template (fail-closed).
          const cmdId = descriptor.command_id || ("invalid_" + id);
          executableSet.add(cmdId);
          rawDescriptors[cmdId] = {
            command_id: cmdId,
            semantic_id: descriptor.semantic_id || id,
            source: descriptor.source || "ci_workflow",
            policy_status: "shape_invalid",
            shape_reasons: shape.reasons,
          };
        }
        // Still record the acceptance policy for the semantic requirement.
        const mapping = VALIDATION_PLAN_MAPPINGS[id];
        if (mapping) policies.push(mapping.acceptance);
        continue;
      }
      // No descriptor → fall through to legacy mapping below.
    }

    // Check if it's a semantic ID with a mapping.
    const mapping = VALIDATION_PLAN_MAPPINGS[id];
    if (mapping) {
      for (const cmd of mapping.commands) {
        executableSet.add(cmd);
      }
      policies.push(mapping.acceptance);
      continue;
    }

    // Check if it's already an executable command ID.
    if (EXECUTABLE_COMMAND_IDS.has(id)) {
      executableSet.add(id);
      continue;
    }

    // Unknown — record as unmapped. Do NOT add to executable_commands.
    unmapped.push(id);
  }

  // Derive the composite acceptance policy from the collected sub-policies.
  let acceptancePolicy;
  if (policies.length === 0) {
    // No semantic IDs → all pass-through executables → standard "all must pass".
    acceptancePolicy = "all_must_pass";
  } else if (policies.length === 1) {
    acceptancePolicy = policies[0];
  } else {
    // Multiple semantic requirements → combine with "_and_".
    acceptancePolicy = policies.sort().join("_and_");
  }

  // Canonicalize the descriptors via the shared helper so both the runner and
  // the recorder produce byte-identical plan content.
  const commands = [...executableSet].sort();
  const { command_descriptors } = canonicalizePlan({
    commands,
    command_descriptors: rawDescriptors,
  });

  return {
    executable_commands: commands,
    acceptance_policy: acceptancePolicy,
    unmapped,
    command_descriptors,
  };
}
