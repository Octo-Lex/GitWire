// src/services/reviewIntegrityShadow.js
// Shadow-mode integration for Review Integrity v2 (RI-9).
//
// Runs the v2 pipeline alongside the current production path and records
// divergence without producing any GitHub mutation. Shadow mode NEVER
// posts a review, creates a check, or modifies any GitHub state.
//
// Feature flag: review_integrity_v2 in .gitwire.yml or ai_review_config.
//   - When disabled (default): v2 pipeline does not run at all.
//   - When enabled as "shadow": v2 runs and records divergence.
//   - When enabled as "live": v2 controls the GitHub mutation (future cutover).
//
// Cutover requires (from frozen plan §20):
//   - deterministic tests pass
//   - regression corpus passes
//   - clean calibration acceptable
//   - shadow operational metrics acceptable
//   - no lifecycle/mutation regressions

import { validateFindings } from "./findingValidator.js";
import { runApprovalVerification } from "./approvalVerificationService.js";
import { computeReviewDecision } from "./reviewDecisionPolicy.js";
import { persistIntegrityReceipt, recordReviewMetrics } from "./integrityReceiptService.js";
import { buildExecutionProfile, providerFromBaseURL } from "./executionProfileService.js";

// ── Shadow mode state ────────────────────────────────────────────────────────

export const SHADOW_MODE = Object.freeze({
  DISABLED: "disabled",
  SHADOW:   "shadow",
  LIVE:     "live",   // future cutover — not implemented in this package
});

/**
 * Determine the shadow mode from configuration.
 *
 * @param {object} repoConfig - resolved repo config
 * @param {object} reviewConfig - ai_review_config DB row
 * @returns {string} SHADOW_MODE value
 */
export function resolveShadowMode(repoConfig, reviewConfig) {
  // Check .gitwire.yml for review_integrity_v2 setting
  const ymlSetting = repoConfig?.pillars?.ai_review?.review_integrity_v2
    || repoConfig?.settings?.review_integrity_v2;

  if (ymlSetting === "shadow" || ymlSetting === true) return SHADOW_MODE.SHADOW;
  if (ymlSetting === "live") return SHADOW_MODE.LIVE;

  // Check DB config
  if (reviewConfig?.review_integrity_v2 === "shadow") return SHADOW_MODE.SHADOW;
  if (reviewConfig?.review_integrity_v2 === "live") return SHADOW_MODE.LIVE;

  return SHADOW_MODE.DISABLED;
}

/**
 * Run the v2 pipeline in shadow mode.
 *
 * This executes the full v2 chain (evidence acquisition, finding validation,
 * verifier, decision policy) but does NOT post any GitHub review or mutation.
 * All results are recorded as a divergence report for comparison against the
 * production decision.
 *
 * @param {object} params
 * @param {object} params.productionResult - what the production engine returned
 * @param {object} params.productionFindings - production-validated findings
 * @param {object} params.evidence - ReviewEvidence from buildReviewEvidence
 * @param {object} params.octokit - GitHub client (for verifier context broker)
 * @param {string} params.owner
 * @param {string} params.repo
 * @param {object} params.anthropic - Anthropic SDK (for verifier)
 * @param {string} params.model
 * @param {object} params.repoConfig - resolved repo config
 * @param {object} params.reviewConfig - ai_review_config DB row
 * @param {number} params.reviewRowId - ai_reviews row ID
 * @param {string} params.invocationId
 * @param {number} params.primaryTokens
 * @param {number} params.primaryLatencyMs
 * @returns {Promise<object>} shadow divergence report
 */
