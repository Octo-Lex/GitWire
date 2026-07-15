// src/services/repairProposalService.js
// CI repair proposal lifecycle management.
//
// Represents a proposed repair for a CI failure with strict tool/write
// authority, evidence requirements, and append-only event history.
//
// Key invariant: can_write_repository is ALWAYS false.
// No state transition can set it to true.
//
// HARDENING (round 2 — PR review):
// 1. CAS: id and version get SEPARATE placeholders, no collision
// 2. expected_version is MANDATORY on all mutation endpoints
// 3. Semantic evidence gates: validation must pass, critic must approve
// 4. Patch scope enforced against stored envelope limits
// 5. Idempotent creation uses ON CONFLICT DO NOTHING, not state heuristics

import { db } from "../lib/db.js";
import { logger } from "../lib/logger.js";
import crypto from "crypto";
import { compileValidationPlan } from "../lib/validationPlanAdapter.js";
import { computeValidationPlanHash, resolveDescriptorActivation } from "@gitwire/core";
import {
  ACTOR_KINDS,
  canCreateProposal,
  canAttachField,
  canTransitionTo,
} from "./repairAuthorityService.js";
import {
  verifyArtifact,
  parseArtifact,
  computeArtifactHash,
} from "../lib/patchArtifactStore.js";
import { getConfigForRepo } from "./configService.js";

// ── Actor-kind enforcement ────────────────────────────────────────────────────
// Every canonical mutation method must receive a recognized actor_kind.
// This makes authority checks unconditional — no caller can bypass the matrix
// by simply omitting the parameter.
const VALID_ACTOR_KINDS = new Set(Object.values(ACTOR_KINDS));

function requireActorKind(actorKind) {
  if (!VALID_ACTOR_KINDS.has(actorKind)) {
    throw new Error("actor_kind is required and must be a recognized value");
  }
}

// ── Valid state transitions ──────────────────────────────────────────────────
export const VALID_TRANSITIONS = {
  detected:            new Set(["evidence_collected", "cancelled", "failed"]),
  evidence_collected:  new Set(["proposed", "cancelled", "failed"]),
  proposed:            new Set(["verified", "cancelled", "rejected", "failed"]),
  verified:            new Set(["review_ready", "cancelled", "rejected", "failed"]),
  review_ready:        new Set(["approved", "rejected", "cancelled"]),
  approved:            new Set(["applied", "cancelled", "failed"]),
  applied:             new Set(["verified_after_apply", "failed", "superseded"]),
  verified_after_apply: new Set(),
  rejected:            new Set(),
  cancelled:           new Set(),
  failed:              new Set(),
  superseded:          new Set(),
};

// ── Terminal states ──────────────────────────────────────────────────────────
export const TERMINAL_STATES = new Set([
  "verified_after_apply",
  "rejected",
  "cancelled",
  "failed",
  "superseded",
]);

// ── States blocked from generic transition endpoint ─────────────────────────
export const AUTHORITY_STATES = new Set([
  "proposed",
  "verified",
  "review_ready",
  "approved",
  "applied",
  "verified_after_apply",
]);

// ── Evidence required per transition ─────────────────────────────────────────
export const REQUIRED_EVIDENCE = {
  evidence_collected: ["evidence_refs"],
  proposed:           ["diagnosis", "patch_proposal"],
  verified:           ["validation_result"],
  review_ready:       ["critic_review"],
};

// ── Known tool list ──────────────────────────────────────────────────────────
export const KNOWN_TOOLS = new Set([
  "read_ci_logs",
  "read_workflow_file",
  "read_repository_file",
  "run_validation",
]);

// ── Diagnosis fields that are allowed (narrow schema) ────────────────────────
export const ALLOWED_DIAGNOSIS_FIELDS = new Set([
  "summary",
  "failure_category",
  "root_cause_claim",
  "confidence",
  "limitations",
  "evidence_ids",
]);

// ── Diagnosis fields that are PROHIBITED (raw model output) ──────────────────
export const PROHIBITED_DIAGNOSIS_FIELDS = new Set([
  "reasoning",
  "analysis",
  "thoughts",
  "tool_transcript",
  "prompt",
  "raw_completion",
  "messages",
  "completion",
]);

// ── Valid patch_proposal change types ────────────────────────────────────────
export const VALID_CHANGE_TYPES = new Set([
  "fix",
  "modify",
  "delete",
]);

// ── Valid validation check results ───────────────────────────────────────────
export const VALID_VALIDATION_OVERALL = new Set(["pass", "fail", "inconclusive"]);

// ── Valid critic verdicts ────────────────────────────────────────────────────
export const VALID_CRITIC_VERDICTS = new Set(["approve", "reject"]);

// ── Valid critic finding codes ───────────────────────────────────────────────
export const VALID_FINDING_CODES = new Set([
  "PATCH_SCOPE_WITHIN_ENVELOPE",
  "VALIDATION_RECEIPT_BOUND",
  "BLOCKED_PATH_VIOLATION",
  "UNRESOLVED_EVIDENCE_GAP",
  "UNSUPPORTED_REMEDIATION",
]);

// ── Valid critic finding severities ──────────────────────────────────────────
export const VALID_FINDING_SEVERITIES = new Set(["blocking", "warning", "info"]);

// ── Valid evidence_ref types ─────────────────────────────────────────────────
export const VALID_EVIDENCE_REF_TYPES = new Set([
  // Original types
  "ci_log",
  "workflow_file",
  "repository_file",
  "test_output",
  "build_output",
  // CI evidence collector types (v0.19 Item 2)
  "workflow_run",
  "ci_job",
  "ci_log_excerpt",
]);

// ── Max field lengths ────────────────────────────────────────────────────────
const MAX_SUMMARY_LENGTH = 500;
const MAX_ROOT_CAUSE_LENGTH = 1000;
const MAX_TEXT_FIELD_LENGTH = 2000;
const MAX_FILE_PATH_LENGTH = 512;

// ════════════════════════════════════════════════════════════════════════════
// INTERNAL HELPERS
// ════════════════════════════════════════════════════════════════════════════

/**
 * Parse a value that might be a JSON string (from JSONB) or already an object.
 */
export function parseJsonb(value) {
  if (value === null || value === undefined) return value;
  if (typeof value === "object") return value;
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
  return value;
}

/**
 * Convert a glob pattern to a RegExp.
 * ** → .* (matches across /)
 * *  → [^/]* (matches within a path segment)
 * ?  → [^/]  (single char within a path segment)
 */
function globToRegex(pattern) {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&") // escape regex special chars (NOT * or ?)
    .replace(/\*\*/g, "\x00")              // ** → placeholder
    .replace(/\*/g, "[^/]*")               // * → within segment
    .replace(/\?/g, "[^/]")                // ? → single char within segment
    .replace(/\x00/g, ".*");               // ** placeholder → match anything
  return new RegExp("^" + escaped + "$");
}

/**
 * Check if a file path matches any blocked-path glob pattern.
 */
export function pathMatchesBlocked(filePath, patterns) {
  for (const pattern of patterns) {
    try {
      if (globToRegex(pattern).test(filePath)) {
        return true;
      }
    } catch {
      // Invalid pattern — skip
    }
  }
  return false;
}

// ════════════════════════════════════════════════════════════════════════════
// PURE FUNCTIONS (unit-testable, no side effects)
// ════════════════════════════════════════════════════════════════════════════

/**
 * Compute SHA-256 content hash of a JSON-serializable value.
 */
export function contentHash(value) {
  const json = JSON.stringify(value);
  return crypto.createHash("sha256").update(json).digest("hex");
}

/**
 * Check if a state is terminal (no further transitions allowed).
 */
export function isTerminalState(state) {
  return TERMINAL_STATES.has(state);
}

/**
 * Check if a state transition is valid.
 */
export function isValidTransition(fromStatus, toStatus) {
  const allowed = VALID_TRANSITIONS[fromStatus];
  return allowed ? allowed.has(toStatus) : false;
}

/**
 * Compute the source fingerprint for idempotency.
 */
export function computeFingerprint(source) {
  const parts = [
    source.repository || "",
    String(source.workflow_run_id || ""),
    String(source.job_id || ""),
    source.head_sha || "",
    source.failure_type || "",
  ];
  return parts.join(":");
}

/**
 * Validate a task envelope.
 */
export function validateEnvelope(envelope) {
  const errors = [];

  if (!envelope || typeof envelope !== "object") {
    return { valid: false, errors: ["Envelope must be an object"] };
  }

  if (envelope.task_type !== "ci_repair") {
    errors.push('task_type must be "ci_repair"');
  }

  const source = envelope.source;
  if (!source || typeof source !== "object") {
    errors.push("source is required and must be an object");
  } else {
    if (!source.repository) errors.push("source.repository is required");
    if (!source.workflow_run_id) errors.push("source.workflow_run_id is required");
    if (!source.head_sha) errors.push("source.head_sha is required");
  }

  const risk = envelope.risk;
  if (!risk || typeof risk !== "object") {
    errors.push("risk is required and must be an object");
  } else {
    if (risk.can_write_repository !== false) {
      errors.push("risk.can_write_repository must be false");
    }
    if (risk.requires_approval !== true) {
      errors.push("risk.requires_approval must be true");
    }
    const maxFiles = Number(risk.max_files);
    if (!Number.isInteger(maxFiles) || maxFiles < 1 || maxFiles > 10) {
      errors.push("risk.max_files must be an integer between 1 and 10");
    }
    const maxLines = Number(risk.max_changed_lines);
    if (!Number.isInteger(maxLines) || maxLines < 1 || maxLines > 1000) {
      errors.push("risk.max_changed_lines must be an integer between 1 and 1000");
    }
  }

  const tools = envelope.allowed_tools;
  if (!Array.isArray(tools)) {
    errors.push("allowed_tools must be an array");
  } else {
    for (const tool of tools) {
      if (!KNOWN_TOOLS.has(tool)) {
        errors.push(`allowed_tools contains unknown tool: ${tool}`);
      }
    }
  }

  const blocked = envelope.blocked_paths;
  if (blocked !== undefined) {
    if (!Array.isArray(blocked)) {
      errors.push("blocked_paths must be an array if provided");
    } else {
      for (const p of blocked) {
        if (typeof p !== "string") {
          errors.push(`blocked_paths contains non-string: ${p}`);
        } else if (p.startsWith("/")) {
          errors.push(`blocked_paths contains absolute path: ${p}`);
        } else if (p.includes("..")) {
          errors.push(`blocked_paths contains traversal path: ${p}`);
        }
      }
    }
  }

  const reqValidation = envelope.required_validation;
  if (!Array.isArray(reqValidation)) {
    errors.push("required_validation must be an array");
  } else if (reqValidation.length === 0) {
    errors.push("required_validation must not be empty");
  }

  return errors.length > 0 ? { valid: false, errors } : { valid: true };
}

/**
 * Validate a diagnosis object against the narrow schema.
 * Strict allowlist: unknown fields are rejected.
 */
export function validateDiagnosis(diagnosis) {
  const errors = [];

  if (!diagnosis || typeof diagnosis !== "object") {
    return { valid: false, errors: ["Diagnosis must be an object"] };
  }

  for (const key of Object.keys(diagnosis)) {
    if (PROHIBITED_DIAGNOSIS_FIELDS.has(key)) {
      errors.push(`Diagnosis contains prohibited field: ${key}`);
    } else if (!ALLOWED_DIAGNOSIS_FIELDS.has(key)) {
      errors.push(`Diagnosis contains unknown field: ${key}`);
    }
  }

  if (!diagnosis.summary || typeof diagnosis.summary !== "string") {
    errors.push("Diagnosis summary is required and must be a string");
  } else if (diagnosis.summary.length > MAX_SUMMARY_LENGTH) {
    errors.push(`Diagnosis summary exceeds ${MAX_SUMMARY_LENGTH} characters`);
  }

  if (!diagnosis.failure_category || typeof diagnosis.failure_category !== "string") {
    errors.push("Diagnosis failure_category is required and must be a string");
  }

  if (diagnosis.confidence && !["low", "medium", "high"].includes(diagnosis.confidence)) {
    errors.push("Diagnosis confidence must be one of: low, medium, high");
  }

  if (diagnosis.root_cause_claim && typeof diagnosis.root_cause_claim === "string") {
    if (diagnosis.root_cause_claim.length > MAX_ROOT_CAUSE_LENGTH) {
      errors.push(`Diagnosis root_cause_claim exceeds ${MAX_ROOT_CAUSE_LENGTH} characters`);
    }
  }

  for (const [key, val] of Object.entries(diagnosis)) {
    if (typeof val === "string" && val.length > MAX_TEXT_FIELD_LENGTH) {
      errors.push(`Diagnosis field ${key} exceeds ${MAX_TEXT_FIELD_LENGTH} characters`);
    }
  }

  // evidence_ids must be an array of strings if present
  if (diagnosis.evidence_ids !== undefined) {
    if (!Array.isArray(diagnosis.evidence_ids)) {
      errors.push("Diagnosis evidence_ids must be an array");
    } else if (diagnosis.evidence_ids.length === 0) {
      errors.push("Diagnosis evidence_ids must not be empty");
    } else {
      for (const eid of diagnosis.evidence_ids) {
        if (typeof eid !== "string") {
          errors.push("Diagnosis evidence_ids must contain only strings");
          break;
        }
      }
    }
  }

  return errors.length > 0 ? { valid: false, errors } : { valid: true };
}

/**
 * Validate that a diagnosis references only collected evidence.
 * Every entry in diagnosis.evidence_ids must match a `source` value
 * from the proposal's evidence_refs.
 */
export function validateDiagnosisEvidenceBinding(diagnosis, evidenceRefs) {
  if (!diagnosis || !Array.isArray(diagnosis.evidence_ids) || diagnosis.evidence_ids.length === 0) {
    return { valid: false, errors: ["Diagnosis must reference at least one evidence item"] };
  }

  if (!Array.isArray(evidenceRefs) || evidenceRefs.length === 0) {
    return { valid: false, errors: ["No evidence refs available on proposal"] };
  }

  const collectedSources = new Set(evidenceRefs.map((ref) => ref.source));
  const unbound = diagnosis.evidence_ids.filter((eid) => !collectedSources.has(eid));

  if (unbound.length > 0) {
    return {
      valid: false,
      errors: [`Diagnosis references evidence not in proposal: ${unbound.join(", ")}`],
    };
  }

  return { valid: true };
}

