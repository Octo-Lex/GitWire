// src/services/diagnosisWorkerService.js
// Trusted diagnosis worker service for CI repair proposals.
//
// Reads immutable CI evidence from a proposal, produces a structured
// diagnosis, and attaches it through the authorized service path with
// actor_kind: diagnosis_worker.
//
// Strict boundaries:
// - Input: existing proposal + its immutable CI evidence only
// - Output: only the `diagnosis` field
// - No lifecycle transition authority
// - No repository writes, patch generation, new GitHub reads, or tool expansion
// - Every diagnosis claim must reference collected evidence
// - Accept proposals only in `evidence_collected`

import { db } from "../lib/db.js";
import { logger } from "../lib/logger.js";
import crypto from "crypto";
import {
  attachEvidence,
  getProposal,
  validateDiagnosis,
  validateDiagnosisEvidenceBinding,
} from "./repairProposalService.js";
import { ACTOR_KINDS } from "./repairAuthorityService.js";

const ACTOR = ACTOR_KINDS.DIAGNOSIS_WORKER;

// ── Diagnosis limits ─────────────────────────────────────────────────────────
const LIMITS = Object.freeze({
  MAX_SUMMARY_LENGTH: 500,
  MAX_ROOT_CAUSE_LENGTH: 1000,
});

// ════════════════════════════════════════════════════════════════════════════
// PURE FUNCTIONS
// ════════════════════════════════════════════════════════════════════════════

/**
 * Categorize a failure based on log excerpt patterns.
 * Deterministic — no external calls.
 */
function categorizeFailure(excerpts) {
  const combined = excerpts.join(" ").toLowerCase();

  if (/syntaxerror|parsing error|unexpected token/.test(combined)) {
    return "syntax_error";
  }
  if (/typeerror|is not a function|cannot read prop/.test(combined)) {
    return "type_error";
  }
  if (/importerror|modulenotfound|cannot find module|enoent/.test(combined)) {
    return "dependency_error";
  }
  if (/timeout|timed out|deadline exceeded/.test(combined)) {
    return "timeout";
  }
  if (/test failed|tests? failed|assert/.test(combined)) {
    return "test_failure";
  }
  if (/build failed|compilation error|webpack|tsc/.test(combined)) {
    return "build_error";
  }
  if (/unauthorized|forbidden|403|401|authentication/.test(combined)) {
    return "auth_error";
  }
  return "unknown";
}

/**
 * Produce a structured diagnosis from immutable CI evidence.
 *
 * This is a deterministic stub diagnosis engine. It extracts failure
 * information from the already-collected evidence_refs and produces
 * a minimal valid diagnosis that references every evidence item.
 *
 * In production, this would be replaced by an LLM-backed engine that
 * receives the same evidence_refs and returns a diagnosis object.
 * The governance framework (validation, evidence binding, authority,
 * audit trail) operates identically regardless of the engine.
 *
 * @param {object[]} evidenceRefs - immutable evidence_refs from the proposal
 * @returns {object} structured diagnosis with all required fields
 */
export function diagnoseFromEvidence(evidenceRefs) {
  if (!Array.isArray(evidenceRefs) || evidenceRefs.length === 0) {
    throw new Error("Cannot diagnose without evidence refs");
  }

  // Extract information from evidence
  const jobRefs = evidenceRefs.filter((r) => r.type === "ci_job");
  const excerptRefs = evidenceRefs.filter(
    (r) => r.type === "ci_log_excerpt" && r.excerpt
  );
  const runRefs = evidenceRefs.filter((r) => r.type === "workflow_run");

  // Derive summary from run and job metadata
  const runDesc = runRefs[0]?.description || "CI workflow run";
  const jobNames = jobRefs.map((r) => r.description).filter(Boolean);
  const summary = jobNames.length > 0
    ? `CI failure in ${jobNames.join(", ")}. ${runDesc}.`
    : runDesc;

  // Categorize from log excerpts
  const excerpts = excerptRefs.map((r) => r.excerpt);
  const category = categorizeFailure(excerpts);

  // Build root cause claim from available evidence
  let rootCause = "Insufficient evidence for specific root-cause claim.";
  if (excerpts.length > 0) {
    // Extract first meaningful line from the excerpt
    const lines = excerpts[0].split("\n").filter((l) => l.trim().length > 0);
    if (lines.length > 0) {
      rootCause = `Failure indicator: ${lines[0].trim()}`;
      if (rootCause.length > LIMITS.MAX_ROOT_CAUSE_LENGTH) {
        rootCause = rootCause.substring(0, LIMITS.MAX_ROOT_CAUSE_LENGTH);
      }
    }
  }

  // All evidence refs must be referenced
  const evidenceIds = evidenceRefs.map((r) => r.source);

  // Confidence: high when we have log excerpts, medium otherwise
  const confidence = excerpts.length > 0 ? "medium" : "low";

  const diagnosis = {
    summary: summary.length > LIMITS.MAX_SUMMARY_LENGTH
      ? summary.substring(0, LIMITS.MAX_SUMMARY_LENGTH)
      : summary,
    failure_category: category,
    root_cause_claim: rootCause,
    confidence,
    limitations: excerpts.length === 0
      ? "No log excerpts available — diagnosis based on metadata only."
      : undefined,
    evidence_ids: evidenceIds,
  };

  // Remove undefined fields (limitations is optional)
  Object.keys(diagnosis).forEach((k) => diagnosis[k] === undefined && delete diagnosis[k]);

  return diagnosis;
}

