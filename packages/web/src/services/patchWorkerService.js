// src/services/patchWorkerService.js
// Trusted patch proposal worker service for CI repair proposals.
//
// Reads immutable CI evidence + diagnosis from a proposal, constructs a
// bounded PatchInputBundle, generates a candidate patch artifact, and records
// it through the canonical recordPatchProposal() path with actor_kind: patch_worker.
//
// Strict boundaries:
// - Input: existing proposal + immutable evidence + diagnosis only
// - Output: only the patch_proposal field (via recordPatchProposal)
// - No repository writes, no branch creation, no PR creation, no commits
// - No GitHub API calls for mutation
// - Patch artifact is content-addressed and hash-verified
// - Scope is derived from verified artifact content, not caller-supplied metadata
// - Patch is pinned to the proposal's head_sha / base snapshot
// - Patch rationale must reference collected evidence and diagnosis evidence IDs
// - Policy is checked BEFORE artifact generation (precheck) and rechecked
//   under the proposal lock in recordPatchProposal()

import { db } from "../lib/db.js";
import { logger } from "../lib/logger.js";
import {
  getProposal,
  recordPatchProposal,
  buildPatchInputBundle,
  checkPatchPolicy,
  contentHash,
} from "./repairProposalService.js";
import { ACTOR_KINDS } from "./repairAuthorityService.js";
import { getConfigForRepo } from "./configService.js";
import { storeArtifact } from "../lib/patchArtifactStore.js";

const ACTOR = ACTOR_KINDS.PATCH_WORKER;

// Re-export buildPatchInputBundle for test access
export { buildPatchInputBundle };

// ════════════════════════════════════════════════════════════════════════════
// CANDIDATE PATCH GENERATION — produces real content-addressed artifact
// ════════════════════════════════════════════════════════════════════════════

/**
 * Escape a string for safe use inside a RegExp.
 * @param {string} s
 * @returns {string}
 */
function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Generate a candidate patch artifact from the bounded bundle.
 *
 * Produces canonical JSON structured edit operations, stores them in the
 * durable content-addressed artifact store, and returns the artifact reference
 * plus the derived metadata.
 *
 * This is a deterministic stub engine. In production, this would be
 * replaced by an LLM-backed engine that receives the same bounded bundle.
 * The governance framework operates identically regardless.
 *
 * @param {object} bundle - the bounded PatchInputBundle (must include diagnosis, evidence_refs)
 * @returns {Promise<object>} { artifact_ref, artifact_hash, artifact_content, derived }
 */