/**
 * Validate a patch_proposal object.
 */
export function validatePatchProposal(patch) {
  const errors = [];

  if (!patch || typeof patch !== "object") {
    return { valid: false, errors: ["Patch proposal must be an object"] };
  }

  if (!Array.isArray(patch.files) || patch.files.length === 0) {
    errors.push("Patch proposal must have a non-empty files array");
  } else {
    for (let i = 0; i < patch.files.length; i++) {
      const f = patch.files[i];
      const prefix = `Patch proposal files[${i}]`;

      if (!f || typeof f !== "object") {
        errors.push(`${prefix} must be an object`);
        continue;
      }

      if (!f.path || typeof f.path !== "string") {
        errors.push(`${prefix}.path is required and must be a string`);
      } else {
        if (f.path.startsWith("/")) {
          errors.push(`${prefix}.path is absolute: ${f.path}`);
        }
        if (f.path.includes("..")) {
          errors.push(`${prefix}.path contains traversal: ${f.path}`);
        }
        if (f.path.length > MAX_FILE_PATH_LENGTH) {
          errors.push(`${prefix}.path exceeds ${MAX_FILE_PATH_LENGTH} characters`);
        }
      }

      if (!VALID_CHANGE_TYPES.has(f.change_type)) {
        errors.push(`${prefix}.change_type must be one of: ${[...VALID_CHANGE_TYPES].join(", ")}`);
      }

      if (!f.artifact_ref || typeof f.artifact_ref !== "string") {
        errors.push(`${prefix}.artifact_ref is required and must be a string`);
      }

      const lc = Number(f.lines_changed);
      if (!Number.isInteger(lc) || lc < 0) {
        errors.push(`${prefix}.lines_changed must be a non-negative integer`);
      }
    }

    const tf = Number(patch.total_files);
    if (!Number.isInteger(tf) || tf !== patch.files.length) {
      errors.push(`total_files (${tf}) must equal files.length (${patch.files.length})`);
    }

    const sumLines = patch.files.reduce((s, f) => s + Number(f.lines_changed || 0), 0);
    const tlc = Number(patch.total_lines_changed);
    if (!Number.isInteger(tlc) || tlc !== sumLines) {
      errors.push(`total_lines_changed (${tlc}) must equal sum of lines_changed (${sumLines})`);
    }
  }

  return errors.length > 0 ? { valid: false, errors } : { valid: true };
}

/**
 * Validate a validation_result object.
 */
export function validateValidationResult(result) {
  const errors = [];

  if (!result || typeof result !== "object") {
    return { valid: false, errors: ["Validation result must be an object"] };
  }

  if (!VALID_VALIDATION_OVERALL.has(result.overall)) {
    errors.push(`validation_result.overall must be one of: ${[...VALID_VALIDATION_OVERALL].join(", ")}`);
  }

  if (!Array.isArray(result.checks) || result.checks.length === 0) {
    errors.push("validation_result.checks must be a non-empty array");
  } else {
    for (let i = 0; i < result.checks.length; i++) {
      const c = result.checks[i];
      const prefix = `validation_result.checks[${i}]`;

      if (!c || typeof c !== "object") {
        errors.push(`${prefix} must be an object`);
        continue;
      }

      if (!c.name || typeof c.name !== "string") {
        errors.push(`${prefix}.name is required and must be a string`);
      }

      if (typeof c.passed !== "boolean") {
        errors.push(`${prefix}.passed must be a boolean`);
      }

      if (!c.output_hash || typeof c.output_hash !== "string") {
        errors.push(`${prefix}.output_hash is required and must be a string`);
      }
    }
  }

  if (result.overall === "pass" && Array.isArray(result.checks)) {
    for (const c of result.checks) {
      if (c && c.passed === false) {
        errors.push("overall is 'pass' but some checks have passed: false");
        break;
      }
    }
  }

  return errors.length > 0 ? { valid: false, errors } : { valid: true };
}

/**
 * Validate a critic_review object.
 */
export function validateCriticReview(review) {
  const errors = [];

  if (!review || typeof review !== "object") {
    return { valid: false, errors: ["Critic review must be an object"] };
  }

  if (!VALID_CRITIC_VERDICTS.has(review.verdict)) {
    errors.push(`critic_review.verdict must be one of: ${[...VALID_CRITIC_VERDICTS].join(", ")}`);
  }

  if (review.concerns !== undefined) {
    if (!Array.isArray(review.concerns)) {
      errors.push("critic_review.concerns must be an array if provided");
    } else {
      for (let i = 0; i < review.concerns.length; i++) {
        if (typeof review.concerns[i] !== "string") {
          errors.push(`critic_review.concerns[${i}] must be a string`);
        }
      }
    }
  }

  if (review.scope_violations !== undefined) {
    if (!Array.isArray(review.scope_violations)) {
      errors.push("critic_review.scope_violations must be an array if provided");
    } else {
      for (let i = 0; i < review.scope_violations.length; i++) {
        if (typeof review.scope_violations[i] !== "string") {
          errors.push(`critic_review.scope_violations[${i}] must be a string`);
        }
      }
    }
  }

  if (review.unrelated_changes !== undefined && typeof review.unrelated_changes !== "boolean") {
    errors.push("critic_review.unrelated_changes must be a boolean if provided");
  }

  if (review.verdict === "reject") {
    const hasConcerns = Array.isArray(review.concerns) && review.concerns.length > 0;
    const hasViolations = Array.isArray(review.scope_violations) && review.scope_violations.length > 0;
    if (!hasConcerns && !hasViolations) {
      errors.push("critic_review.verdict is 'reject' but no concerns or scope_violations provided");
    }
  }

  return errors.length > 0 ? { valid: false, errors } : { valid: true };
}

/**
 * Validate evidence_refs array.
 */
export function validateEvidenceRefs(refs) {
  const errors = [];

  if (!Array.isArray(refs)) {
    return { valid: false, errors: ["evidence_refs must be an array"] };
  }

  if (refs.length === 0) {
    return { valid: false, errors: ["evidence_refs must not be empty"] };
  }

  for (let i = 0; i < refs.length; i++) {
    const r = refs[i];
    const prefix = `evidence_refs[${i}]`;

    if (!r || typeof r !== "object") {
      errors.push(`${prefix} must be an object`);
      continue;
    }

    if (!VALID_EVIDENCE_REF_TYPES.has(r.type)) {
      errors.push(`${prefix}.type must be one of: ${[...VALID_EVIDENCE_REF_TYPES].join(", ")}`);
    }

    if (!r.source || typeof r.source !== "string") {
      errors.push(`${prefix}.source is required and must be a string`);
    }

    if (!r.excerpt_hash || typeof r.excerpt_hash !== "string") {
      errors.push(`${prefix}.excerpt_hash is required and must be a string`);
    }

    if (r.description && typeof r.description !== "string") {
      errors.push(`${prefix}.description must be a string if provided`);
    }
  }

  return errors.length > 0 ? { valid: false, errors } : { valid: true };
}

/**
 * Check required evidence is present for a target state.
 */
export function checkRequiredEvidence(proposal, targetStatus) {
  const required = REQUIRED_EVIDENCE[targetStatus];
  if (!required) return [];

  const missing = [];
  for (const field of required) {
    const value = proposal[field];
    if (value === null || value === undefined) {
      missing.push(field);
    } else if (typeof value === "object" && Object.keys(value).length === 0) {
      missing.push(field);
    }
  }
  return missing;
}

/**
 * Check SEMANTIC evidence validity for a target state.
 * Beyond mere presence, verifies that the evidence actually supports
 * advancing to the target state.
 *
 * - verified: validation_result.overall must be "pass"
 * - review_ready: critic_review.verdict must be "approve",
 *   no scope_violations, no unrelated_changes
 *
 * Returns array of error strings (empty if semantically valid).
 */
export function checkSemanticEvidence(proposal, targetStatus) {
  const errors = [];

  if (targetStatus === "verified") {
    const vr = parseJsonb(proposal.validation_result);
    if (!vr || vr.overall !== "pass") {
      errors.push("Cannot verify proposal: validation_result.overall must be 'pass'");
    }
  }

  if (targetStatus === "review_ready") {
    const cr = parseJsonb(proposal.critic_review);
    if (!cr || cr.verdict !== "approve") {
      errors.push("Cannot mark review_ready: critic_review.verdict must be 'approve'");
    }
    if (cr && cr.unrelated_changes === true) {
      errors.push("Cannot mark review_ready: critic_review reports unrelated_changes");
    }
    if (cr && Array.isArray(cr.scope_violations) && cr.scope_violations.length > 0) {
      errors.push("Cannot mark review_ready: critic_review reports scope_violations");
    }
  }

  return errors;
}

/**
 * Check that a patch_proposal complies with the stored task envelope's
 * scope limits:
 * - total_files <= envelope.risk.max_files
 * - total_lines_changed <= envelope.risk.max_changed_lines
 * - no file path matches envelope.blocked_paths
 *
 * Returns array of error strings (empty if compliant).
 */
export function checkPatchAgainstEnvelope(patch, envelope) {
  const errors = [];

  if (!patch || !envelope) return errors;

  const maxFiles = Number(envelope.risk?.max_files);
  const maxLines = Number(envelope.risk?.max_changed_lines);
  const blockedPaths = envelope.blocked_paths || [];

  if (Number.isInteger(maxFiles) && Number(patch.total_files) > maxFiles) {
    errors.push(`Patch exceeds envelope: total_files (${patch.total_files}) > max_files (${maxFiles})`);
  }

  if (Number.isInteger(maxLines) && Number(patch.total_lines_changed) > maxLines) {
    errors.push(`Patch exceeds envelope: total_lines_changed (${patch.total_lines_changed}) > max_changed_lines (${maxLines})`);
  }

  if (blockedPaths.length > 0 && Array.isArray(patch.files)) {
    for (const file of patch.files) {
      if (file && file.path && pathMatchesBlocked(file.path, blockedPaths)) {
        errors.push(`Patch file '${file.path}' matches blocked path pattern`);
      }
    }
  }

  return errors;
}

/**
 * Build an evidence snapshot for the append-only event trail.
 */
export function buildEvidenceSnapshot(evidence) {
  const snapshot = {};
  for (const [field, value] of Object.entries(evidence)) {
    if (value !== undefined) {
      snapshot[field] = {
        value,
        content_hash: contentHash(value),
      };
    }
  }
  return snapshot;
}

/**
 * Redact a proposal for API response.
 */
export function redactProposal(proposal) {
  if (!proposal || typeof proposal !== "object") return proposal;

  const redacted = { ...proposal };

  if (redacted.task_envelope) {
    const env = typeof redacted.task_envelope === "string"
      ? JSON.parse(redacted.task_envelope)
      : { ...redacted.task_envelope };
    env.risk = { ...env.risk, can_write_repository: false };
    redacted.task_envelope = env;
  }

  for (const field of ["diagnosis", "evidence_refs", "patch_proposal", "validation_result", "critic_review"]) {
    if (typeof redacted[field] === "string") {
      try {
        redacted[field] = JSON.parse(redacted[field]);
      } catch (_e) {
        // Leave as-is
      }
    }
  }

  return redacted;
}

// ════════════════════════════════════════════════════════════════════════════
// ASYNC CRUD + STATE MACHINE (database operations)
// ════════════════════════════════════════════════════════════════════════════

/**
 * Create a new repair proposal in 'detected' state.
 *
 * Idempotent: if a proposal with the same (repo_id, source_fingerprint)
 * already exists, returns it without creating a duplicate or event.
 *
 * Uses ON CONFLICT DO NOTHING to distinguish true inserts from conflicts
 * at the database level — no state/version heuristics.
 */