// ════════════════════════════════════════════════════════════════════════════
// TRUSTED DIAGNOSIS PIPELINE
// ════════════════════════════════════════════════════════════════════════════

/**
 * Produce a diagnosis for a proposal and attach it through the authorized path.
 *
 * Guarantees:
 * - Proposal must be in `evidence_collected` status
 * - Diagnosis is derived solely from the proposal's immutable evidence_refs
 * - Every diagnosis claim references collected evidence (evidence binding)
 * - No lifecycle transition (diagnosis_worker has no transition authority)
 * - No GitHub API calls or tool expansion
 * - Idempotent: if diagnosis already exists, no-op
 * - CAS: uses expected_version for race-safe attachment
 *
 * @param {number} proposalId - repair proposal ID
 * @param {object} [options] - optional parameters
 * @param {string} [options.correlation_id] - correlation ID for audit trail
 * @returns {Promise<object>} updated proposal with diagnosis attached
 */
export async function diagnoseProposal(proposalId, options = {}) {
  const { correlation_id } = options;

  if (!proposalId) throw new Error("proposalId is required");

  // ── 1. Fetch proposal ────────────────────────────────────────────────────
  const proposal = await getProposal(proposalId);
  if (!proposal) {
    throw new Error(`Repair proposal not found: ${proposalId}`);
  }

  // ── 2. Status gate: only evidence_collected ──────────────────────────────
  if (proposal.status !== "evidence_collected") {
    throw new Error(
      `Diagnosis requires status 'evidence_collected' (current: '${proposal.status}')`
    );
  }

  // ── 3. Idempotent: skip if diagnosis already exists ──────────────────────
  if (proposal.diagnosis) {
    logger.info(
      { proposal_id: proposalId, correlation_id },
      "Proposal already has diagnosis — skipping"
    );
    return proposal;
  }

  // ── 4. Extract immutable CI evidence ─────────────────────────────────────
  const evidenceRefs = proposal.evidence_refs;
  if (!Array.isArray(evidenceRefs) || evidenceRefs.length === 0) {
    throw new Error("Proposal has no evidence_refs — cannot diagnose");
  }

  // ── 5. Produce diagnosis from evidence (deterministic engine) ────────────
  const diagnosis = diagnoseFromEvidence(evidenceRefs);

  // ── 6. Validate diagnosis schema ─────────────────────────────────────────
  const schemaCheck = validateDiagnosis(diagnosis);
  if (!schemaCheck.valid) {
    throw new Error(`Invalid diagnosis: ${schemaCheck.errors.join("; ")}`);
  }

  // ── 7. Validate evidence binding ─────────────────────────────────────────
  const bindingCheck = validateDiagnosisEvidenceBinding(diagnosis, evidenceRefs);
  if (!bindingCheck.valid) {
    throw new Error(`Diagnosis evidence binding failed: ${bindingCheck.errors.join("; ")}`);
  }

  // ── 8. Attach through authorized path ────────────────────────────────────
  // actor_kind: diagnosis_worker → enforces field-level authority
  // No transition — diagnosis_worker has no transition authority
  const updated = await attachEvidence(
    proposalId,
    { diagnosis },
    ACTOR,
    proposal.version,
    correlation_id,
    ACTOR_KINDS.DIAGNOSIS_WORKER
  );

  logger.info(
    { proposal_id: proposalId, correlation_id, category: diagnosis.failure_category },
    "Diagnosis attached to repair proposal"
  );

  return updated;
}
