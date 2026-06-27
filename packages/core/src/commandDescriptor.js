// @gitwire/core — src/commandDescriptor.js
//
// Repo-aware validation command descriptors (Task 8D).
//
// This module is the SHARED, PURE canonicalization + shape-validation layer for
// command descriptors. It is imported by BOTH:
//   - packages/web          (validationPlanAdapter — shape validation only)
//   - packages/executor-service (validatorRunner — authoritative policy)
//
// INVARIANT: this module contains NO security policy. It validates only the
// structural shape and canonical form of a descriptor. The authoritative
// allowlist / metacharacter / path-traversal checks live in executor-service's
// commandDescriptorPolicy.js. Keeping the security boundary in one place
// prevents two drifting implementations.
//
// Canonicalization is deterministic so that sandboxRunner.buildValidationPlan()
// and repairProposalService.buildValidationPlanForRecorder() produce byte-identical
// validation_plan_hash values over the same frozen evidence.

// ── Required descriptor fields ──────────────────────────────────────────────
// A fully-formed descriptor (policy_status "pending_executor_validation"):
//   { command_id, semantic_id, source, argv[], target_paths[],
//     network, requires_shell, policy_status? }
//
// A shape-invalid descriptor carries no argv/target_paths but records why:
//   { command_id, semantic_id, source, policy_status:"shape_invalid",
//     shape_reasons[] }

const REQUIRED_STRING_FIELDS = ["command_id", "semantic_id", "source"];

/**
 * Validate the structural SHAPE of a single descriptor.
 *
 * Shape validation only — NOT security policy. Checks presence and types of
 * required fields. Returns { ok, reasons }. On failure the caller MUST keep
 * the descriptor visible (policy_status "shape_invalid") rather than silently
 * dropping it or falling back to a legacy command.
 *
 * @param {object} d - candidate descriptor
 * @returns {{ ok: boolean, reasons: string[] }}
 */
export function validateDescriptorShape(d) {
  const reasons = [];
  if (!d || typeof d !== "object" || Array.isArray(d)) {
    return { ok: false, reasons: ["descriptor must be a plain object"] };
  }
  for (const f of REQUIRED_STRING_FIELDS) {
    if (typeof d[f] !== "string" || d[f].length === 0) {
      reasons.push(`${f} must be a non-empty string`);
    }
  }
  // argv must be a non-empty array of strings.
  if (!Array.isArray(d.argv) || d.argv.length === 0 ||
      !d.argv.every(a => typeof a === "string" && a.length > 0)) {
    reasons.push("argv must be a non-empty string array");
  }
  // target_paths must be a non-empty array of strings (files only is a
  // security-policy concern enforced in executor-service; here we only check
  // it is a string array).
  if (!Array.isArray(d.target_paths) || d.target_paths.length === 0 ||
      !d.target_paths.every(p => typeof p === "string" && p.length > 0)) {
    reasons.push("target_paths must be a non-empty string array");
  }
  return { ok: reasons.length === 0, reasons };
}

/**
 * Canonicalize a single descriptor into a deterministic form.
 *
 * - object keys sorted alphabetically
 * - argv / target_paths coerced to string arrays
 * - no mutation of the input
 *
 * For shape-invalid descriptors (those carrying policy_status "shape_invalid"
 * and shape_reasons), canonicalization preserves those fields and does not
 * require argv/target_paths.
 *
 * @param {object} d - descriptor (valid or shape-invalid)
 * @returns {object} canonical descriptor
 */
export function canonicalizeDescriptor(d) {
  const isShapeInvalid = d && d.policy_status === "shape_invalid";
  const out = {};
  if (isShapeInvalid) {
    // Preserve identity + reasons only.
    out.command_id = d.command_id;
    out.semantic_id = d.semantic_id;
    out.source = d.source;
    out.policy_status = "shape_invalid";
    out.shape_reasons = Array.isArray(d.shape_reasons)
      ? [...d.shape_reasons]
      : ["unknown shape error"];
    // Sort keys for determinism.
    return sortObjectKeys(out);
  }

  // Valid descriptor — normalize argv/target_paths to fresh string arrays.
  out.command_id = d.command_id;
  out.semantic_id = d.semantic_id;
  out.source = d.source;
  out.argv = (d.argv || []).map(String);
  out.target_paths = (d.target_paths || []).map(String);
  out.network = d.network;
  out.requires_shell = d.requires_shell;
  if (d.policy_status) {
    out.policy_status = d.policy_status;
  }
  return sortObjectKeys(out);
}

/**
 * Canonicalize a full validation plan { commands, command_descriptors }.
 *
 * - commands[] order preserved (it is the ordered executable plan)
 * - command_descriptors keyed by command_id
 * - duplicate command_id with identical descriptor → deduped
 * - duplicate command_id with DIFFERENT descriptor → throws (fail-closed on
 *   conflict; a conflicting descriptor means evidence is ambiguous and must
 *   not silently pick one)
 *
 * @param {{commands: string[], command_descriptors: Record<string, object>}} plan
 * @returns {{commands: string[], command_descriptors: Record<string, object>}}
 * @throws {Error} on conflicting duplicate command_id
 */
export function canonicalizePlan(plan) {
  if (!plan || typeof plan !== "object") {
    throw new Error("canonicalizePlan: plan must be an object");
  }
  const commands = Array.isArray(plan.commands) ? [...plan.commands] : [];
  const rawDescriptors = (plan.command_descriptors && typeof plan.command_descriptors === "object")
    ? plan.command_descriptors
    : {};

  const canonicalDescriptors = {};
  for (const key of Object.keys(rawDescriptors)) {
    const canonical = canonicalizeDescriptor(rawDescriptors[key]);
    const id = canonical.command_id || key;
    const existing = canonicalDescriptors[id];
    if (existing) {
      // Dedupe if byte-identical; fail-closed otherwise.
      const a = JSON.stringify(existing);
      const b = JSON.stringify(canonical);
      if (a !== b) {
        throw new Error(
          `canonicalizePlan: conflicting descriptors for command_id "${id}"`
        );
      }
      // Identical — already present, skip.
    } else {
      canonicalDescriptors[id] = canonical;
    }
  }
  return { commands, command_descriptors: canonicalDescriptors };
}

// ── Internal helpers ────────────────────────────────────────────────────────

/**
 * Return a shallow copy of an object with keys sorted alphabetically.
 * Nested descriptor fields (argv, target_paths, shape_reasons) are arrays and
 * are NOT re-sorted — their element order is semantically meaningful.
 * @param {object} obj
 * @returns {object}
 */
function sortObjectKeys(obj) {
  const out = {};
  for (const k of Object.keys(obj).sort()) {
    out[k] = obj[k];
  }
  return out;
}