export async function generateCandidatePatch(bundle) {
  if (!bundle || !bundle.diagnosis) {
    throw new Error("Cannot generate patch: bundle missing diagnosis");
  }
  if (!Array.isArray(bundle.evidence_refs) || bundle.evidence_refs.length === 0) {
    throw new Error("Cannot generate patch: bundle missing evidence_refs");
  }

  // Derive target file from source_files or workflow_file evidence
  const sourceFile = (bundle.source_files || [])[0];
  const targetPath = sourceFile ? sourceFile.path : "src/unknown";
  const sourceContent = sourceFile ? sourceFile.content : "";

  // ── no-unused-vars fix path ─────────────────────────────────────────────
  // When the diagnosis indicates unused-variable lint errors, produce a patch
  // that removes the offending declarations. The diagnosis carries the variable
  // names either in root_cause_claim (ESLint output) or suggested_fix.
  // This is a targeted stub enhancement for lint_error/no-unused-vars — the
  // general LLM-backed engine would handle arbitrary failure types.
  const diagText = [
    bundle.diagnosis.root_cause_claim || "",
    bundle.diagnosis.suggested_fix || "",
    bundle.diagnosis.summary || "",
  ].join(" ");

  const isUnusedVarsFailure = /no-unused-vars|assigned a value but never used/i.test(diagText);

  let artifactContent;
  if (isUnusedVarsFailure && sourceContent) {
    // Extract variable names from ESLint-style error messages:
    //   'varName' is assigned a value but never used
    const unusedVarPattern = /'([^']+)' is assigned a value but never used/g;
    const unusedVars = [];
    let match;
    while ((match = unusedVarPattern.exec(diagText)) !== null) {
      unusedVars.push(match[1]);
    }

    // Also match suggested_fix patterns like: Remove unused variables 'a', 'b'
    const removePattern = /Remove.*?variables?\s+(.+)/i;
    const removeMatch = diagText.match(removePattern);
    if (removeMatch) {
      // Extract quoted names from the suggested fix
      const quoted = removeMatch[1].matchAll(/'([^']+)'/g);
      for (const q of quoted) {
        if (!unusedVars.includes(q[1])) unusedVars.push(q[1]);
      }
    }

    if (unusedVars.length > 0 || isUnusedVarsFailure) {
      // The diagnosis may only capture the FIRST ESLint error (CI logs are
      // often truncated). Supplement with a source-content scan: find ALL
      // const/let/var declarations whose names are never referenced elsewhere
      // in the file. This is a mini dead-declaration detector — sufficient
      // for the no-unused-vars lint rule, which is the common proof case.
      const lines = sourceContent.split("\n");
      // Collect all declarations: { name, lineIndex }
      const declarations = [];
      const declRegex = /^\s*(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=/;
      for (let i = 0; i < lines.length; i++) {
        const m = lines[i].match(declRegex);
        if (m) declarations.push({ name: m[1], lineIndex: i });
      }
      // A declaration is "unused" if its name doesn't appear on any OTHER line
      // (the declaration line itself always contains the name). This is a
      // conservative heuristic — it won't remove declarations that are
      // referenced even once.
      const unusedFromSource = declarations.filter((d) => {
        for (let i = 0; i < lines.length; i++) {
          if (i === d.lineIndex) continue;
          // Word-boundary match to avoid partial matches
          const refRegex = new RegExp(`\\b${escapeRegex(d.name)}\\b`);
          if (refRegex.test(lines[i])) return false; // referenced → not unused
        }
        return true; // never referenced → unused
      }).map(d => d.name);

      // Merge: diagnosis-reported vars + source-detected unused vars
      const allUnused = [...new Set([...unusedVars, ...unusedFromSource])];

      const fixedLines = lines.filter((line) => {
        for (const v of allUnused) {
          // Match declaration at start of line (after optional whitespace):
          //   const/let/var varName =
          const declPattern = new RegExp(`^\\s*(?:const|let|var)\\s+${escapeRegex(v)}\\s*=`);
          if (declPattern.test(line)) return false; // remove this line
        }
        return true;
      });
      const fixedContent = fixedLines.join("\n");

      artifactContent = JSON.stringify({
        base_sha: bundle.head_sha,
        files: [
          {
            path: targetPath,
            change_type: "fix",
            edits: [
              {
                line_start: 1,
                line_end: lines.length,
                new_content: fixedContent,
              },
            ],
          },
        ],
      });
    }
  }

  // ── Default stub path (comment-only, non-passing) ───────────────────────
  // Used when the diagnosis doesn't match a targeted fix path, or when no
  // source content is available. Produces a placeholder comment edit.
  if (!artifactContent) {
    artifactContent = JSON.stringify({
      base_sha: bundle.head_sha,
      files: [
        {
          path: targetPath,
          change_type: "fix",
          edits: [
            {
              line_start: 1,
              line_end: 1,
              new_content: `// Candidate fix for ${bundle.diagnosis.failure_category}: ${bundle.diagnosis.summary}`,
            },
          ],
        },
      ],
    });
  }

  // Store in durable content-addressed artifact store
  const { ref, hash } = await storeArtifact(artifactContent);

  // Parse to derive scope values from actual artifact content
  // (recordPatchProposal will re-verify these)
  // Each file entry references the same content-addressed artifact_ref —
  // the patch is stored as a single blob covering all files, so every
  // file entry points back to that durable artifact for verification.
  const parsed = JSON.parse(artifactContent);
  const derived = {
    changed_files: parsed.files.map((f) => ({
      path: f.path,
      change_type: f.change_type,
      artifact_ref: ref,
      lines_changed: f.edits.reduce((s, e) => {
        const oldLines = Math.max(0, e.line_end - e.line_start + 1);
        const newLines = e.new_content ? e.new_content.split("\n").length : 0;
        return s + Math.max(oldLines, newLines);
      }, 0),
    })),
    total_files: parsed.files.length,
    total_lines_changed: 0, // computed below
  };
  derived.total_lines_changed = derived.changed_files.reduce((s, f) => s + f.lines_changed, 0);

  return {
    artifact_ref: ref,
    artifact_hash: hash,
    artifact_content: artifactContent,
    derived,
  };
}

// ════════════════════════════════════════════════════════════════════════════
// TRUSTED PATCH GENERATION PIPELINE
// ════════════════════════════════════════════════════════════════════════════

