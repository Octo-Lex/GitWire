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

    // Validate source, side, and represented range
    const refCheck = validateEvidenceRef(parsed, evidence, contextItems);
    if (!refCheck.valid) {
      invalidRefs.push({ ref, reason: refCheck.reason, parsed });
      continue;
    }

    validRefs.push(parsed);
  }

  // Material findings (P0/P1/P2) with invalid evidence refs:
  //   ALL refs invalid → downgrade to P3 (if refs were provided) or reject (no refs).
  //   SOME valid, some invalid → keep severity, discard only invalid refs.
  if (isMaterial && invalidRefs.length > 0) {
    if (validRefs.length === 0) {
      if (evidenceRefs.length > 0) {
        warnings.push("All evidence references invalid — downgraded from " + result.severity + " to P3");
        result.severity = SEVERITY.P3;
        result.downgradeReason = "All evidence references were invalid";
        downgraded = true;
      } else {
        errors.push("P0/P1/P2 finding requires at least one valid evidence reference");
        return { valid: false, finding: result, errors, warnings, downgraded };
      }
    } else {
      // Some valid, some invalid — keep severity, discard only invalid refs
      const invalidRefStrings = new Set(invalidRefs.map(r => r.ref));
      result.evidenceRefs = evidenceRefs.filter(ref => !invalidRefStrings.has(ref));
      warnings.push(invalidRefs.length + " invalid evidence reference(s) discarded — severity retained with " + validRefs.length + " valid ref(s)");
    }
  }

  // Material findings with no refs at all → reject
  if (isMaterial && validRefs.length === 0 && !downgraded) {
    errors.push("P0/P1/P2 finding requires at least one valid evidence reference");
    return { valid: false, finding: result, errors, warnings, downgraded };
  }

  // ── Cross-file claim validation ──────────────────────────────────────────

  if (result.affectedPaths && Array.isArray(result.affectedPaths)) {
    const evidenceContextItems = evidence?.contextItems || [];
    const allContextItems = [...evidenceContextItems, ...contextItems];
    for (const p of result.affectedPaths) {
      const inChanged = (evidence?.changedFiles || []).some(cf => cf.path === p || cf.previousPath === p);
      const inContext = allContextItems.some(ci => ci.path === p);
      if (!inChanged && !inContext) {
        if (MATERIAL_SEVERITIES.has(result.severity)) {
          // Material finding claims a file not in evidence → reject
          errors.push("affectedPath not in evidence: " + p + " — material finding cannot claim unverified file");
          return { valid: false, finding: result, errors, warnings, downgraded };
        } else {
          warnings.push("affectedPath not in evidence: " + p);
        }
      }
    }
  }

  // ── Proof validation for behavior claims ─────────────────────────────────

  if (MATERIAL_SEVERITIES.has(result.severity)) {
    const isBehaviorCategory = ["bug", "security", "regression"].includes(result.category);

    if (!result.proof) {
      // Material findings must have a proof object
      errors.push("P0/P1/P2 finding requires a proof object");
      return { valid: false, finding: result, errors, warnings, downgraded };
    }

    if (!result.proof.type || !VALID_PROOF_TYPES.has(result.proof.type)) {
      errors.push("Invalid or missing proof type: " + result.proof.type);
      return { valid: false, finding: result, errors, warnings, downgraded };
    }

    if (isBehaviorCategory && result.proof.type === PROOF_TYPES.INFERENCE) {
      // Inference is allowed but warned for behavior claims
      warnings.push("Material behavior claim marked as inference — not a static trace, counterexample, or reproduction");
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

// ── Evidence reference validation ───────────────────────────────────────────

/**
 * Validate that a parsed evidence reference points to a real file with
 * the correct side and a represented range.
 *
 * For changed: refs:
 *   - File must exist in changedFiles (by path or previousPath)
 *   - If side is HEAD, the file must have a non-null head identity
 *   - If side is BASE, the file must have a non-null base identity
 *   - Line range must be within the file's represented lines
 *
 * For repo-read: refs:
 *   - File must exist in evidence.contextItems or the passed contextItems
 *   - The context item's ref must match the requested side (HEAD=headSha, BASE=baseSha)
 *
 * @param {object} parsed - parsed evidence reference
 * @param {object} evidence - ReviewEvidence
 * @param {object[]} contextItems - externally passed context items
 * @returns {object} { valid: boolean, reason?: string }
 */
/**
 * Extract the represented line ranges from a unified diff patch by
 * walking the actual retained hunk body.
 *
 * Advances old/new cursors for context/+/- lines and stops at the
 * truncation marker ("... (truncated"). This ensures a truncated patch
 * only validates citations within the actually-represented portion.
 *
 * For HEAD side, tracks new-file line numbers.
 * For BASE side, tracks old-file line numbers.
 *
 * If no valid hunks are found, returns null (fail closed).
 *
 * @param {string} patch - unified diff patch (possibly truncated)
 * @param {string} side - "HEAD" or "BASE"
 * @returns {number[][]|null} array of [startLine, endLine] intervals, or null
 */
function extractPatchLineRanges(patch, side) {
  if (!patch || typeof patch !== "string") return null;
  const ranges = [];
  const hunkRegex = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/gm;
  let hunkMatch;
  let foundAnyHunk = false;

  while ((hunkMatch = hunkRegex.exec(patch)) !== null) {
    foundAnyHunk = true;
    let oldLine = parseInt(hunkMatch[1], 10);
    let newLine = parseInt(hunkMatch[2], 10);
    const hunkBodyStart = hunkMatch.index + hunkMatch[0].length;

    // Find where this hunk body ends: next @@ or end of patch
    const nextHunkIdx = patch.indexOf("\n@@", hunkBodyStart);
    const hunkBodyEnd = nextHunkIdx === -1 ? patch.length : nextHunkIdx + 1;
    const hunkBody = patch.substring(hunkBodyStart, hunkBodyEnd);

    // Track the represented interval for this hunk
    let intervalStart = null;
    let intervalEnd = null;

    for (const rawLine of hunkBody.split("\n")) {
      // Stop at truncation marker
      if (rawLine.includes("... (truncated")) break;

      if (rawLine.startsWith("@@")) break; // next hunk

      // Ignore the no-newline-at-end-of-file metadata marker
      if (rawLine.startsWith("\\ No newline at end of file")) continue;

      if (rawLine.startsWith("+")) {
        // Added line — advances new cursor
        if (side === "HEAD") {
          if (intervalStart === null) intervalStart = newLine;
          intervalEnd = newLine;
        }
        newLine++;
      } else if (rawLine.startsWith("-")) {
        // Removed line — advances old cursor
        if (side === "BASE") {
          if (intervalStart === null) intervalStart = oldLine;
          intervalEnd = oldLine;
        }
        oldLine++;
      } else if (rawLine.startsWith(" ")) {
        // Context line (starts with a single space) — advances both cursors.
        // A blank context line is represented as " " (single space), so
        // checking startsWith(" ") correctly includes it while excluding
        // empty lines and metadata markers.
        if (side === "HEAD") {
          if (intervalStart === null) intervalStart = newLine;
          intervalEnd = newLine;
        } else {
          if (intervalStart === null) intervalStart = oldLine;
          intervalEnd = oldLine;
        }
        oldLine++;
        newLine++;
      }
      // Any other line (empty, metadata) is ignored — does not advance cursors
    }

    if (intervalStart !== null && intervalEnd !== null) {
      ranges.push([intervalStart, intervalEnd]);
    }
  }

  return foundAnyHunk ? ranges : null;
}

/**
 * Check if a line range falls within any of the represented intervals.
 * Returns false if ranges is null (fail closed).
 */
function isLineInRange(startLine, endLine, ranges) {
  if (ranges === null) return false; // fail closed
  if (!Array.isArray(ranges) || ranges.length === 0) return false;
  return ranges.some(([rStart, rEnd]) => startLine >= rStart && endLine <= rEnd);
}

function validateEvidenceRef(parsed, evidence, contextItems = []) {
  const path = parsed.path;
  const changedFiles = evidence?.changedFiles || [];
  const evidenceContextItems = evidence?.contextItems || [];
  const allContextItems = [...evidenceContextItems, ...contextItems];

  // Generic line-range sanity check applies to all evidence types
  if (parsed.startLine < 1 || parsed.endLine < parsed.startLine) {
    return { valid: false, reason: "invalid_line_range" };
  }

  if (parsed.type === "changed") {
    const cf = changedFiles.find(f => f.path === path || f.previousPath === path);
    if (!cf) {
      return { valid: false, reason: "path_not_in_evidence" };
    }

    // Validate the requested side exists for this file
    if (parsed.side === "HEAD" && !cf.head) {
      return { valid: false, reason: "head_side_not_available (file may be removed)" };
    }
    if (parsed.side === "BASE" && !cf.base) {
      return { valid: false, reason: "base_side_not_available (file may be added)" };
    }

    const patchRanges = extractPatchLineRanges(cf.patch, parsed.side);
    if (!isLineInRange(parsed.startLine, parsed.endLine, patchRanges)) {
      return { valid: false, reason: "line_range_not_in_patch_hunks" };
    }

    return { valid: true };
  }

  if (parsed.type === "repo-read") {
    const reviewRoot = evidence?.review;
    const expectedSha = parsed.side === "HEAD" ? reviewRoot?.headSha : reviewRoot?.baseSha;

    // Require a file_read item matching path + requested SHA
    const ci = allContextItems.find(item =>
      item.path === path &&
      item.type === "file_read" &&
      (item.ref === expectedSha || item.resolvedSha === expectedSha)
    );
    if (!ci) {
      return { valid: false, reason: "file_read_not_found_or_ref_mismatch" };
    }

    // Validate cited lines against the context item's represented range.
    // If ci.range is present, use it. Otherwise derive from ci.content line count.
    let representedRange = null;
    if (ci.range && typeof ci.range.startLine === "number") {
      representedRange = [ci.range.startLine, ci.range.endLine || ci.range.startLine];
    } else if (typeof ci.content === "string") {
      // Full-file read with no explicit range — derive [1..lineCount]
      // Account for trailing newline: "a\nb" is 2 lines, "a\nb\n" is still 2 lines
      const lineCount = ci.content === "" ? 0 : ci.content.split("\n").length - (ci.content.endsWith("\n") ? 1 : 0);
      if (lineCount > 0) {
        representedRange = [1, lineCount];
      }
    }

    if (representedRange) {
      if (parsed.startLine < representedRange[0] || parsed.endLine > representedRange[1]) {
        return { valid: false, reason: "line_range_not_in_context_item" };
      }
    } else {
      // Cannot establish represented range — fail closed
      return { valid: false, reason: "context_range_not_establishable" };
    }

    return { valid: true };
  }

  return { valid: false, reason: "unknown_evidence_type" };
}
