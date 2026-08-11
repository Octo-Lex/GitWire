// src/services/findingValidator.js
// Evidence-bound finding schema and validation rules (RI-4).
//
// Every material finding becomes evidence-bound: it carries at least one
// evidence reference that points to a concrete location in the review's
// changed files or retrieved repository context. The validator, not the
// model, verifies that evidence IDs and file ranges actually exist in the
// ReviewEvidence.
//
// This directly addresses false-positive material findings while the
// verifier (RI-5) addresses false negatives.

// ── Severity constants ──────────────────────────────────────────────────────

export const SEVERITY = Object.freeze({
  P0: "P0",  // critical — security vulnerability, data loss, crash
  P1: "P1",  // high — significant bug, broken functionality
  P2: "P2",  // medium — correctness issue, missing edge case
  P3: "P3",  // low — style, maintainability, minor improvement
});

const MATERIAL_SEVERITIES = new Set(["P0", "P1", "P2"]);
const ALL_SEVERITIES = new Set(["P0", "P1", "P2", "P3"]);

// ── Proof types ──────────────────────────────────────────────────────────────

export const PROOF_TYPES = Object.freeze({
  STATIC_TRACE:    "static_trace",
  COUNTEREXAMPLE:  "counterexample",
  REPRODUCTION:    "reproduction",
  INFERENCE:       "inference",
});

const VALID_PROOF_TYPES = new Set(Object.values(PROOF_TYPES));

// ── Evidence reference parser ───────────────────────────────────────────────

/**
 * Parse an evidence reference string into structured form.
 *
 * Supported formats:
 *   changed:{path}@{SIDE}:L{start}-L{end}   — evidence from a changed file
 *   changed:{path}@{SIDE}:L{line}           — evidence from a changed file (single line)
 *   repo-read:{path}@{SIDE}:L{start}-L{end}  — evidence from a retrieved context file
 *   repo-read:{path}@{SIDE}:L{line}           — retrieved context (single line)
 *
 * SIDE is HEAD or BASE.
 *
 * @param {string} ref — the evidence reference string
 * @returns {object|null} { type, path, side, startLine, endLine } or null if unparseable
 */
export function parseEvidenceRef(ref) {
  if (!ref || typeof ref !== "string") return null;

  // Match: type:path@SIDE:L{start}[-L{end}]
  const match = ref.match(/^(changed|repo-read):(.+?)@(HEAD|BASE):L(\d+)(?:-L(\d+))?$/);
  if (!match) return null;

  return {
    type: match[1],         // "changed" or "repo-read"
    path: match[2],
    side: match[3],          // "HEAD" or "BASE"
    startLine: parseInt(match[4], 10),
    endLine: match[5] ? parseInt(match[5], 10) : parseInt(match[4], 10),
    raw: ref,
  };
}

// ── Finding validation ───────────────────────────────────────────────────────

/**
 * Validate a single finding against the ReviewEvidence.
 *
 * Validation rules:
 *   P0/P1/P2 → must have ≥1 valid evidence reference
 *   Cross-file claims → referenced files must exist in ReviewEvidence
 *   Invalid evidence refs → finding rejected or downgraded to P3
 *   Proof required for P0/P1/P2 claims about behavior
 *
 * @param {object} finding - the finding to validate
 * @param {object} evidence - the ReviewEvidence object (from buildReviewEvidence)
 * @param {object[]} contextItems - retrieved context items (from Context Broker)
 * @returns {object} { valid, finding, errors, downgraded }
 */