/**
 * Generate and record a patch proposal for a proposal.
 *
 * Guarantees:
 * - Proposal must be in evidence_collected with a diagnosis
 * - Policy is checked BEFORE artifact generation (precheck)
 * - PatchInputBundle is built BEFORE generation (bounded input)
 * - Patch artifact is content-addressed, hash-verified, and durable
 * - Patch is pinned to the proposal's head_sha
 * - No GitHub API calls or repository writes
 * - input_bundle_hash is passed from the actual generation bundle
 *
 * @param {number} proposalId - repair proposal ID
 * @param {object} [options]
 * @param {string} [options.correlation_id] - correlation ID for audit trail
 * @param {string} [options.source_delivery_id] - source provenance
 * @returns {Promise<object>} updated proposal with patch_proposal
 */
export async function generatePatchForProposal(proposalId, options = {}) {
  const { correlation_id, source_delivery_id } = options;

  if (!proposalId) throw new Error("proposalId is required");

  // ── 1. Fetch proposal ────────────────────────────────────────────────────
  const proposal = await getProposal(proposalId);
  if (!proposal) {
    throw new Error(`Repair proposal not found: ${proposalId}`);
  }

  // ── 2. Status gate: only evidence_collected ──────────────────────────────
  if (proposal.status !== "evidence_collected") {
    throw new Error(
      `Patch generation requires status 'evidence_collected' (current: '${proposal.status}')`
    );
  }

  // ── 3. Diagnosis prerequisite ────────────────────────────────────────────
  const diagnosis = typeof proposal.diagnosis === "string"
    ? JSON.parse(proposal.diagnosis)
    : proposal.diagnosis;
  if (!diagnosis) {
    throw new Error("Cannot generate patch: diagnosis must exist");
  }

  const evidenceRefs = typeof proposal.evidence_refs === "string"
    ? JSON.parse(proposal.evidence_refs)
    : proposal.evidence_refs;
  if (!Array.isArray(evidenceRefs) || evidenceRefs.length === 0) {
    throw new Error("Cannot generate patch: no evidence refs");
  }

  // ── 4. POLICY PRECHECK — fail before artifact generation ─────────────────
  // Missing repo_full_name or policy resolution failure rejects here,
  // before the bundle is built and before the artifact is stored.
  if (!proposal.repo_full_name) {
    throw new Error("Cannot generate patch: proposal has no repo_full_name");
  }
  const config = await getConfigForRepo(proposal.repo_full_name);
  const healingConfig = config?.pillars?.ci_healing ?? config?.ci_healing;
  checkPatchPolicy(healingConfig, diagnosis);

  // ── 5. Build bounded PatchInputBundle BEFORE generation ──────────────────
  const canonicalBundle = buildPatchInputBundle(proposal, diagnosis, evidenceRefs);
  const inputBundleHash = contentHash(canonicalBundle);

  // Worker bundle extends canonical with full values for the generator
  const workerBundle = {
    ...canonicalBundle,
    diagnosis,
    evidence_refs: evidenceRefs,
  };

  // ── 6. Generate candidate patch from bounded input ───────────────────────
  const { artifact_ref, artifact_hash, derived } = await generateCandidatePatch(workerBundle);

  // ── 7. Build patch input for canonical recording ─────────────────────────
  const patchInput = {
    artifact_ref,
    artifact_hash,
    base_sha: proposal.head_sha,
    files: derived.changed_files,
    total_files: derived.total_files,
    total_lines_changed: derived.total_lines_changed,
    evidence_ids: diagnosis.evidence_ids || evidenceRefs.map((r) => r.source),
    diagnosis_hash: canonicalBundle.diagnosis_hash,
    input_bundle_hash: inputBundleHash,
    rationale_summary: `Candidate fix for ${diagnosis.failure_category}: ${diagnosis.summary}`,
    limitations: "Generated by deterministic stub engine — requires human review before apply.",
  };

  // ── 8. Record through canonical path ─────────────────────────────────────
  // recordPatchProposal() rechecks policy under the proposal lock and
  // verifies input_bundle_hash against the locked state.
  const result = await recordPatchProposal(
    proposalId,
    patchInput,
    {
      actor: ACTOR,
      actor_kind: ACTOR,
      expected_version: proposal.version,
      correlation_id,
      source_delivery_id,
    }
  );

  logger.info(
    { proposal_id: proposalId, correlation_id, artifact_hash },
    "Patch proposal recorded for repair proposal"
  );

  return result;
}
