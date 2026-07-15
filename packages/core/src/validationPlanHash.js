// @gitwire/core — src/validationPlanHash.js
//
// Shared validation-plan hash computation (plan-execution conformance model).
//
// This module is the SINGLE source of truth for how validation_plan_hash is
// computed. Both packages/web/src/lib/sandboxRunner.js (runner side) and
// packages/web/src/services/repairProposalService.js (recorder side) MUST call
// computeValidationPlanHash() — they must NOT each inline their own
// JSON.stringify block. The old two-site duplication was an integrity hazard:
// adding a field to one site and forgetting the other would silently break
// hash equivalence without any compile-time signal.
//
// Schema versions:
//   1 — legacy: { commands, command_descriptors, image_digest,
//                 required_validation, acceptance_policy }
//   2 — plan-execution conformance: adds plan_schema_version, descriptor_policy,
//       normative_steps, required_execution_features
//
// Schema-1 hash computation is preserved separately so historical receipts
// (which carry schema-1 plan hashes) remain verifiable. Schema-1 receipts
// without structured execution evidence cannot establish plan_execution_relation
// "exact" — they are "unverifiable" under the conformance model.

import crypto from "node:crypto";

/**
 * Compute the schema-1 validation plan hash (legacy).
 *
 * This is the ORIGINAL hash algorithm. It MUST NOT change — historical
 * receipts carry hashes computed with this exact shape. Schema-1 receipts
 * are "unverifiable" under the conformance model (no structured evidence),
 * but their plan hash remains valid as a historical artifact.
 *
 * @param {{
 *   commands: string[],
 *   command_descriptors: Record<string, object>,
 *   image_digest: string,
 *   required_validation: string[],
 *   acceptance_policy: string,
 * }} input
 * @returns {string} "sha256:<hex>"
 */
export function computeValidationPlanHashV1(input) {
  const content = JSON.stringify({
    commands: input.commands,
    command_descriptors: input.command_descriptors,
    image_digest: input.image_digest,
    required_validation: input.required_validation,
    acceptance_policy: input.acceptance_policy,
  });
  return "sha256:" + crypto.createHash("sha256").update(content).digest("hex");
}

/**
 * Compute the schema-2 validation plan hash (plan-execution conformance).
 *
 * Schema 2 adds: plan_schema_version, descriptor_policy, normative_steps,
 * required_execution_features. The normative_steps array is the source of
 * truth for what the plan requires; executable_commands is a derived
 * backward-compat projection and is NOT hashed independently.
 *
 * Property order in the JSON.stringify is significant — both call sites
 * use this shared function, so order is centralized here.
 *
 * @param {{
 *   commands: string[],
 *   command_descriptors: Record<string, object>,
 *   image_digest: string,
 *   required_validation: string[],
 *   acceptance_policy: string,
 *   plan_schema_version: number,
 *   descriptor_policy: { activation: string },
 *   normative_steps: object[],
 *   required_execution_features: string[],
 * }} input
 * @returns {string} "sha256:<hex>"
 */
export function computeValidationPlanHash(input) {
  const content = JSON.stringify({
    commands: input.commands,
    command_descriptors: input.command_descriptors,
    image_digest: input.image_digest,
    required_validation: input.required_validation,
    acceptance_policy: input.acceptance_policy,
    plan_schema_version: input.plan_schema_version,
    descriptor_policy: input.descriptor_policy,
    normative_steps: input.normative_steps,
    required_execution_features: input.required_execution_features,
  });
  return "sha256:" + crypto.createHash("sha256").update(content).digest("hex");
}

/**
 * Resolve the descriptor activation policy from a raw env value.
 *
 *   unset / undefined → "observed" (safe default)
 *   "observed"         → "observed"
 *   "selected"         → "selected"
 *   anything else      → throws (configuration failure — no silent coercion)
 *
 * This is the single resolver. Both compileValidationPlan callers should
 * resolve once at startup and inject the result, rather than reading
 * process.env directly inside the pure compilation logic.
 *
 * @param {string|undefined} rawValue
 * @returns {"observed"|"selected"}
 * @throws {Error} on invalid value
 */
export function resolveDescriptorActivation(rawValue) {
  if (rawValue === undefined || rawValue === null || rawValue === "") {
    return "observed";
  }
  if (rawValue === "observed" || rawValue === "selected") {
    return rawValue;
  }
  throw new Error(
    `Invalid GITWIRE_DESCRIPTOR_ACTIVATION value '${rawValue}': must be "observed" or "selected" (or unset for default "observed")`
  );
}