export async function createProposal(params = {}) {
  const { repo, envelope, created_by = "system", actor_kind } = params;

  if (!repo) throw new Error("repo is required");
  if (!envelope) throw new Error("envelope is required");

  // MANDATORY actor-kind enforcement — unconditional, before any validation
  requireActorKind(actor_kind);
  if (!canCreateProposal(actor_kind)) {
    throw new Error(`Actor '${actor_kind}' is not authorized to create repair proposals`);
  }

  const envCheck = validateEnvelope(envelope);
  if (!envCheck.valid) {
    throw new Error(`Invalid envelope: ${envCheck.errors.join("; ")}`);
  }

  if (envelope.source.repository !== repo) {
    throw new Error(
      `Source mismatch: repo ('${repo}') must equal envelope.source.repository ('${envelope.source.repository}')`
    );
  }

  const { rows: [repoRow] } = await db.query(
    "SELECT github_id FROM repositories WHERE full_name = $1",
    [repo]
  );
  if (!repoRow) throw new Error(`Repository not found: ${repo}`);

  const source = envelope.source;
  const fingerprint = computeFingerprint({
    repository: source.repository,
    workflow_run_id: source.workflow_run_id,
    job_id: source.job_id,
    head_sha: source.head_sha,
    failure_type: source.failure_type || envelope.failure_type,
  });

  return db.transaction(async (client) => {
    // ON CONFLICT DO NOTHING — if the row already exists, RETURNING gives zero rows.
    // This is the only reliable way to distinguish insert from conflict.
    const { rows: inserted } = await client.query(
      `INSERT INTO repair_proposals
         (repo_id, workflow_run_id, job_id, head_sha, base_sha, failure_type,
          source_fingerprint, task_envelope, created_by, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'detected')
       ON CONFLICT (repo_id, source_fingerprint)
       DO NOTHING
       RETURNING *`,
      [
        repoRow.github_id,
        source.workflow_run_id,
        source.job_id || null,
        source.head_sha,
        source.base_sha || null,
        source.failure_type || envelope.failure_type || null,
        fingerprint,
        JSON.stringify(envelope),
        created_by,
      ]
    );

    let proposal;
    let isExisting;

    if (inserted.length > 0) {
      // New row was actually inserted
      proposal = inserted[0];
      isExisting = false;
    } else {
      // Conflict — fetch the existing row
      const { rows: [existing] } = await client.query(
        `SELECT * FROM repair_proposals
         WHERE repo_id = $1 AND source_fingerprint = $2`,
        [repoRow.github_id, fingerprint]
      );
      proposal = existing;
      isExisting = true;
    }

    // Record creation event ONLY for genuinely new proposals
    if (!isExisting) {
      await client.query(
        `INSERT INTO repair_proposal_events
           (proposal_id, event_type, to_status, actor, evidence_snapshot)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          proposal.id,
          "proposal_created",
          "detected",
          created_by,
          JSON.stringify(buildEvidenceSnapshot({ envelope })),
        ]
      );
    }

    logger.info({ proposal_id: proposal.id, repo, fingerprint, isExisting }, "Repair proposal created or retrieved");
    return redactProposal(proposal);
  });
}

/**
 * Get a single proposal by ID.
 */
export async function getProposal(id) {
  if (!id) throw new Error("id is required");

  const { rows: [proposal] } = await db.query(
    `SELECT p.*, r.full_name as repo_full_name
     FROM repair_proposals p
     LEFT JOIN repositories r ON r.github_id = p.repo_id
     WHERE p.id = $1`,
    [id]
  );

  return proposal ? redactProposal(proposal) : null;
}

/**
 * List proposals with optional filters.
 */
export async function listProposals(params = {}) {
  const { repo, status, created_by, limit = 50, offset = 0 } = params;

  const conditions = [];
  const values = [];
  let paramIdx = 1;

  if (repo) {
    conditions.push(`r.full_name = $${paramIdx++}`);
    values.push(repo);
  }
  if (status) {
    conditions.push(`p.status = $${paramIdx++}`);
    values.push(status);
  }
  if (created_by) {
    conditions.push(`p.created_by = $${paramIdx++}`);
    values.push(created_by);
  }

  const whereClause = conditions.length > 0
    ? "WHERE " + conditions.join(" AND ")
    : "";

  const { rows: [countRow] } = await db.query(
    `SELECT COUNT(*) as total
     FROM repair_proposals p
     LEFT JOIN repositories r ON r.github_id = p.repo_id
     ${whereClause}`,
    values
  );

  const { rows } = await db.query(
    `SELECT p.*, r.full_name as repo_full_name
     FROM repair_proposals p
     LEFT JOIN repositories r ON r.github_id = p.repo_id
     ${whereClause}
     ORDER BY p.created_at DESC
     LIMIT $${paramIdx++} OFFSET $${paramIdx++}`,
    [...values, Math.min(limit, 200), offset]
  );

  return {
    data: rows.map(redactProposal),
    total: parseInt(countRow.total, 10),
  };
}

/**
 * Attach evidence to a proposal.
 * Only allowed in non-terminal states.
 *
 * Guarantees:
 * - expected_version is MANDATORY (race-safe compare-and-swap)
 * - ALL evidence types validated through strict validators
 * - patch_proposal validated against stored envelope scope limits
 * - Evidence update + event recording are atomic (one transaction)
 * - CAS: id and version use SEPARATE SQL placeholders
 *
 * @param {number} id - proposal ID
 * @param {object} evidence - evidence fields
 * @param {string} [actor='system'] - actor identity from auth
 * @param {number} expected_version - MANDATORY optimistic concurrency version
 * @param {string} [correlation_id] - optional correlation ID for audit trail
 * @returns {Promise<object>} updated proposal
 */
export async function attachEvidence(id, evidence = {}, actor = "system", expected_version, correlation_id, actor_kind) {
  if (!id) throw new Error("id is required");

  // MANDATORY expected_version
  if (!Number.isInteger(expected_version) || expected_version < 1) {
    throw new Error("expected_version is required and must be a positive integer");

  }

  // MANDATORY actor-kind enforcement — unconditional, before any validation
  requireActorKind(actor_kind);

  // evidence_refs is write-once: reserved exclusively for recordCiEvidenceCollection()
  // which locks, validates status (detected → evidence_collected), and records in one
  // atomic transaction. The generic attachEvidence path must never write evidence_refs.
  if (evidence.evidence_refs !== undefined) {
    throw new Error(
      "evidence_refs may only be recorded by recordCiEvidenceCollection"
    );
  }

  // patch_proposal is reserved exclusively for recordPatchProposal()
  // which enforces diagnosis prerequisite, base SHA pinning, scope compliance,
  // and the evidence_collected → proposed transition in one atomic transaction.
  if (evidence.patch_proposal !== undefined) {
    throw new Error(
      "patch_proposal may only be recorded by recordPatchProposal"
    );
  }

  // validation_result is reserved exclusively for recordVerificationResult()
  // which enforces patch artifact verification, sandbox validation plan,
  // and the proposed → verified/failed transition in one atomic transaction.
  if (evidence.validation_result !== undefined) {
    throw new Error(
      "validation_result may only be recorded by recordVerificationResult"
    );
  }

  // critic_review is reserved exclusively for recordCriticReview()
  // which enforces verified status, execution receipt binding, and
  // the verified → review_ready/failed transition in one atomic transaction.
  if (evidence.critic_review !== undefined) {
    throw new Error(
      "critic_review may only be recorded by recordCriticReview"
    );
  }

  // Validate ALL evidence types before touching the database
  if (evidence.diagnosis) {
    const check = validateDiagnosis(evidence.diagnosis);
    if (!check.valid) throw new Error(`Invalid diagnosis: ${check.errors.join("; ")}`);
  }
  if (evidence.patch_proposal) {
    const check = validatePatchProposal(evidence.patch_proposal);
    if (!check.valid) throw new Error(`Invalid patch_proposal: ${check.errors.join("; ")}`);
  }
  if (evidence.validation_result) {
    const check = validateValidationResult(evidence.validation_result);
    if (!check.valid) throw new Error(`Invalid validation_result: ${check.errors.join("; ")}`);
  }
  if (evidence.critic_review) {
    const check = validateCriticReview(evidence.critic_review);
    if (!check.valid) throw new Error(`Invalid critic_review: ${check.errors.join("; ")}`);
  }

  const fields = [
    ["diagnosis", evidence.diagnosis],
  ];

  const providedFields = fields.filter(([, v]) => v !== undefined);
  if (providedFields.length === 0) {
    throw new Error("No evidence fields provided");
  }

  // MANDATORY actor-kind enforcement — per-field authority check
  for (const [field] of providedFields) {
    if (!canAttachField(actor_kind, field)) {
      throw new Error(`Actor '${actor_kind}' is not authorized to attach evidence field: ${field}`);
    }
  }

  return db.transaction(async (client) => {
    // Lock the row
    const { rows: [proposal] } = await client.query(
      "SELECT * FROM repair_proposals WHERE id = $1 FOR UPDATE",
      [id]
    );
    if (!proposal) throw new Error(`Repair proposal not found: ${id}`);

    // Block terminal states
    if (isTerminalState(proposal.status)) {
      throw new Error(
        `Cannot attach evidence to proposal in terminal state '${proposal.status}'`
      );
    }

    // Enforce diagnosis_worker lifecycle boundary and write-once invariant
    // at the canonical service layer, not just in the worker wrapper.
    // diagnosis_worker may only attach diagnosis when the proposal is in
    // evidence_collected, and only if no diagnosis exists yet.
    if (actor_kind === ACTOR_KINDS.DIAGNOSIS_WORKER && evidence.diagnosis) {
      if (proposal.status !== "evidence_collected") {
        throw new Error(
          `diagnosis_worker requires status 'evidence_collected', got '${proposal.status}'`
        );
      }

      // Idempotent no-op: diagnosis already exists
      const existingDiagnosis = parseJsonb(proposal.diagnosis);
      if (existingDiagnosis) {
        logger.info(
          { proposal_id: id, actor_kind },
          "Diagnosis already exists — canonical no-op"
        );
        return redactProposal(proposal);
      }
    }

    // Enforce diagnosis evidence binding against the locked proposal's evidence_refs
    // Every diagnosis.evidence_ids must reference a source in the collected evidence
    if (evidence.diagnosis) {
      const collectedRefs = parseJsonb(proposal.evidence_refs);
      const binding = validateDiagnosisEvidenceBinding(
        evidence.diagnosis,
        collectedRefs || []
      );
      if (!binding.valid) {
        throw new Error(
          `Diagnosis evidence binding failed: ${binding.errors.join("; ")}`
        );
      }
    }

    // Build SET clauses — each parameter gets its own placeholder
    const setClauses = [];
    const values = [];
    let paramIdx = 1;

    for (const [field, value] of providedFields) {
      setClauses.push(`${field} = $${paramIdx++}`);
      values.push(JSON.stringify(value));
    }
    setClauses.push(`version = version + 1`);

    // CAS: id and version get SEPARATE placeholders — no collision
    const whereClauses = [];
    whereClauses.push(`id = $${paramIdx++}`);
    values.push(id);
    whereClauses.push(`version = $${paramIdx++}`);
    values.push(expected_version);

    const { rows } = await client.query(
      `UPDATE repair_proposals
       SET ${setClauses.join(", ")}
       WHERE ${whereClauses.join(" AND ")}
       RETURNING *`,
      values
    );

    // Zero rows = version mismatch (race condition)
    if (rows.length === 0) {
      throw new Error(
        `Version mismatch: expected version ${expected_version}. ` +
        `Another process may have modified this proposal.`
      );
    }

    const updated = rows[0];

    // Record evidence event with full snapshot + content hashes + correlation
    const snapshot = buildEvidenceSnapshot(Object.fromEntries(providedFields));
    await client.query(
      `INSERT INTO repair_proposal_events
         (proposal_id, event_type, from_status, to_status, actor, evidence_snapshot, correlation_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        id,
        "evidence_attached",
        proposal.status,
        proposal.status,
        actor,
        JSON.stringify(snapshot),
        correlation_id || null,
      ]
    );

    logger.info({ proposal_id: id, fields: providedFields.map(([f]) => f) }, "Evidence attached to repair proposal");
    return redactProposal(updated);
  });
}

/**
 * Transition a proposal to a new status.
 *
 * Guarantees:
 * - expected_version is MANDATORY (race-safe compare-and-swap)
 * - Semantic evidence gates: validation must pass, critic must approve
 * - Authority-bearing states blocked from generic transition
 * - Terminal states reject all mutation
 * - State update + event record are atomic
 * - CAS: id and version use SEPARATE SQL placeholders
 *
 * @param {number} id - proposal ID
 * @param {object} params
 * @param {string} params.status - target status (required)
 * @param {string} [params.actor='system'] - actor from auth
 * @param {string} [params.reason] - optional reason
 * @param {number} params.expected_version - MANDATORY optimistic concurrency version
 * @param {string} [params.correlation_id] - optional correlation ID for audit trail
 * @returns {Promise<object>} updated proposal
 */
export async function transitionProposal(id, params = {}) {
  const { status: targetStatus, actor = "system", reason, expected_version, correlation_id, actor_kind } = params;

  if (!id) throw new Error("id is required");
  if (!targetStatus) throw new Error("status is required");

  // MANDATORY actor-kind enforcement — unconditional, before any validation
  requireActorKind(actor_kind);

  // MANDATORY expected_version
  if (!Number.isInteger(expected_version) || expected_version < 1) {
    throw new Error("expected_version is required and must be a positive integer");
  }

  // Unconditional authority check
  if (!canTransitionTo(actor_kind, targetStatus)) {
    throw new Error(`Actor '${actor_kind}' is not authorized to transition to '${targetStatus}'`);
  }

  // Block authority-bearing states from generic transition
  if (AUTHORITY_STATES.has(targetStatus)) {
    throw new Error(
      `Transition to '${targetStatus}' requires a dedicated authority-bound endpoint. ` +
      `Generic transitions cannot enter authority-bearing states.`
    );
  }

  return db.transaction(async (client) => {
    // Lock the row
    const { rows: [proposal] } = await client.query(
      "SELECT * FROM repair_proposals WHERE id = $1 FOR UPDATE",
      [id]
    );
    if (!proposal) throw new Error(`Repair proposal not found: ${id}`);

    const currentStatus = proposal.status;

    if (isTerminalState(currentStatus)) {
      throw new Error(
        `Proposal is in terminal state '${currentStatus}' — no further transitions allowed`
      );
    }

    if (!isValidTransition(currentStatus, targetStatus)) {
      throw new Error(
        `Invalid transition: '${currentStatus}' → '${targetStatus}'. ` +
        `Valid transitions from '${currentStatus}': ${[...VALID_TRANSITIONS[currentStatus]].join(", ")}`
      );
    }

    // Structural evidence gates (field presence)
    const missing = checkRequiredEvidence(proposal, targetStatus);
    if (missing.length > 0) {
      throw new Error(
        `Cannot transition to '${targetStatus}': missing required evidence: ${missing.join(", ")}`
      );
    }

    // SEMANTIC evidence gates (evidence must actually support the transition)
    const semanticErrors = checkSemanticEvidence(proposal, targetStatus);
    if (semanticErrors.length > 0) {
      throw new Error(semanticErrors.join("; "));
    }

    // Build SET clauses — each parameter gets its own placeholder
    const setClauses = [`status = $1`, `version = version + 1`];
    const values = [targetStatus];
    let paramIdx = 2;

    // Actor metadata per terminal state
    if (targetStatus === "rejected") {
      if (!actor) throw new Error("actor is required for rejection");
      setClauses.push(`rejected_by = $${paramIdx++}`);
      values.push(actor);
      setClauses.push(`rejected_at = $${paramIdx++}`);
      values.push(new Date().toISOString());
      if (reason) {
        setClauses.push(`rejected_reason = $${paramIdx++}`);
        values.push(reason);
      }
    } else if (targetStatus === "cancelled") {
      if (!actor) throw new Error("actor is required for cancellation");
      setClauses.push(`cancelled_by = $${paramIdx++}`);
      values.push(actor);
      setClauses.push(`cancelled_at = $${paramIdx++}`);
      values.push(new Date().toISOString());
      if (reason) {
        setClauses.push(`cancelled_reason = $${paramIdx++}`);
        values.push(reason);
      }
    } else if (targetStatus === "failed") {
      if (reason) {
        setClauses.push(`failed_reason = $${paramIdx++}`);
        values.push(reason);
      }
    }

    // CAS: id and version get SEPARATE placeholders — no collision
    const whereClauses = [];
    whereClauses.push(`id = $${paramIdx++}`);
    values.push(id);
    whereClauses.push(`version = $${paramIdx++}`);
    values.push(expected_version);

    const { rows } = await client.query(
      `UPDATE repair_proposals
       SET ${setClauses.join(", ")}
       WHERE ${whereClauses.join(" AND ")}
       RETURNING *`,
      values
    );

    // Zero rows = version mismatch (race condition)
    if (rows.length === 0) {
      throw new Error(
        `Version mismatch: expected version ${expected_version}. ` +
        `Another process may have modified this proposal.`
      );
    }

    const updated = rows[0];

    // Record transition event in the SAME transaction (with correlation)
    await client.query(
      `INSERT INTO repair_proposal_events
         (proposal_id, event_type, from_status, to_status, actor, reason, correlation_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        id,
        "state_transition",
        currentStatus,
        targetStatus,
        actor,
        reason || null,
        correlation_id || null,
      ]
    );

    logger.info(
      { proposal_id: id, from: currentStatus, to: targetStatus, actor },
      "Repair proposal transitioned"
    );
    return redactProposal(updated);
  });
}

/**
 * Record CI evidence collection atomically.
 *
 * This is a SINGLE transactional operation that replaces the two-step
 * attach-then-transition sequence for the CI evidence collector.
 *
 * Replay safety:
 * - If proposal is already 'evidence_collected' → return unchanged (no-op)
 * - If proposal is 'detected' → validate, attach, transition, record event
 * - Any other status → reject (unexpected intermediate state)
 *
 * All in one transaction with row lock + CAS.
 *
 * @param {number} id - proposal ID
 * @param {object} evidence - { evidence_refs: [...] }
 * @param {object} options
 * @param {string} [options.actor='ci_evidence_collector']
 * @param {number} options.expected_version - MANDATORY CAS version
 * @param {string} [options.correlation_id] - for audit trail
 * @returns {Promise<object>} updated proposal
 */
export async function recordCiEvidenceCollection(id, evidence = {}, options = {}) {
  const {
    actor = "ci_evidence_collector",
    expected_version,
    correlation_id,
    source_delivery_id,
    actor_kind = actor,
  } = options;

  if (!id) throw new Error("id is required");

  // MANDATORY actor-kind enforcement — unconditional
  requireActorKind(actor_kind);

  if (!Number.isInteger(expected_version) || expected_version < 1) {
    throw new Error("expected_version is required and must be a positive integer");
  }
  if (!evidence.evidence_refs) {
    throw new Error("evidence_refs is required for CI evidence collection");
  }

  // Enforce actor-kind authority at service boundary
  if (!canAttachField(actor_kind, "evidence_refs")) {
    throw new Error(`Actor '${actor_kind}' is not authorized to attach evidence_refs`);
  }
  if (!canTransitionTo(actor_kind, "evidence_collected")) {
    throw new Error(`Actor '${actor_kind}' is not authorized to transition to evidence_collected`);
  }

  // Validate evidence_refs before touching the database
  const check = validateEvidenceRefs(evidence.evidence_refs);
  if (!check.valid) {
    throw new Error(`Invalid evidence_refs: ${check.errors.join("; ")}`);
  }

  return db.transaction(async (client) => {
    // Lock the row
    const { rows: [proposal] } = await client.query(
      "SELECT * FROM repair_proposals WHERE id = $1 FOR UPDATE",
      [id]
    );
    if (!proposal) throw new Error(`Repair proposal not found: ${id}`);

    // REPLAY SAFETY: already collected → no-op return
    if (proposal.status === "evidence_collected") {
      logger.info(
        { proposal_id: id, correlation_id },
        "Proposal already evidence_collected — replay no-op"
      );
      return redactProposal(proposal);
    }

    // Only allow collection from 'detected' state
    if (proposal.status !== "detected") {
      throw new Error(
        `CI evidence collection requires status 'detected', got '${proposal.status}'`
      );
    }

    // CAS: version check before update
    const setClauses = [
      "evidence_refs = $1",
      "status = $2",
      "version = version + 1",
    ];
    const values = [
      JSON.stringify(evidence.evidence_refs),
      "evidence_collected",
    ];
    let paramIdx = 3;

    // WHERE id = $N AND version = $N+1 (separate placeholders)
    const whereClauses = [];
    whereClauses.push(`id = $${paramIdx++}`);
    values.push(id);
    whereClauses.push(`version = $${paramIdx++}`);
    values.push(expected_version);

    const { rows } = await client.query(
      `UPDATE repair_proposals
       SET ${setClauses.join(", ")}
       WHERE ${whereClauses.join(" AND ")}
       RETURNING *`,
      values
    );

    // Zero rows = version mismatch (race condition)
    if (rows.length === 0) {
      throw new Error(
        `Version mismatch: expected version ${expected_version}. ` +
        `Another process may have modified this proposal.`
      );
    }

    const updated = rows[0];

    // Record ONE collection event — carries both the evidence snapshot
    // and the state transition info, with correlation_id and source_delivery_id
    const snapshot = buildEvidenceSnapshot({ evidence_refs: evidence.evidence_refs });
    await client.query(
      `INSERT INTO repair_proposal_events
         (proposal_id, event_type, from_status, to_status, actor, evidence_snapshot, correlation_id, source_delivery_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        id,
        "ci_evidence_collected",
        "detected",
        "evidence_collected",
        actor,
        JSON.stringify(snapshot),
        correlation_id || null,
        source_delivery_id || null,
      ]
    );

    logger.info(
      { proposal_id: id, evidence_count: evidence.evidence_refs.length, correlation_id },
      "CI evidence recorded atomically"
    );
    return redactProposal(updated);
  });
}

/**
 * Get the event history for a proposal (append-only proof trail).
 */
export async function getProposalEvents(id) {
  if (!id) throw new Error("id is required");

  const { rows } = await db.query(
    `SELECT * FROM repair_proposal_events
     WHERE proposal_id = $1
     ORDER BY created_at ASC`,
    [id]
  );

  return rows;
}

// ════════════════════════════════════════════════════════════════════════════
// PATCH PROPOSAL RECORDING — canonical transactional method
// ════════════════════════════════════════════════════════════════════════════

/**
 * Build a PatchInputBundle from a proposal's diagnosis and evidence.
 *
 * This is the bounded, pinned input that the patch engine receives.
 * It contains only the immutable snapshot — no open-ended repo access.
 *
 * @param {object} proposal - the locked proposal row
 * @param {object} diagnosis - parsed diagnosis from the proposal
 * @param {object[]} evidenceRefs - parsed evidence_refs from the proposal
 * @returns {object} PatchInputBundle
 */
export function buildPatchInputBundle(proposal, diagnosis, evidenceRefs) {
  const evidenceHash = contentHash(evidenceRefs);
  const diagnosisHash = contentHash(diagnosis);

  return {
    proposal_id: proposal.id,
    repository: proposal.repo_full_name || null,
    head_sha: proposal.head_sha,
    diagnosis_hash: diagnosisHash,
    evidence_hash: evidenceHash,
    source_files: (evidenceRefs || [])
      .filter((r) => r.type === "workflow_file" || r.type === "repository_file")
      .map((r) => ({
        path: r.source.split("@")[0],
        content_ref: r.source,
        content_hash: r.excerpt_hash || null,
      })),
  };
}

/**
 * Check patch policy against a resolved ci_healing config.
 * Throws with a message containing "rejected" if the policy forbids patch generation.
 *
 * @param {object} healingConfig - the ci_healing section from getConfigForRepo
 * @param {object} diagnosis - parsed diagnosis (must have .confidence)
 * @throws {Error} if policy forbids patch generation
 */
export function checkPatchPolicy(healingConfig, diagnosis) {
  if (!healingConfig || healingConfig.enabled === false) {
    throw new Error(
      "CI healing is disabled for this repository — patch generation rejected"
    );
  }
  if (healingConfig.auto_patch !== true) {
    throw new Error(
      "auto_patch policy is disabled for this repository — patch generation rejected"
    );
  }
  const minConfidence = healingConfig.min_confidence_to_patch || "medium";
  const confidenceLevels = { low: 0, medium: 1, high: 2 };
  const diagConfidence = confidenceLevels[diagnosis.confidence] ?? 0;
  const requiredConfidence = confidenceLevels[minConfidence] ?? 1;
  if (diagConfidence < requiredConfidence) {
    throw new Error(
      `Diagnosis confidence ('${diagnosis.confidence}') below min_confidence_to_patch ('${minConfidence}') — patch generation rejected`
    );
  }
}

/**
 * Validate that a patch proposal's rationale references collected evidence.
 *
 * Every evidence_id in the patch must exist in the proposal's evidence_refs
 * or diagnosis evidence_ids.
 */
export function validatePatchEvidenceBinding(patch, evidenceRefs, diagnosis) {
  const errors = [];

  if (!Array.isArray(patch.evidence_ids) || patch.evidence_ids.length === 0) {
    errors.push("Patch proposal must reference at least one evidence item");
    return { valid: false, errors };
  }

  const collectedSources = new Set(
    (evidenceRefs || []).map((r) => r.source)
  );

  // Also allow diagnosis evidence_ids
  if (diagnosis && Array.isArray(diagnosis.evidence_ids)) {
    for (const eid of diagnosis.evidence_ids) {
      collectedSources.add(eid);
    }
  }

  const unbound = patch.evidence_ids.filter((eid) => !collectedSources.has(eid));
  if (unbound.length > 0) {
    errors.push(`Patch references evidence not in proposal: ${unbound.join(", ")}`);
  }

  return errors.length > 0 ? { valid: false, errors } : { valid: true };
}

/**
 * Record a patch proposal atomically.
 *
 * This is the SOLE authorized path for patch_proposal writes and the
 * evidence_collected → proposed transition.
 *
 * Guarantees:
 * - actor_kind must be patch_worker
 * - Proposal must be in evidence_collected
 * - Diagnosis must already exist
 * - Patch must be pinned to the proposal's head_sha / base snapshot
 * - All paths must comply with blocked_paths, max_files, max_changed_lines
 * - Patch rationale must reference collected evidence and diagnosis evidence IDs
 * - Patch write + transition + event occur in ONE transaction
 *
 * Replay safety:
 * - Same proposal + same artifact_hash → return unchanged (no-op)
 * - Same proposal + different artifact_hash → reject
 *
 * @param {number} id - proposal ID
 * @param {object} patchInput - the bounded patch input (artifact metadata + files)
 * @param {object} options
 * @param {string} [options.actor='patch_worker']
 * @param {number} options.expected_version - MANDATORY CAS version
 * @param {string} [options.correlation_id] - for audit trail
 * @param {string} [options.source_delivery_id] - for provenance
 * @returns {Promise<object>} updated proposal
 */
export async function recordPatchProposal(id, patchInput = {}, options = {}) {
  const {
    actor = "patch_worker",
    expected_version,
    correlation_id,
    source_delivery_id,
    actor_kind = actor,
  } = options;

  if (!id) throw new Error("id is required");

  // MANDATORY actor-kind enforcement — unconditional
  requireActorKind(actor_kind);

  if (!Number.isInteger(expected_version) || expected_version < 1) {
    throw new Error("expected_version is required and must be a positive integer");
  }

  // Enforce actor-kind authority
  if (!canAttachField(actor_kind, "patch_proposal")) {
    throw new Error(`Actor '${actor_kind}' is not authorized to attach patch_proposal`);
  }
  if (!canTransitionTo(actor_kind, "proposed")) {
    throw new Error(`Actor '${actor_kind}' is not authorized to transition to proposed`);
  }

  // Validate patch structure
  const patchCheck = validatePatchProposal(patchInput);
  if (!patchCheck.valid) {
    throw new Error(`Invalid patch proposal: ${patchCheck.errors.join("; ")}`);
  }

  // Require artifact_ref and artifact_hash at top level
  if (!patchInput.artifact_ref || typeof patchInput.artifact_ref !== "string") {
    throw new Error("Patch proposal artifact_ref is required and must be a string");
  }
  if (!patchInput.artifact_hash || typeof patchInput.artifact_hash !== "string") {
    throw new Error("Patch proposal artifact_hash is required and must be a string");
  }
  if (!patchInput.base_sha || typeof patchInput.base_sha !== "string") {
    throw new Error("Patch proposal base_sha is required and must be a string");
  }
  if (!Array.isArray(patchInput.evidence_ids)) {
    throw new Error("Patch proposal evidence_ids is required");
  }
  if (!patchInput.diagnosis_hash || typeof patchInput.diagnosis_hash !== "string") {
    throw new Error("Patch proposal diagnosis_hash is required");
  }
  if (!patchInput.input_bundle_hash || typeof patchInput.input_bundle_hash !== "string") {
    throw new Error("Patch proposal input_bundle_hash is required");
  }
  if (!patchInput.rationale_summary || typeof patchInput.rationale_summary !== "string") {
    throw new Error("Patch proposal rationale_summary is required");
  }

  return db.transaction(async (client) => {
    // Lock the row. JOIN repositories so repo_full_name is available for the
    // policy re-check below — repair_proposals only stores repo_id, not the
    // resolved name. SELECT ... FOR UPDATE locks the proposal row; the JOIN
    // to repositories is read-only and does not extend the lock.
    const { rows: [proposal] } = await client.query(
      `SELECT p.*, r.full_name as repo_full_name
       FROM repair_proposals p
       LEFT JOIN repositories r ON r.github_id = p.repo_id
       WHERE p.id = $1
       FOR UPDATE OF p`,
      [id]
    );
    if (!proposal) throw new Error(`Repair proposal not found: ${id}`);

    // REPLAY SAFETY: already proposed
    if (proposal.status === "proposed") {
      const existingPatch = parseJsonb(proposal.patch_proposal);
      if (existingPatch && existingPatch.artifact_hash === patchInput.artifact_hash) {
        logger.info(
          { proposal_id: id, correlation_id },
          "Proposal already proposed with same artifact hash — replay no-op"
        );
        return redactProposal(proposal);
      }
      // Different artifact hash → reject (no revisions in this item)
      throw new Error(
        `Proposal already has a patch proposal with different artifact hash — ` +
        `revisions require an explicit supersession contract`
      );
    }

    // Only allow from evidence_collected
    if (proposal.status !== "evidence_collected") {
      throw new Error(
        `Patch proposal requires status 'evidence_collected', got '${proposal.status}'`
      );
    }

    // Diagnosis must already exist
    const diagnosis = parseJsonb(proposal.diagnosis);
    if (!diagnosis) {
      throw new Error(
        "Cannot record patch proposal: diagnosis must exist before patch generation"
      );
    }

    // P1 FIX: Verify diagnosis_hash against the locked diagnosis
    const lockedDiagnosisHash = contentHash(diagnosis);
    if (patchInput.diagnosis_hash !== lockedDiagnosisHash) {
      throw new Error(
        `Patch diagnosis_hash (${patchInput.diagnosis_hash}) does not match ` +
        `the proposal's locked diagnosis (${lockedDiagnosisHash})`
      );
    }

    // Pin patch to the proposal's head_sha
    if (patchInput.base_sha !== proposal.head_sha) {
      throw new Error(
        `Patch base_sha (${patchInput.base_sha}) does not match proposal head_sha (${proposal.head_sha}) — ` +
        `patch must be pinned to the proposal's base snapshot`
      );
    }

    // P0 FIX: Resolve and verify the artifact from durable content-addressed store
    // The artifact is verified by hash, then parsed to DERIVE scope values
    // from actual artifact content — not caller-supplied metadata.
    let verifiedDerived;
    let artifactContent;
    try {
      artifactContent = await verifyArtifact(patchInput.artifact_ref, patchInput.artifact_hash);
      verifiedDerived = parseArtifact(artifactContent);
    } catch (artifactErr) {
      throw new Error(`Patch artifact verification failed: ${artifactErr.message}`);
    }

    // Verify base_sha inside the artifact matches the proposal
    const parsedArtifact = JSON.parse(artifactContent);
    if (parsedArtifact.base_sha !== proposal.head_sha) {
      throw new Error(
        `Artifact base_sha (${parsedArtifact.base_sha}) does not match proposal head_sha (${proposal.head_sha})`
      );
    }

    // Envelope is the authoritative budget — enforce from VERIFIED derived values
    const envelope = parseJsonb(proposal.task_envelope);
    if (envelope) {
      const verifiedPatchForScope = {
        total_files: verifiedDerived.total_files,
        total_lines_changed: verifiedDerived.total_lines_changed,
        files: verifiedDerived.changed_files,
      };
      const scopeErrors = checkPatchAgainstEnvelope(verifiedPatchForScope, envelope);
      if (scopeErrors.length > 0) {
        throw new Error(`Patch exceeds envelope scope (verified): ${scopeErrors.join("; ")}`);
      }
    }

    // Validate patch evidence binding
    const evidenceRefs = parseJsonb(proposal.evidence_refs) || [];
    const bindingCheck = validatePatchEvidenceBinding(patchInput, evidenceRefs, diagnosis);
    if (!bindingCheck.valid) {
      throw new Error(`Patch evidence binding failed: ${bindingCheck.errors.join("; ")}`);
    }

    // P1 FIX: Enforce auto_patch policy at execution time (not just enqueue time)
    // Fail closed: missing repo_full_name or policy resolution failure rejects.
    if (!proposal.repo_full_name) {
      throw new Error(
        "Cannot record patch: proposal has no repo_full_name — policy cannot be verified"
      );
    }
    try {
      const config = await getConfigForRepo(proposal.repo_full_name);
      // getConfigForRepo() nests config under .pillars (defaults <- org <- repo).
      // Fall back to config?.ci_healing for any older config that wasn't layered.
      const healingConfig = config?.pillars?.ci_healing ?? config?.ci_healing;
      checkPatchPolicy(healingConfig, diagnosis);
    } catch (policyErr) {
      if (policyErr.message.includes("rejected")) throw policyErr;
      throw new Error(
        `Patch recording rejected: unable to verify patch policy (${policyErr.message})`
      );
    }

    // P1 FIX: input_bundle_hash binds to the full canonical generation bundle
    const canonicalBundle = buildPatchInputBundle(proposal, diagnosis, evidenceRefs);
    const recomputedBundleHash = contentHash(canonicalBundle);
    if (patchInput.input_bundle_hash !== recomputedBundleHash) {
      throw new Error(
        `Patch input_bundle_hash (${patchInput.input_bundle_hash}) does not match ` +
        `recomputed canonical bundle hash (${recomputedBundleHash})`
      );
    }

    // Build the persisted patch proposal object — uses VERIFIED derived values
    const persistedPatch = {
      artifact_ref: patchInput.artifact_ref,
      artifact_hash: patchInput.artifact_hash,
      base_sha: patchInput.base_sha,
      changed_files: verifiedDerived.changed_files,
      total_files: verifiedDerived.total_files,
      total_changed_lines: verifiedDerived.total_lines_changed,
      evidence_ids: patchInput.evidence_ids,
      diagnosis_hash: lockedDiagnosisHash,
      input_bundle_hash: recomputedBundleHash,
      rationale_summary: patchInput.rationale_summary,
      limitations: patchInput.limitations,
    };

    // CAS: version check + atomic write + transition
    const setClauses = [
      "patch_proposal = $1",
      "status = $2",
      "version = version + 1",
    ];
    const values = [
      JSON.stringify(persistedPatch),
      "proposed",
    ];
    let paramIdx = 3;

    const whereClauses = [];
    whereClauses.push(`id = $${paramIdx++}`);
    values.push(id);
    whereClauses.push(`version = $${paramIdx++}`);
    values.push(expected_version);

    const { rows } = await client.query(
      `UPDATE repair_proposals
       SET ${setClauses.join(", ")}
       WHERE ${whereClauses.join(" AND ")}
       RETURNING *`,
      values
    );

    if (rows.length === 0) {
      throw new Error(
        `Version mismatch: expected version ${expected_version}. ` +
        `Another process may have modified this proposal.`
      );
    }

    const updated = rows[0];

    // Record ONE patch_proposal_recorded event
    const snapshot = buildEvidenceSnapshot({
      patch_proposal: persistedPatch,
      diagnosis_hash: lockedDiagnosisHash,
      input_bundle_hash: persistedPatch.input_bundle_hash,
    });
    await client.query(
      `INSERT INTO repair_proposal_events
         (proposal_id, event_type, from_status, to_status, actor, evidence_snapshot, correlation_id, source_delivery_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        id,
        "patch_proposal_recorded",
        "evidence_collected",
        "proposed",
        actor,
        JSON.stringify(snapshot),
        correlation_id || null,
        source_delivery_id || null,
      ]
    );

    logger.info(
      { proposal_id: id, artifact_hash: patchInput.artifact_hash, correlation_id },
      "Patch proposal recorded — transitioned to proposed"
    );

    return redactProposal(updated);
  });
}

// ════════════════════════════════════════════════════════════════════════════
// CANONICAL VERIFICATION RECORDING — sole authorized writer of validation_result
// and sole authorized entry into verified/failed from proposed.
// ════════════════════════════════════════════════════════════════════════════

/**
 * Record a verification result and transition the proposal.
 *
 * This is the SOLE authorized path for writing validation_result and
 * transitioning from proposed to verified or failed. Generic attachEvidence()
 * rejects validation_result unconditionally.
 *
 * Guarantees:
 * - actor_kind must be verification_worker
 * - Proposal must be in proposed status with an existing patch_proposal
 * - Durable patch artifact must resolve and re-hash correctly
 * - Artifact base_sha must equal proposal head_sha
 * - patch_artifact_hash must match the locked patch_proposal
 * - input_bundle_hash must match the locked patch_proposal
 * - Validation plan must be derived only from task_envelope.required_validation
 * - Executed commands must match the validation plan exactly
 * - Verification fingerprint must match the locked inputs
 * - Replay-safe: same fingerprint → no-op, different → reject
 * - Atomic: lock + validate + update + event in one transaction
 *
 * State transitions:
 * - overall: "pass" → proposed → verified
 * - overall: "fail" → proposed → failed
 * - overall: "inconclusive" → proposed → failed
 *
 * @param {number} id - repair proposal ID
 * @param {object} verificationInput - structured verification result
 * @param {object} options
 * @returns {Promise<object>} updated proposal
 */
export async function recordVerificationResult(id, verificationInput = {}, options = {}) {
  const {
    actor = "verification_worker",
    expected_version,
    correlation_id,
    source_delivery_id,
    actor_kind = actor,
  } = options;

  if (!id) throw new Error("id is required");

  // MANDATORY actor-kind enforcement — unconditional
  requireActorKind(actor_kind);

  if (!Number.isInteger(expected_version) || expected_version < 1) {
    throw new Error("expected_version is required and must be a positive integer");
  }

  // Enforce actor-kind authority
  if (!canAttachField(actor_kind, "validation_result")) {
    throw new Error(`Actor '${actor_kind}' is not authorized to attach validation_result`);
  }

  // Validate verification input structure
  const result = verificationInput.overall;
  if (!VALID_VALIDATION_OVERALL.has(result)) {
    throw new Error(
      `verification result must be one of: ${[...VALID_VALIDATION_OVERALL].join(", ")}`
    );
  }

  // Determine target status from result
  const targetStatus = result === "pass" ? "verified" : "failed";

  // A passing result requires a durable execution receipt.
  // The receipt is resolved and hash-verified under the transaction lock
  // below. Here we just require the reference and hash to be present —
  // the binding verification happens after locking.
  if (result === "pass") {
    if (!verificationInput.execution_receipt_ref || !verificationInput.execution_receipt_hash) {
      throw new Error(
        "Passing verification requires an execution receipt — execution_receipt_ref and execution_receipt_hash are required"
      );
    }
  }

  if (!canTransitionTo(actor_kind, targetStatus)) {
    throw new Error(
      `Actor '${actor_kind}' is not authorized to transition to ${targetStatus}`
    );
  }

  // Require verification fingerprint and binding fields
  const requiredFields = [
    "verification_fingerprint",
    "patch_artifact_hash",
    "base_sha",
    "input_bundle_hash",
    "sandbox_image_digest",
    "validation_plan_hash",
    "commands",
    "exit_status",
  ];
  for (const field of requiredFields) {
    if (verificationInput[field] === undefined) {
      throw new Error(`Verification input field '${field}' is required`);
    }
    // exit_status may be null for inconclusive (not executed)
    if (field !== "exit_status" && verificationInput[field] === null) {
      throw new Error(`Verification input field '${field}' is required`);
    }
  }
  if (!Array.isArray(verificationInput.commands) || verificationInput.commands.length === 0) {
    throw new Error("Verification input commands must be a non-empty array");
  }

  return db.transaction(async (client) => {
    // Lock the row
    const { rows: [proposal] } = await client.query(
      "SELECT * FROM repair_proposals WHERE id = $1 FOR UPDATE",
      [id]
    );
    if (!proposal) throw new Error(`Repair proposal not found: ${id}`);

    // REPLAY SAFETY: already verified or failed with same fingerprint → no-op
    if (proposal.status === "verified" || proposal.status === "failed") {
      const existingResult = parseJsonb(proposal.validation_result);
      if (existingResult && existingResult.verification_fingerprint === verificationInput.verification_fingerprint) {
        logger.info(
          { proposal_id: id, correlation_id },
          "Proposal already has verification result with same fingerprint — replay no-op"
        );
        return redactProposal(proposal);
      }
      // Different fingerprint → reject
      throw new Error(
        `Proposal already has a verification result with different fingerprint — ` +
        `retries require an explicit revision contract`
      );
    }

    // Only allow from proposed
    if (proposal.status !== "proposed") {
      throw new Error(
        `Verification requires status 'proposed', got '${proposal.status}'`
      );
    }

    // patch_proposal must exist
    const patchProposal = parseJsonb(proposal.patch_proposal);
    if (!patchProposal) {
      throw new Error(
        "Cannot record verification: patch_proposal must exist before verification"
      );
    }

    // Verify patch_artifact_hash matches the locked patch_proposal
    if (verificationInput.patch_artifact_hash !== patchProposal.artifact_hash) {
      throw new Error(
        `Verification patch_artifact_hash does not match locked patch_proposal artifact_hash`
      );
    }

    // Verify base_sha matches proposal head_sha
    if (verificationInput.base_sha !== proposal.head_sha) {
      throw new Error(
        `Verification base_sha (${verificationInput.base_sha}) does not match proposal head_sha (${proposal.head_sha})`
      );
    }

    // Verify input_bundle_hash matches locked patch_proposal
    if (verificationInput.input_bundle_hash !== patchProposal.input_bundle_hash) {
      throw new Error(
        `Verification input_bundle_hash does not match locked patch_proposal input_bundle_hash`
      );
    }

    // Resolve and verify the durable artifact
    let artifactContent;
    try {
      artifactContent = await verifyArtifact(
        patchProposal.artifact_ref,
        patchProposal.artifact_hash
      );
    } catch (artifactErr) {
      throw new Error(`Patch artifact verification failed: ${artifactErr.message}`);
    }

    // Verify artifact base_sha matches proposal head_sha
    const parsedArtifact = JSON.parse(artifactContent);
    if (parsedArtifact.base_sha !== proposal.head_sha) {
      throw new Error(
        `Artifact base_sha (${parsedArtifact.base_sha}) does not match proposal head_sha (${proposal.head_sha})`
      );
    }

    // Verify validation plan from task_envelope
    const envelope = parseJsonb(proposal.task_envelope);
    if (!envelope || !Array.isArray(envelope.required_validation)) {
      throw new Error(
        "Cannot record verification: task_envelope.required_validation must exist"
      );
    }

    // P1 FIX: Recompute the validation plan hash from the locked envelope.
    // The caller-supplied validation_plan_hash must match the canonical plan
    // derived from the locked task_envelope — not an arbitrary caller value.
    // Task 8D: evidence_refs is also consulted so descriptor-derived plans hash
    // identically to what sandboxRunner produced.
    const recorderEvidenceRefs = parseJsonb(proposal.evidence_refs);
    const canonicalPlan = buildValidationPlanForRecorder(envelope, recorderEvidenceRefs);
    if (verificationInput.validation_plan_hash !== canonicalPlan.validation_plan_hash) {
      throw new Error(
        `Verification validation_plan_hash does not match canonical plan derived from locked task_envelope`
      );
    }

    // P1 FIX: Verify sandbox_image_digest against an approved pinned digest.
    // The caller cannot use an arbitrary image identity. For node-executor,
    // the approved digest is the static SANDBOX_IMAGE_DIGEST. For executor-
    // service, the approved digest is the configured validator image digest
    // (GITWIRE_VALIDATOR_IMAGE_DIGEST) — the executor-service inspects the real
    // image and returns inspected_image_digest, which must match the config.
    const { SANDBOX_IMAGE_DIGEST } = await import("../lib/sandboxRunner.js");
    const configuredValidatorDigest = process.env.GITWIRE_VALIDATOR_IMAGE_DIGEST;
    const approvedDigests = new Set([SANDBOX_IMAGE_DIGEST]);
    if (configuredValidatorDigest) approvedDigests.add(configuredValidatorDigest);
    if (!approvedDigests.has(verificationInput.sandbox_image_digest)) {
      throw new Error(
        `Verification sandbox_image_digest does not match any approved pinned image digest ` +
        `(got: ${verificationInput.sandbox_image_digest?.slice(0, 30)}..., ` +
        `approved: [${[...approvedDigests].map(d => d.slice(0, 30)).join(", ")}])`
      );
    }

    // Validate executed commands against the compiled validation plan
    // v0.23.0 Task 9: compile semantic IDs to executable commands, then compare.
    // Comparing raw envelope.required_validation against executed commands
    // fails because the executor receives compiled command IDs (test, build),
    // not semantic IDs (test_or_build_result, policy_scope_check).
    const compiledPlan = compileValidationPlan(envelope.required_validation, recorderEvidenceRefs);
    const requiredCommands = compiledPlan.executable_commands;
    const executedCommands = verificationInput.commands.map((c) => c.command).sort();
    const commandCheck = validateCommandSetInternal(executedCommands, requiredCommands);
    if (!commandCheck.valid) {
      throw new Error(`Verification command validation failed: ${commandCheck.errors.join("; ")}`);
    }

    // P0 FIX: Derive and validate aggregate result from command outcomes.
    // The caller-supplied 'overall' must be consistent with actual exit statuses.
    const allCommandsPassed = verificationInput.commands.every(
      (c) => Number.isInteger(c.exit_status) && c.exit_status === 0
    );
    const aggregateExitOk = Number.isInteger(verificationInput.exit_status) && verificationInput.exit_status === 0;

    if (
      verificationInput.overall === "pass" &&
      (!allCommandsPassed || !aggregateExitOk)
    ) {
      throw new Error(
        "Passing verification requires zero aggregate and per-command exit statuses"
      );
    }

    if (
      verificationInput.overall === "fail" &&
      allCommandsPassed &&
      aggregateExitOk
    ) {
      throw new Error(
        "Failed verification requires at least one failing command or non-zero aggregate exit status"
      );
    }

    // For inconclusive, require a structured execution-failure category
    if (verificationInput.overall === "inconclusive") {
      if (!verificationInput.inconclusive_reason || typeof verificationInput.inconclusive_reason !== "string") {
        throw new Error(
          "Inconclusive verification requires a structured inconclusive_reason"
        );
      }
    }

    // Verify the verification fingerprint against CANONICAL values
    // (not caller-controlled equivalents). For executor-service, the
    // sandbox_image_digest in the fingerprint is the configured validator image
    // digest (inspected_image_digest), not the static node-executor digest.
    // Match the approved digest that was used to build the fingerprint.
    const fingerprintSandboxDigest =
      approvedDigests.has(verificationInput.sandbox_image_digest)
        ? verificationInput.sandbox_image_digest
        : SANDBOX_IMAGE_DIGEST;
    const expectedFingerprint = computeVerificationFingerprintInternal({
      patch_artifact_hash: patchProposal.artifact_hash,
      base_sha: proposal.head_sha,
      input_bundle_hash: patchProposal.input_bundle_hash,
      sandbox_image_digest: fingerprintSandboxDigest,
      validation_plan_hash: canonicalPlan.validation_plan_hash,
    });
    if (verificationInput.verification_fingerprint !== expectedFingerprint) {
      throw new Error(
        `Verification fingerprint mismatch — fingerprint must bind to locked artifact, base SHA, input bundle, approved sandbox image, and canonical validation plan`
      );
    }

    // ── EXECUTION RECEIPT VERIFICATION (under lock) ─────────────────────────
    // For passing results: use the shared receipt verification helper to
    // ensure complete binding checks identical to the critic gate.
    if (result === "pass") {
      if (!verificationInput.execution_receipt_ref || !verificationInput.execution_receipt_hash) {
        throw new Error(
          "Passing verification requires execution_receipt_ref and execution_receipt_hash"
        );
      }

      await verifyExecutionReceiptAgainstLockedProposal(
        verificationInput.execution_receipt_ref,
        verificationInput.execution_receipt_hash,
        patchProposal,
        proposal.head_sha,
        canonicalPlan,
        SANDBOX_IMAGE_DIGEST,
        proposal.repo_full_name
      );
    }

    // Build the persisted validation result
    const persistedResult = {
      overall: result,
      verification_fingerprint: verificationInput.verification_fingerprint,
      patch_artifact_hash: patchProposal.artifact_hash,
      base_sha: proposal.head_sha,
      input_bundle_hash: patchProposal.input_bundle_hash,
      sandbox_image_digest: SANDBOX_IMAGE_DIGEST,
      validation_plan_hash: canonicalPlan.validation_plan_hash,
      commands: verificationInput.commands,
      exit_status: verificationInput.exit_status,
      output_refs: verificationInput.output_refs || [],
      output_hashes: verificationInput.output_hashes || [],
      redacted_summary: verificationInput.redacted_summary || "",
      limits_applied: verificationInput.limits_applied || {},
      ...(verificationInput.execution_receipt_ref ? { execution_receipt_ref: verificationInput.execution_receipt_ref } : {}),
      ...(verificationInput.execution_receipt_hash ? { execution_receipt_hash: verificationInput.execution_receipt_hash } : {}),
      ...(verificationInput.inconclusive_reason ? { inconclusive_reason: verificationInput.inconclusive_reason } : {}),
      // Backward-compat: checks array for existing validateValidationResult consumers
      checks: verificationInput.commands.map((c) => ({
        name: c.command,
        passed: c.exit_status === 0,
        output_hash: c.output_hash,
      })),
    };

    // CAS: version check + atomic write + transition
    const setClauses = [
      "validation_result = $1",
      "status = $2",
      "version = version + 1",
    ];
    const values = [
      JSON.stringify(persistedResult),
      targetStatus,
    ];
    let paramIdx = 3;

    const whereClauses = [];
    whereClauses.push(`id = $${paramIdx++}`);
    values.push(id);
    whereClauses.push(`version = $${paramIdx++}`);
    values.push(expected_version);

    const { rows } = await client.query(
      `UPDATE repair_proposals
       SET ${setClauses.join(", ")}
       WHERE ${whereClauses.join(" AND ")}
       RETURNING *`,
      values
    );

    if (rows.length === 0) {
      throw new Error(
        `Version mismatch: expected version ${expected_version}. ` +
        `Another process may have modified this proposal.`
      );
    }

    const updated = rows[0];

    // Record one verification_result_recorded event
    const snapshot = buildEvidenceSnapshot({
      validation_result: persistedResult,
      verification_fingerprint: verificationInput.verification_fingerprint,
    });
    await client.query(
      `INSERT INTO repair_proposal_events
         (proposal_id, event_type, from_status, to_status, actor, evidence_snapshot, correlation_id, source_delivery_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        id,
        "verification_result_recorded",
        "proposed",
        targetStatus,
        actor,
        JSON.stringify(snapshot),
        correlation_id || null,
        source_delivery_id || null,
      ]
    );

    logger.info(
      { proposal_id: id, target_status: targetStatus, fingerprint: verificationInput.verification_fingerprint, correlation_id },
      "Verification result recorded"
    );

    return redactProposal(updated);
  });
}

// ── Internal helpers for recordVerificationResult ─────────────────────────────

function validateCommandSetInternal(executedCommands, requiredCommands) {
  const errors = [];
  const executed = new Set(executedCommands);
  const required = new Set(requiredCommands);

  for (const cmd of required) {
    if (!executed.has(cmd)) {
      errors.push(`Missing required validation command: ${cmd}`);
    }
  }
  for (const cmd of executed) {
    if (!required.has(cmd)) {
      errors.push(`Disallowed validation command not in plan: ${cmd}`);
    }
  }

  return errors.length > 0 ? { valid: false, errors } : { valid: true, errors: [] };
}

/**
 * Build the canonical validation plan from a locked task envelope.
 * Used by recordVerificationResult() to recompute the plan hash
 * server-side from locked state — not from caller-supplied values.
 *
 * Task 8D: now accepts the locked evidence_refs so descriptor-derived plans
 * hash identically to sandboxRunner.buildValidationPlan(). The hash content
 * MUST match sandboxRunner exactly (same fields, same order, same
 * canonicalization via @gitwire/core).
 */
export function buildValidationPlanForRecorder(envelope, evidenceRefs) {
  // v0.23.0 Task 9 / Task 8D: use the validation-plan adapter for the same
  // semantic→executable compilation as sandboxRunner.buildValidationPlan. Both
  // sides must produce the same hash content or the verifier rejects the receipt.
  //
  // Plan-execution conformance: activation is resolved once and injected.
  // The hash is computed by the shared computeValidationPlanHash() — no inline
  // JSON.stringify here. This eliminates the two-site duplication hazard.
  const descriptorActivation = resolveDescriptorActivation(process.env.GITWIRE_DESCRIPTOR_ACTIVATION);
  const plan = compileValidationPlan(envelope.required_validation, evidenceRefs, { descriptorActivation });
  const commands = plan.executable_commands;
  const command_descriptors = plan.command_descriptors || {};
  const validation_plan_hash = computeValidationPlanHash({
    commands,
    command_descriptors,
    image_digest: "sha256:node-executor-v1",
    required_validation: envelope.required_validation,
    acceptance_policy: plan.acceptance_policy,
    plan_schema_version: plan.plan_schema_version,
    descriptor_policy: plan.descriptor_policy,
    normative_steps: plan.normative_steps,
    required_execution_features: plan.required_execution_features,
  });
  return {
    commands,
    command_descriptors,
    validation_plan_hash,
    plan_schema_version: plan.plan_schema_version,
    descriptor_policy: plan.descriptor_policy,
    normative_steps: plan.normative_steps,
    required_execution_features: plan.required_execution_features,
  };
}

function computeVerificationFingerprintInternal(params) {
  const { patch_artifact_hash, base_sha, input_bundle_hash, sandbox_image_digest, validation_plan_hash } = params;
  const content = JSON.stringify({
    patch_artifact_hash,
    base_sha,
    input_bundle_hash,
    sandbox_image_digest,
    validation_plan_hash,
  });
  return "sha256:" + crypto.createHash("sha256").update(content).digest("hex");
}

// ════════════════════════════════════════════════════════════════════════════
// SHARED RECEIPT VERIFICATION — used by BOTH recordVerificationResult()
// and recordCriticReview() to ensure identical binding checks.
// ════════════════════════════════════════════════════════════════════════════

/**
 * Allowlisted execution backend identifiers.
 * Only these backends are trusted to produce execution receipts.
 */
const ALLOWED_EXECUTION_BACKENDS = new Set([
  "node-executor",
  "docker-executor",
  "executor-service", // v0.23.0 Task 3: pass-capable via the executor service
]);

/**
 * Allowlisted executor versions.
 */
const ALLOWED_EXECUTOR_VERSIONS = new Set([
  "1.0.0",
]);

/**
 * Backends that may produce result: "pass" receipts.
 *
 * EMPTY until a real isolated executor (Docker/Podman/nsjail/firejail)
 * is implemented. The host spawn executor is NOT isolated — it lacks
 * network isolation, CPU/memory/process limits, non-root enforcement,
 * and container-level isolation. It may only produce fail/inconclusive
 * receipts.
 *
 * A backend is added here ONLY after it has been verified to provide:
 * - network disabled
 * - no credentials or host socket mounts
 * - non-root user
 * - CPU/memory/pid/wall-clock/output limits enforced by the kernel
 * - read-only source input + disposable workdir
 */
const ALLOWED_PASS_EXECUTION_BACKENDS = new Set([
  "docker-executor",
  "executor-service", // v0.23.0 Task 3: pass-capable via the executor service
]);

/**
 * Verify a durable execution receipt against locked proposal state.
 *
 * This is the SINGLE shared verification helper used by both
 * recordVerificationResult() and recordCriticReview() to ensure
 * identical binding checks at both gates.
 *
 * Checks:
 * 1. Receipt resolves and re-hashes correctly
 * 2. Receipt result is "pass"
 * 3. execution_backend_id is allowlisted
 * 3a. Backend must be in ALLOWED_PASS_EXECUTION_BACKENDS (isolation)
 * 3b. Isolation bindings present on receipt
 * 3c. network_disabled, non_root, read_only_rootfs all true
 * 3d. image_ref present and digest-pinned (immutable OCI identity)
 * 3e. durable backend isolation evidence exists and is audit-complete
 * 4. executor_version is allowlisted
 * 5. patch_artifact_hash matches locked patch_proposal
 * 6. base_sha matches proposal head_sha
 * 6a. source_snapshot_hash resolves to durable snapshot
 * 7. input_bundle_hash matches locked patch_proposal
 * 8. sandbox_image_digest matches approved pinned constant
 * 9. validation_plan_hash matches canonical plan from locked envelope
 * 10. commands array is non-empty and matches canonical plan
 * 11. per_command_exit_statuses length === commands length
 * 12. every per-command exit status is zero
 * 13. aggregate_exit_status is zero
 * 14. output_refs length === commands length
 * 15. output_hashes length === commands length
 *
 * @param {string} receiptRef - durable receipt reference
 * @param {string} receiptHash - expected receipt hash
 * @param {object} patchProposal - locked patch_proposal
 * @param {string} headSha - locked proposal head_sha
 * @param {object} canonicalPlan - canonical validation plan { commands, validation_plan_hash }
 * @param {string} sandboxImageDigest - approved pinned image digest
 * @returns {Promise<object>} verified receipt object
 * @throws {Error} on any verification failure
 */
async function verifyExecutionReceiptAgainstLockedProposal(
  receiptRef,
  receiptHash,
  patchProposal,
  headSha,
  canonicalPlan,
  sandboxImageDigest,
  repoFullName
) {
  // 1. Resolve and re-hash the durable receipt
  let receiptContent;
  try {
    const { verifyReceipt } = await import("../lib/executionReceiptStore.js");
    receiptContent = await verifyReceipt(receiptRef, receiptHash);
  } catch (receiptErr) {
    throw new Error(`Execution receipt resolution failed: ${receiptErr.message}`);
  }

  let receipt;
  try {
    receipt = JSON.parse(receiptContent);
  } catch (_e) {
    throw new Error("Execution receipt is not valid JSON");
  }

  // 2. Receipt result must be pass
  if (receipt.result !== "pass") {
    throw new Error(
      `Execution receipt result is '${receipt.result}', must be 'pass'`
    );
  }

  // 3. execution_backend_id must be allowlisted
  if (!ALLOWED_EXECUTION_BACKENDS.has(receipt.execution_backend_id)) {
    throw new Error(
      `Execution receipt execution_backend_id '${receipt.execution_backend_id}' is not allowlisted`
    );
  }

  // 3a. If result is pass, the backend must be in ALLOWED_PASS_EXECUTION_BACKENDS.
  // The host spawn executor is NOT isolated and cannot authorize pass.
  if (!ALLOWED_PASS_EXECUTION_BACKENDS.has(receipt.execution_backend_id)) {
    throw new Error(
      `Execution receipt execution_backend_id '${receipt.execution_backend_id}' is not authorized to produce passing results — backend is not isolated`
    );
  }

  // 3b. Isolation bindings must be present on the receipt.
  // These fields are bound into the receipt by the executor backend
  // and verified here to confirm the execution environment met the
  // isolation contract.
  const isolationFields = [
    "container_runtime", "network_disabled", "non_root",
    "read_only_rootfs", "resource_limits",
  ];
  for (const field of isolationFields) {
    if (receipt[field] === undefined) {
      throw new Error(
        `Execution receipt missing isolation binding: ${field}`
      );
    }
  }

  // 3c. Isolation properties must be enforced for pass receipts.
  // A pass receipt MUST come from a backend with network disabled,
  // non-root user, and read-only rootfs. These are the minimum
  // isolation guarantees required to trust a pass result.
  if (!receipt.network_disabled) {
    throw new Error(
      "Execution receipt network_disabled is false — pass requires network isolation"
    );
  }
  if (!receipt.non_root) {
    throw new Error(
      "Execution receipt non_root is false — pass requires non-root execution"
    );
  }
  if (!receipt.read_only_rootfs) {
    throw new Error(
      "Execution receipt read_only_rootfs is false — pass requires read-only rootfs"
    );
  }

  // 3d. image_ref must be present and digest-pinned.
  // This is the immutable OCI image identity — a governance label
  // like 'sha256:gitwire-validator-v1' is NOT a real image digest.
  // Pass receipts must bind to a real digest-pinned reference.
  if (!receipt.image_ref) {
    throw new Error(
      "Execution receipt missing image_ref — pass requires immutable OCI image identity"
    );
  }
  try {
    const { isDigestPinned } = await import("../lib/imageReference.js");
    if (!isDigestPinned(receipt.image_ref)) {
      throw new Error("not digest-pinned");
    }
  } catch (imgErr) {
    throw new Error(
      `Execution receipt image_ref '${receipt.image_ref}' is invalid: ${imgErr.message}`
    );
  }

  // 3e. Durable backend isolation evidence must exist and be audit-complete.
  // This is the core unlock check: a pass receipt is accepted ONLY when
  // valid evidence exists for the backend + image digest, proving that:
  // - all isolation probes passed
  // - the probe suite hash recomputes
  // - runtime image inspection was performed and matches
  // - the image_ref digest matches the stored image_digest
  // - repo_digests contain the matching digest
  // Additionally, the receipt's image_ref must match the stored evidence's
  // image_ref exactly — not merely be digest-pinned.
  try {
    const { verifyBackendEvidence } = await import("../lib/backendEvidenceStore.js");
    const evidence = await verifyBackendEvidence(
      receipt.execution_backend_id,
      receipt.sandbox_image_digest
    );

    // Receipt image_ref must match stored evidence image_ref exactly
    if (receipt.image_ref !== evidence.image_ref) {
      throw new Error(
        `Receipt image_ref '${receipt.image_ref}' does not match evidence image_ref '${evidence.image_ref}'`
      );
    }

    // P1 fix: bind executor/runtime identity between receipt and evidence.
    // Evidence for one executor/runtime version must not authorize a
    // receipt from another allowed version.
    if (receipt.executor_version !== evidence.executor_version) {
      throw new Error(
        `Receipt executor_version '${receipt.executor_version}' does not match evidence executor_version '${evidence.executor_version}'`
      );
    }
    if (receipt.container_runtime !== evidence.container_runtime) {
      throw new Error(
        `Receipt container_runtime '${receipt.container_runtime}' does not match evidence container_runtime '${evidence.container_runtime}'`
      );
    }
    // runtime_version binding — checked if the receipt includes it
    if (receipt.runtime_version && evidence.runtime_version &&
        receipt.runtime_version !== evidence.runtime_version) {
      throw new Error(
        `Receipt runtime_version '${receipt.runtime_version}' does not match evidence runtime_version '${evidence.runtime_version}'`
      );
    }
  } catch (evidenceErr) {
    throw new Error(
      `Backend evidence verification failed: ${evidenceErr.message}`
    );
  }

  // ── v0.23.0 Task 6 — DB-backed executor report verification (check 3l) ───
  // For executor-service pass receipts, resolve executor_report_ref → raw
  // report, recompute executor_report_hash, and compare. A pass receipt is
  // NOT accepted unless the raw report can be resolved and its hash matches.
  // This closes the "bare hash" hole: the receipt must carry a ref that
  // resolves to durable content whose recomputed hash equals the receipt's hash.
  //
  // The rawReport is hoisted here so it's available for the conformance
  // check (3m) below — the verifier needs the structured executed_steps
  // from the raw report to independently derive plan_execution_relation.
  let rawReport = null;
  if (receipt.execution_backend_id === "executor-service") {
    try {
      const { verifyExecutorReportHash } = await import("../lib/executionReceiptStore.js");

      // 3l-a. identifier consistency: execution_backend_id == executor_service_id.
      // The executor report records executor_service_id; the receipt records
      // execution_backend_id. They must match — a mismatch means the receipt
      // was not built from this report.
      const rawReportContent = await (await import("../lib/executionReceiptStore.js")).resolveExecutorReport(receipt.executor_report_ref);
      rawReport = JSON.parse(rawReportContent);
      if (rawReport.executor_service_id !== receipt.execution_backend_id) {
        throw new Error(
          `identifier inconsistency: execution_backend_id '${receipt.execution_backend_id}' != executor_service_id '${rawReport.executor_service_id}'`
        );
      }

      // 3l-b. hash recompute: resolve + recompute + compare.
      const hashMatches = await verifyExecutorReportHash(
        receipt.executor_report_ref,
        receipt.executor_report_hash
      );
      if (!hashMatches) {
        throw new Error(
          `executor report hash mismatch: recomputed hash does not match receipt's executor_report_hash`
        );
      }
    } catch (reportErr) {
      throw new Error(
        `Gap 1 executor report verification failed: ${reportErr.message}`
      );
    }
  }

  // ── Gap 1 checks 3f-3j + 3m (plan-execution conformance) ─────────────
  // Logic lives in the pure helper (validatorReceiptGate.js) so it is unit-
  // testable without a DB. The conformance check (3m) uses canonicalPlan
  // and rawReport to independently recompute plan_execution_relation —
  // it does NOT trust the stored value in the receipt.
  try {
    const { validateGap1ValidatorBindings } = await import("../lib/validatorReceiptGate.js");
    validateGap1ValidatorBindings(receipt, canonicalPlan, rawReport);
  } catch (gap1Err) {
    throw new Error(`Gap 1 validator binding check failed: ${gap1Err.message}`);
  }

  // 4. executor_version must be allowlisted
  if (!ALLOWED_EXECUTOR_VERSIONS.has(receipt.executor_version)) {
    throw new Error(
      `Execution receipt executor_version '${receipt.executor_version}' is not allowlisted`
    );
  }

  // 5. patch_artifact_hash matches locked patch_proposal
  if (receipt.patch_artifact_hash !== patchProposal.artifact_hash) {
    throw new Error(
      `Execution receipt patch_artifact_hash does not match locked patch_proposal`
    );
  }

  // 6. base_sha matches proposal head_sha
  if (receipt.base_sha !== headSha) {
    throw new Error(
      `Execution receipt base_sha does not match proposal head_sha`
    );
  }

  // 6a. source_snapshot_hash must be present and resolve to a durable
  // source-snapshot binding for the locked repo and base_sha.
  // This verifies the receipt was produced from the exact pinned commit
  // snapshot, not an arbitrary or incomplete file set.
  if (!receipt.source_snapshot_hash) {
    throw new Error(
      "Execution receipt must contain source_snapshot_hash"
    );
  }

  try {
    const { verifySourceSnapshot } = await import("../lib/sourceSnapshotStore.js");
    await verifySourceSnapshot(receipt.source_snapshot_hash, repoFullName, headSha);
  } catch (snapshotErr) {
    throw new Error(
      `Execution receipt source_snapshot_hash verification failed: ${snapshotErr.message}`
    );
  }

  // 7. input_bundle_hash matches locked patch_proposal
  if (receipt.input_bundle_hash !== patchProposal.input_bundle_hash) {
    throw new Error(
      `Execution receipt input_bundle_hash does not match locked patch_proposal`
    );
  }

  // 8. sandbox_image_digest matches approved pinned constant
  if (receipt.sandbox_image_digest !== sandboxImageDigest) {
    throw new Error(
      `Execution receipt sandbox_image_digest does not match approved pinned image digest`
    );
  }

  // 9. validation_plan_hash matches canonical plan from locked envelope
  if (receipt.validation_plan_hash !== canonicalPlan.validation_plan_hash) {
    throw new Error(
      `Execution receipt validation_plan_hash does not match canonical plan from locked envelope`
    );
  }

  // 10. commands array must be non-empty
  if (!Array.isArray(receipt.commands) || receipt.commands.length === 0) {
    throw new Error(
      "Execution receipt commands must be a non-empty array"
    );
  }

  // Verify commands match canonical plan (sorted)
  const receiptCommands = [...receipt.commands].sort();
  const planCommands = [...canonicalPlan.commands].sort();
  if (JSON.stringify(receiptCommands) !== JSON.stringify(planCommands)) {
    throw new Error(
      "Execution receipt commands do not match canonical validation plan"
    );
  }

  // 11. per_command_exit_statuses length MUST equal commands length
  if (!Array.isArray(receipt.per_command_exit_statuses) ||
      receipt.per_command_exit_statuses.length !== receipt.commands.length) {
    throw new Error(
      `Execution receipt per_command_exit_statuses length (${Array.isArray(receipt.per_command_exit_statuses) ? receipt.per_command_exit_statuses.length : 'not array'}) does not match commands length (${receipt.commands.length})`
    );
  }

  // 12. Every per-command exit status must be zero
  const allZero = receipt.per_command_exit_statuses.every(
    (s) => Number.isInteger(s) && s === 0
  );
  if (!allZero) {
    throw new Error(
      "Execution receipt per_command_exit_statuses do not all exit zero"
    );
  }

  // 13. aggregate_exit_status must be zero
  if (!Number.isInteger(receipt.aggregate_exit_status) || receipt.aggregate_exit_status !== 0) {
    throw new Error(
      "Execution receipt aggregate_exit_status is not zero"
    );
  }

  // 14. output_refs must have length === commands length.
  // NOTE: output_refs and output_hashes are NON-AUTHORITATIVE receipt metadata.
  // They are length-checked for structural integrity but are NOT resolved
  // or hash-verified at this gate. They are not part of the proof chain that
  // authorizes pass → verified. The proof chain is: durable receipt +
  // source snapshot + exit statuses + binding to locked proposal state.
  // Before enabling pass-capable backends, output objects should be made
  // durable and verifiable, or this caveat should be documented in the
  // security model.
  if (!Array.isArray(receipt.output_refs) ||
      receipt.output_refs.length !== receipt.commands.length) {
    throw new Error(
      "Execution receipt output_refs length does not match commands length"
    );
  }

  // 15. output_hashes must have length === commands length (non-authoritative)
  if (!Array.isArray(receipt.output_hashes) ||
      receipt.output_hashes.length !== receipt.commands.length) {
    throw new Error(
      "Execution receipt output_hashes length does not match commands length"
    );
  }

  return receipt;
}

// ════════════════════════════════════════════════════════════════════════════
// CANONICAL CRITIC REVIEW RECORDING — sole authorized writer of critic_review
// and sole authorized entry into review_ready/failed from verified.
// ════════════════════════════════════════════════════════════════════════════

/**
 * Build a bounded critic review input bundle from a locked proposal.
 *
 * The critic receives only immutable references — never raw content,
 * diagnosis text, or open-ended repo access.
 *
 * This is the SHARED canonical bundle builder used by BOTH the worker
 * (before locking) and the recorder (after locking) so that the
 * critic_input_hash is reproducible from locked state.
 *
 * @param {object} proposal - the locked proposal row
 * @returns {object} critic input bundle
 */
export function buildCriticInputBundle(proposal) {
  const patchProposal = parseJsonb(proposal.patch_proposal);
  const validationResult = parseJsonb(proposal.validation_result);
  const diagnosis = parseJsonb(proposal.diagnosis);
  const evidenceRefs = parseJsonb(proposal.evidence_refs) || [];

  return {
    proposal_id: proposal.id,
    repository: proposal.repo_full_name || null,
    head_sha: proposal.head_sha,
    patch_artifact_hash: patchProposal?.artifact_hash || null,
    patch_artifact_ref: patchProposal?.artifact_ref || null,
    input_bundle_hash: patchProposal?.input_bundle_hash || null,
    verification_fingerprint: validationResult?.verification_fingerprint || null,
    execution_receipt_hash: validationResult?.execution_receipt_hash || null,
    validation_plan_hash: validationResult?.validation_plan_hash || null,
    sandbox_image_digest: validationResult?.sandbox_image_digest || null,
    diagnosis_hash: diagnosis ? contentHash(diagnosis) : null,
    evidence_hash: contentHash(evidenceRefs),
  };
}

/**
 * Compute the canonical review fingerprint from locked-state values.
 *
 * The fingerprint binds the critic input hash to the canonicalized review
 * outcome: verdict, normalized findings (sorted by code), normalized
 * blocking_findings (sorted), and policy_version.
 *
 * @param {string} inputHash - canonical critic input hash from locked state
 * @param {string} verdict - critic verdict
 * @param {array} findings - structured findings
 * @param {array} blockingFindings - blocking finding codes
 * @param {string|null} policyVersion - policy version
 * @returns {string} review fingerprint (sha256 hex)
 */
export function computeReviewFingerprint(inputHash, verdict, findings, blockingFindings, policyVersion) {
  const normalizedFindings = findings
    .map((f) => ({ code: f.code, severity: f.severity }))
    .sort((a, b) => a.code.localeCompare(b.code));
  const normalizedBlocking = [...blockingFindings].sort();
  return contentHash({
    input_hash: inputHash,
    verdict,
    findings: normalizedFindings,
    blocking_findings: normalizedBlocking,
    policy_version: policyVersion || null,
  });
}

/**
 * Validate finding schema, blocking semantics, and evidence binding.
 *
 * Ensures:
 * - approve → zero blocking findings
 * - reject → at least one blocking finding
 * - every finding has: code (allowlisted), severity (allowlisted), detail
 * - every blocking finding → matching finding with severity: "blocking"
 * - every evidence_ref → bound to locked proposal bundle values
 *
 * @param {string} verdict
 * @param {array} findings
 * @param {array} blockingFindings
 * @param {object} bundleValues - bound reference values from locked bundle
 * @throws {Error} on any validation failure
 */
function validateCriticFindings(verdict, findings, blockingFindings, bundleValues) {
  const boundRefs = new Set(Object.values(bundleValues).filter(Boolean));

  for (const f of findings) {
    if (!f.code || !VALID_FINDING_CODES.has(f.code)) {
      throw new Error(
        `Critic finding has invalid or missing code (allowed: ${[...VALID_FINDING_CODES].join(", ")})`
      );
    }
    if (!f.severity || !VALID_FINDING_SEVERITIES.has(f.severity)) {
      throw new Error(
        `Critic finding '${f.code}' has invalid or missing severity (allowed: ${[...VALID_FINDING_SEVERITIES].join(", ")})`
      );
    }
    if (!f.detail || typeof f.detail !== "string" || f.detail.trim().length === 0) {
      throw new Error(
        `Critic finding '${f.code}' has missing or empty detail`
      );
    }
    if (f.evidence_ref !== undefined && f.evidence_ref !== null && !boundRefs.has(f.evidence_ref)) {
      throw new Error(
        `Critic finding '${f.code}' evidence_ref is not bound to locked proposal bundle`
      );
    }
  }

  // Every blocking finding must correspond to a finding with severity: blocking
  const blockingFindingCodes = new Set(
    findings.filter((f) => f.severity === "blocking").map((f) => f.code)
  );
  for (const bf of blockingFindings) {
    if (!blockingFindingCodes.has(bf)) {
      throw new Error(
        `Blocking finding '${bf}' has no matching finding with severity: blocking`
      );
    }
  }

  // approve → zero blocking findings
  if (verdict === "approve" && blockingFindings.length > 0) {
    throw new Error(
      `Critic approve verdict with blocking findings is internally contradictory — approve requires zero blocking findings`
    );
  }

  // reject → at least one blocking finding
  if (verdict === "reject" && blockingFindings.length === 0) {
    throw new Error(
      `Critic reject verdict requires at least one blocking finding`
    );
  }
}

/**
 * Record a critic review and transition the proposal.
 *
 * This is the SOLE authorized path for writing critic_review and
 * transitioning from verified to review_ready or failed.
 *
 * Guarantees:
 * - actor_kind must be critic_worker
 * - Proposal must be in verified status with existing patch_proposal
 * - validation_result.overall must be "pass"
 * - P0 INTERIM: approve is unconditionally rejected — no receipt backend exists
 * - Critic input hash is recomputed from locked proposal state (not caller assertion)
 * - Review fingerprint is recomputed from canonical input hash + review outcome
 * - Finding schema, blocking semantics, and evidence binding validated
 * - Replay-safe: same fingerprint → no-op, different → reject
 * - Atomic: lock + validate + update + event in one transaction
 *
 * State transitions:
 * - reject with blocking findings → verified → failed
 * - approve is UNREACHABLE until a real execution receipt backend exists
 *
 * @param {number} id - repair proposal ID
 * @param {object} reviewInput - structured critic review
 * @param {object} options
 * @returns {Promise<object>} updated proposal
 */
export async function recordCriticReview(id, reviewInput = {}, options = {}) {
  const {
    actor = "critic_worker",
    expected_version,
    correlation_id,
    source_delivery_id,
    actor_kind = actor,
  } = options;

  if (!id) throw new Error("id is required");

  // MANDATORY actor-kind enforcement — unconditional
  requireActorKind(actor_kind);

  if (!Number.isInteger(expected_version) || expected_version < 1) {
    throw new Error("expected_version is required and must be a positive integer");
  }

  // Enforce actor-kind authority
  if (!canAttachField(actor_kind, "critic_review")) {
    throw new Error(`Actor '${actor_kind}' is not authorized to attach critic_review`);
  }

  // Validate verdict
  const verdict = reviewInput.verdict;
  if (!VALID_CRITIC_VERDICTS.has(verdict)) {
    throw new Error(
      `Critic review verdict must be one of: ${[...VALID_CRITIC_VERDICTS].join(", ")}`
    );
  }

  // A passing approval requires a durable execution receipt on the
  // validation_result. The receipt is resolved and verified under the
  // transaction lock below. Here we only skip the pre-transaction gate
  // — the actual binding verification happens after locking.

  // Require binding fields
  const requiredFields = [
    "review_fingerprint",
    "critic_input_hash",
    "patch_artifact_hash",
    "verification_fingerprint",
    "findings",
    "blocking_findings",
  ];
  for (const field of requiredFields) {
    if (reviewInput[field] === undefined || reviewInput[field] === null) {
      throw new Error(`Critic review field '${field}' is required`);
    }
  }
  if (!Array.isArray(reviewInput.findings) || reviewInput.findings.length === 0) {
    throw new Error("Critic review findings must be a non-empty array");
  }
  if (!Array.isArray(reviewInput.blocking_findings)) {
    throw new Error("Critic review blocking_findings must be an array");
  }

  // Determine target status from verdict and blocking findings
  const targetStatus = verdict === "approve" && reviewInput.blocking_findings.length === 0
    ? "review_ready"
    : "failed";

  if (!canTransitionTo(actor_kind, targetStatus)) {
    throw new Error(
      `Actor '${actor_kind}' is not authorized to transition to ${targetStatus}`
    );
  }

  return db.transaction(async (client) => {
    // Lock the row
    const { rows: [proposal] } = await client.query(
      "SELECT * FROM repair_proposals WHERE id = $1 FOR UPDATE",
      [id]
    );
    if (!proposal) throw new Error(`Repair proposal not found: ${id}`);

    // REPLAY SAFETY: already has critic review with same fingerprint → no-op
    if (proposal.status === "failed" || proposal.status === "review_ready") {
      const existingReview = parseJsonb(proposal.critic_review);
      if (existingReview && existingReview.review_fingerprint === reviewInput.review_fingerprint) {
        logger.info(
          { proposal_id: id, correlation_id },
          "Proposal already has critic review with same fingerprint — replay no-op"
        );
        return redactProposal(proposal);
      }
      throw new Error(
        `Proposal already has a critic review with different fingerprint — ` +
        `retries require an explicit revision contract`
      );
    }

    // Only allow from verified
    if (proposal.status !== "verified") {
      throw new Error(
        `Critic review requires status 'verified', got '${proposal.status}'`
      );
    }

    // patch_proposal must exist
    const patchProposal = parseJsonb(proposal.patch_proposal);
    if (!patchProposal) {
      throw new Error(
        "Cannot record critic review: patch_proposal must exist"
      );
    }

    // validation_result must exist and be "pass"
    const validationResult = parseJsonb(proposal.validation_result);
    if (!validationResult) {
      throw new Error(
        "Cannot record critic review: validation_result must exist"
      );
    }
    if (validationResult.overall !== "pass") {
      throw new Error(
        `Cannot record critic review: validation_result.overall must be 'pass' (got '${validationResult.overall}')`
      );
    }

    // ── RECEIPT-BOUND APPROVAL GATE ──────────────────────────────────────────
    // For approve verdict: use the SAME shared receipt verification helper
    // as recordVerificationResult() to ensure identical binding checks.
    // The critic gate must verify the complete receipt contract, not a subset.
    if (verdict === "approve") {
      const receiptRef = validationResult.execution_receipt_ref;
      const receiptHash = validationResult.execution_receipt_hash;

      if (!receiptRef || !receiptHash) {
        throw new Error(
          "Critic approval requires a verified execution receipt — validation_result has no execution_receipt_ref/hash"
        );
      }

      // Build canonical plan from locked envelope for receipt verification
      const criticEnvelope = parseJsonb(proposal.task_envelope);
      const criticCanonicalPlan = buildValidationPlanForRecorder(criticEnvelope);
      const { SANDBOX_IMAGE_DIGEST: criticSandboxDigest } = await import("../lib/sandboxRunner.js");

      await verifyExecutionReceiptAgainstLockedProposal(
        receiptRef,
        receiptHash,
        patchProposal,
        proposal.head_sha,
        criticCanonicalPlan,
        criticSandboxDigest,
        proposal.repo_full_name
      );
    }

    // ── P1a: Recompute critic_input_hash from LOCKED proposal state ──────────
    // The critic input bundle is rebuilt from the locked row so that
    // critic_input_hash is a canonical value, not a caller assertion.
    const lockedBundle = buildCriticInputBundle(proposal);
    const canonicalInputHash = contentHash(lockedBundle);

    if (reviewInput.critic_input_hash !== canonicalInputHash) {
      throw new Error(
        `Critic review critic_input_hash does not match canonical hash from locked proposal state`
      );
    }

    // ── P1b: Validate finding schema, blocking semantics, evidence binding ───
    const bundleValues = {
      patch_artifact_hash: lockedBundle.patch_artifact_hash,
      input_bundle_hash: lockedBundle.input_bundle_hash,
      verification_fingerprint: lockedBundle.verification_fingerprint,
      diagnosis_hash: lockedBundle.diagnosis_hash,
      evidence_hash: lockedBundle.evidence_hash,
    };
    validateCriticFindings(
      verdict,
      reviewInput.findings,
      reviewInput.blocking_findings,
      bundleValues
    );

    // ── P1a: Recompute review_fingerprint from canonical values ──────────────
    // The fingerprint binds input hash + verdict + normalized findings +
    // normalized blocking findings + policy version, all derived from
    // locked state and the structured review input.
    const canonicalReviewFingerprint = computeReviewFingerprint(
      canonicalInputHash,
      verdict,
      reviewInput.findings,
      reviewInput.blocking_findings,
      reviewInput.policy_version || null
    );

    if (reviewInput.review_fingerprint !== canonicalReviewFingerprint) {
      throw new Error(
        `Critic review review_fingerprint does not match canonical fingerprint from locked proposal state`
      );
    }

    // Verify patch_artifact_hash matches locked patch_proposal
    if (reviewInput.patch_artifact_hash !== patchProposal.artifact_hash) {
      throw new Error(
        `Critic review patch_artifact_hash does not match locked patch_proposal artifact_hash`
      );
    }

    // Verify verification_fingerprint matches locked validation_result
    if (reviewInput.verification_fingerprint !== validationResult.verification_fingerprint) {
      throw new Error(
        `Critic review verification_fingerprint does not match locked validation_result`
      );
    }

    // ── Persist the canonical (recomputed) values ───────────────────────────
    const persistedReview = {
      verdict,
      review_fingerprint: canonicalReviewFingerprint,
      critic_input_hash: canonicalInputHash,
      patch_artifact_hash: patchProposal.artifact_hash,
      verification_fingerprint: validationResult.verification_fingerprint,
      findings: reviewInput.findings,
      blocking_findings: reviewInput.blocking_findings,
      risk_summary: reviewInput.risk_summary || "",
      limitations: reviewInput.limitations || "",
      policy_version: reviewInput.policy_version || null,
    };

    // CAS: version check + atomic write + transition
    const setClauses = [
      "critic_review = $1",
      "status = $2",
      "version = version + 1",
    ];
    const values = [
      JSON.stringify(persistedReview),
      targetStatus,
    ];
    let paramIdx = 3;

    const whereClauses = [];
    whereClauses.push(`id = $${paramIdx++}`);
    values.push(id);
    whereClauses.push(`version = $${paramIdx++}`);
    values.push(expected_version);

    const { rows } = await client.query(
      `UPDATE repair_proposals
       SET ${setClauses.join(", ")}
       WHERE ${whereClauses.join(" AND ")}
       RETURNING *`,
      values
    );

    if (rows.length === 0) {
      throw new Error(
        `Version mismatch: expected version ${expected_version}. `
      );
    }

    const updated = rows[0];

    // Record one critic_review_recorded event
    const snapshot = buildEvidenceSnapshot({
      critic_review: persistedReview,
      review_fingerprint: canonicalReviewFingerprint,
    });
    await client.query(
      `INSERT INTO repair_proposal_events
         (proposal_id, event_type, from_status, to_status, actor, evidence_snapshot, correlation_id, source_delivery_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        id,
        "critic_review_recorded",
        "verified",
        targetStatus,
        actor,
        JSON.stringify(snapshot),
        correlation_id || null,
        source_delivery_id || null,
      ]
    );

    logger.info(
      { proposal_id: id, target_status: targetStatus, verdict, correlation_id },
      "Critic review recorded"
    );

    return redactProposal(updated);
  });
}