export async function runShadowVerification({
  productionResult,
  productionFindings,
  evidence,
  octokit,
  owner,
  repo,
  anthropic,
  model,
  repoConfig,
  reviewConfig,
  reviewRowId,
  invocationId,
  primaryTokens = 0,
  primaryLatencyMs = 0,
}) {
  const startTime = Date.now();
  const mode = resolveShadowMode(repoConfig, reviewConfig);

  if (mode === SHADOW_MODE.DISABLED) {
    return { mode, ran: false };
  }

  // ── Convert production findings to v2 finding schema ─────────────────────
  // Production findings use {severity, title, description, file, line, confidence}
  // v2 findings use {severity, category, claim, description, evidenceRefs, proof}
  const v2FormattedFindings = (productionFindings || []).map(f => ({
    severity: severityToV2(f.severity),
    category: f.category || "bug",
    claim: f.title || f.claim || "Untitled finding",
    description: f.description || f.body || "",
    affectedPaths: f.file ? [f.file] : (f.affectedPaths || []),
    evidenceRefs: f.file ? [`changed:${f.file}@HEAD:${f.line ? "L" + f.line : "L1"}`] : (f.evidenceRefs || []),
    proof: f.proof || { type: "inference", summary: f.description || f.claim || "" },
  }));

  // ── Validate primary findings through the v2 evidence-bound validator ────
  const validated = validateFindings(v2FormattedFindings, evidence);
  const v2PrimaryFindings = validated.valid;

  // ── Run the independent verifier (only if v2 primary found zero material) ──
  let verifierReceipt = null;
  const v2HasMaterial = v2PrimaryFindings.some(f =>
    ["P0", "P1", "P2"].includes(f.severity)
  );

  if (!v2HasMaterial && evidence?.coverage?.approvalEvidenceComplete) {
    // Only run the verifier when v2 pre-policy says it could potentially approve
    try {
      verifierReceipt = await runApprovalVerification({
        evidence,
        octokit,
        owner,
        repo,
        anthropic,
        model,
        maxDurationMs: 120000,
      });
    } catch (err) {
      verifierReceipt = {
        status: "error",
        findings: [],
        error: err.message,
        approvalSafe: false,
      };
    }
  }

  // ── Compute the v2 decision ──────────────────────────────────────────────
  const v2Decision = computeReviewDecision({
    primaryFindings: v2PrimaryFindings,
    verifierReceipt,
    evidence,
  });

  // ── Compare production vs v2 ─────────────────────────────────────────────
  const productionEvent = mapProductionVerdict(productionResult?.verdict);
  const divergence = computeDivergence(productionEvent, v2Decision.event, {
    productionFindings: productionFindings || [],
    v2Findings: v2PrimaryFindings,
    verifierFindings: verifierReceipt?.findings || [],
    verifierOverturn: verifierReceipt?.hasMaterialFindings &&
      v2PrimaryFindings.filter(f => ["P0", "P1", "P2"].includes(f.severity)).length === 0,
    coverageFailures: evidence?.coverage?.limitsExceeded || [],
    evidenceComplete: evidence?.coverage?.approvalEvidenceComplete || false,
  });

  // ── Persist integrity receipt (v2 columns) ───────────────────────────────
  try {
    // Phase 10: the shadow "primary" is the production legacy engine —
    // record what is actually known (requested model; observed identity not
    // captured by the legacy loop). Descriptive metadata only.
    const shadowPrimaryProfile = buildExecutionProfile({
      provider: providerFromBaseURL(anthropic?.baseURL),
      adapter: "legacy-structured-review",
      protocol: "anthropic-messages",
      requestedRoute: anthropic?.baseURL || null,
      requestedModel: model || null,
      terminalState: "completed",
      terminalReason: null,
    });
    await persistIntegrityReceipt({
      reviewRowId,
      evidence,
      verifierReceipt,
      decision: v2Decision,
      primaryFindings: v2PrimaryFindings,
      budgetState: null, // verifier's broker state is inside verifierReceipt
      invocationId,
      primaryExecutionProfile: shadowPrimaryProfile,
      verifierExecutionProfile: verifierReceipt?.executionProfile || null,
    });
  } catch (_e) {
    // Non-fatal in shadow mode — divergence recording is the primary purpose
  }

  // ── Record metrics ───────────────────────────────────────────────────────
  try {
    await recordReviewMetrics({
      decision: v2Decision,
      evidence,
      verifierReceipt,
      primaryFindings: v2PrimaryFindings,
      primaryTokens,
      primaryLatencyMs,
      totalLatencyMs: Date.now() - startTime,
    });
  } catch (_e) {
    // Non-fatal in shadow mode
  }

  return {
    mode,
    ran: true,
    productionEvent,
    v2Event: v2Decision.event,
    v2CheckState: v2Decision.checkState,
    divergence,
    v2Findings: v2PrimaryFindings.length,
    v2Rejected: validated.rejected.length,
    v2Downgraded: validated.downgraded.length,
    verifierStatus: verifierReceipt?.status || "not_run",
    verifierMaterialCount: verifierReceipt?.materialFindingCount || 0,
    shadowDurationMs: Date.now() - startTime,
    // SHADOW MODE NEVER PRODUCES A GITHUB MUTATION
    mutationProduced: false,
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Map the production engine's verdict to the v2 REVIEW_EVENT vocabulary.
 */
function mapProductionVerdict(verdict) {
  switch (verdict) {
    case "approved": return "APPROVE";
    case "request_changes": return "REQUEST_CHANGES";
    case "needs_discussion": return "COMMENT";
    default: return "COMMENT";
  }
}

/**
 * Compute the divergence between production and v2 decisions.
 */
function computeDivergence(prodEvent, v2Event, details) {
  const diverged = prodEvent !== v2Event;
  const severity = diverged
    ? (prodEvent === "APPROVE" && v2Event !== "APPROVE" ? "critical" : "moderate")
    : "none";

  return {
    diverged,
    severity,
    productionEvent: prodEvent,
    v2Event,
    // Key divergence types
    oldApproveV2NonApprove: prodEvent === "APPROVE" && v2Event !== "APPROVE",
    oldApproveV2RequestChanges: prodEvent === "APPROVE" && v2Event === "REQUEST_CHANGES",
    findingDifferences: {
      productionCount: details.productionFindings.length,
      v2Count: details.v2Findings.length,
      verifierCount: details.verifierFindings.length,
      rejectedByV2: details.productionFindings.length - details.v2Findings.length,
    },
    verifierOverturn: details.verifierOverturn || false,
    coverageFailures: details.coverageFailures,
    evidenceComplete: details.evidenceComplete,
  };
}

/**
 * Map production severity names to the v2 P0-P3 vocabulary.
 * Production uses: critical, high, medium, low, info
 * v2 uses: P0, P1, P2, P3
 */
function severityToV2(severity) {
  switch (severity) {
    case "critical": return "P0";
    case "high": return "P1";
    case "medium": return "P2";
    case "low":
    case "info": return "P3";
    default: return severity; // already P0-P3, or unknown
  }
}