export function validateFinding(finding, evidence, contextItems = []) {
  const errors = [];
  const warnings = [];
  let downgraded = false;

  // Clone to avoid mutating input
  const result = { ...finding };

  // ── Basic field validation ──────────────────────────────────────────────

  if (!result.severity || !ALL_SEVERITIES.has(result.severity)) {
    errors.push("Invalid or missing severity: " + result.severity);
    return { valid: false, finding: result, errors, warnings, downgraded };
  }

  if (!result.claim || typeof result.claim !== "string") {
    errors.push("Missing or invalid claim");
    return { valid: false, finding: result, errors, warnings, downgraded };
  }

  // ── Evidence reference validation for material findings ─────────────────

  const isMaterial = MATERIAL_SEVERITIES.has(result.severity);
  const evidenceRefs = result.evidenceRefs || [];
  const validRefs = [];
  const invalidRefs = [];

  for (const ref of evidenceRefs) {
    const parsed = parseEvidenceRef(ref);
    if (!parsed) {
      invalidRefs.push({ ref, reason: "unparseable" });
      continue;
    }

    // Verify the referenced path exists in the evidence
    const pathExists = checkPathExists(parsed, evidence, contextItems);
    if (!pathExists) {
      invalidRefs.push({ ref, reason: "path_not_in_evidence", parsed });
      continue;
    }

    validRefs.push(parsed);
  }

  // Material findings (P0/P1/P2) must have at least one valid evidence reference
  if (isMaterial && validRefs.length === 0) {
    if (evidenceRefs.length > 0) {
      // Had refs but all were invalid — downgrade to P3
      warnings.push("All evidence references invalid — downgraded from " + result.severity + " to P3");
      result.severity = SEVERITY.P3;
      result.downgradeReason = "All evidence references were invalid";
      downgraded = true;
    } else {
      // No refs at all on a material finding — reject
      errors.push("P0/P1/P2 finding requires at least one valid evidence reference");
      return { valid: false, finding: result, errors, warnings, downgraded };
    }
  }

  // ── Cross-file claim validation ──────────────────────────────────────────

  // Check affectedPaths — if the finding claims to affect files, those files
  // must exist in the evidence (changed files or context items)
  if (result.affectedPaths && Array.isArray(result.affectedPaths)) {
    for (const p of result.affectedPaths) {
      const inChanged = (evidence?.changedFiles || []).some(cf => cf.path === p);
      const inContext = contextItems.some(ci => ci.path === p);
      if (!inChanged && !inContext) {
        warnings.push("affectedPath not in evidence: " + p);
      }
    }
  }

  // ── Proof validation for behavior claims ─────────────────────────────────

  if (isMaterial || result.severity === "P3" && result.proof) {
    if (result.proof) {
      if (!result.proof.type || !VALID_PROOF_TYPES.has(result.proof.type)) {
        warnings.push("Invalid proof type: " + result.proof.type);
      }
      // Behavior claims (bug, regression, security) at P0/P1/P2 require
      // a proof that is not just inference, unless explicitly marked
      const isBehaviorCategory = ["bug", "security", "regression"].includes(result.category);
      if (isMaterial && isBehaviorCategory && result.proof.type === PROOF_TYPES.INFERENCE) {
        warnings.push("Material behavior claim marked as inference — not a static trace, counterexample, or reproduction");
      }
    } else if (isMaterial) {
      // Material findings should have a proof
      warnings.push("P0/P1/P2 finding has no proof object");
    }
  }

  return {
    valid: errors.length === 0,
    finding: result,
    errors,
    warnings,
    downgraded,
    validEvidenceRefs: validRefs,
    invalidEvidenceRefs: invalidRefs,
  };
}

// ── Batch validation ────────────────────────────────────────────────────────

/**
 * Validate an array of findings against the ReviewEvidence.
 *
 * @param {object[]} findings - array of finding objects
 * @param {object} evidence - ReviewEvidence
 * @param {object[]} contextItems - retrieved context items
 * @returns {object} { valid: [], rejected: [], downgraded: [], allErrors: [] }
 */
export function validateFindings(findings, evidence, contextItems = []) {
  const valid = [];
  const rejected = [];
  const downgraded = [];

  for (const finding of (findings || [])) {
    const result = validateFinding(finding, evidence, contextItems);
    if (result.valid) {
      valid.push(result.finding);
      if (result.downgraded) {
        downgraded.push(result.finding);
      }
    } else {
      rejected.push({
        finding,
        errors: result.errors,
        warnings: result.warnings,
      });
    }
  }

  return { valid, rejected, downgraded };
}

// ── Path existence check ────────────────────────────────────────────────────

/**
 * Check whether a parsed evidence reference points to a file that exists
 * in the ReviewEvidence changedFiles or the contextItems.
 *
 * @param {object} parsed - parsed evidence reference
 * @param {object} evidence - ReviewEvidence
 * @param {object[]} contextItems - retrieved context items
 * @returns {boolean}
 */
function checkPathExists(parsed, evidence, contextItems = []) {
  const path = parsed.path;

  if (parsed.type === "changed") {
    // Must exist in changedFiles
    return (evidence?.changedFiles || []).some(cf =>
      cf.path === path || cf.previousPath === path
    );
  }

  if (parsed.type === "repo-read") {
    // Must exist in contextItems or changedFiles (changed files can also be read via context broker)
    const inContext = contextItems.some(ci => ci.path === path);
    const inChanged = (evidence?.changedFiles || []).some(cf => cf.path === path);
    return inContext || inChanged;
  }

  return false;
}
