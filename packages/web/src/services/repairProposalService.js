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
import {
  ACTOR_KINDS,
  canCreateProposal,
  canAttachField,
  canTransitionTo,
} from "./repairAuthorityService.js";

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
export const VALID_VALIDATION_OVERALL = new Set(["pass", "fail"]);

// ── Valid critic verdicts ────────────────────────────────────────────────────
export const VALID_CRITIC_VERDICTS = new Set(["approve", "reject"]);

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
function parseJsonb(value) {
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

  return errors.length > 0 ? { valid: false, errors } : { valid: true };
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

  // Validate ALL evidence types before touching the database
  if (evidence.diagnosis) {
    const check = validateDiagnosis(evidence.diagnosis);
    if (!check.valid) throw new Error(`Invalid diagnosis: ${check.errors.join("; ")}`);
  }
  if (evidence.evidence_refs) {
    const check = validateEvidenceRefs(evidence.evidence_refs);
    if (!check.valid) throw new Error(`Invalid evidence_refs: ${check.errors.join("; ")}`);
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
    ["evidence_refs", evidence.evidence_refs],
    ["patch_proposal", evidence.patch_proposal],
    ["validation_result", evidence.validation_result],
    ["critic_review", evidence.critic_review],
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

    // Enforce patch scope against stored envelope
    if (evidence.patch_proposal) {
      const envelope = parseJsonb(proposal.task_envelope);
      if (envelope) {
        const scopeErrors = checkPatchAgainstEnvelope(evidence.patch_proposal, envelope);
        if (scopeErrors.length > 0) {
          throw new Error(`Patch exceeds envelope scope: ${scopeErrors.join("; ")}`);
        }
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
