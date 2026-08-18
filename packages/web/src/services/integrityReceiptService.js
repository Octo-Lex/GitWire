// src/services/integrityReceiptService.js
// Persistence and observability for Review Integrity v2 (RI-8).
//
// Persists the receipt — not a giant copy of Git. Every decision can be
// reconstructed from the evidence manifest (commit-bound SHAs and coverage
// states), the verification receipt (verifier findings and status), the
// decision reason (deterministic policy output), and the invocation identity.
//
// Observability metrics are recorded as structured events for aggregation.

import { db } from "../lib/db.js";
import { executionProfileForReceipt } from "./executionProfileService.js";

// ── Persistence ──────────────────────────────────────────────────────────────

/**
 * Persist a review integrity receipt to the ai_reviews table.
 *
 * Stores the evidence manifest, verification receipt, approval eligibility,
 * decision reason, and review invocation identity. Does NOT store full
 * repository contents — the evidence manifest carries SHAs and coverage
 * states so actual source is reconstructible through immutable Git.
 *
 * Phase 10: additive primary/verifier execution profiles (descriptive,
 * nullable, model-neutral telemetry) are embedded in the manifest. Missing
 * profiles (null) keep the receipt valid — optional telemetry never makes
 * a review incomplete.
 *
 * @param {object} params
 * @param {number} params.reviewRowId - the existing ai_reviews row id
 * @param {object} params.evidence - ReviewEvidence (trimmed to manifest)
 * @param {object} params.verifierReceipt - from runApprovalVerification
 * @param {object} params.decision - from computeReviewDecision
 * @param {object[]} params.primaryFindings - validated primary findings
 * @param {object} params.budgetState - context broker budget state
 * @param {string} params.invocationId - from computeInvocationId
 * @param {number} params.integrityVersion - schema version (default 1)
 * @param {object|null} params.primaryExecutionProfile - from primary receipt (Phase 10)
 * @param {object|null} params.verifierExecutionProfile - from verifier receipt (Phase 10)
 * @param {object|null} params.adversarialExecutionProfile - from adversarial challenge (additive telemetry)
 * @param {object|null} params.defenseExecutionProfile - from defense pass (additive telemetry)
 */
export async function persistIntegrityReceipt({
  reviewRowId,
  evidence,
  verifierReceipt,
  decision,
  primaryFindings,
  budgetState,
  invocationId,
  integrityVersion = 1,
  primaryExecutionProfile = null,
  verifierExecutionProfile = null,
  adversarialExecutionProfile = null,
  defenseExecutionProfile = null,
}) {
  // Build the evidence manifest — the receipt, not full contents
  const manifest = buildEvidenceManifest(evidence, primaryFindings, budgetState);

  // Phase 10 execution profiles — additive, nullable, sanitized to the
  // persisted shape. Never consulted by review authority (RI-6).
  if (manifest) {
    manifest.executionProfiles = {
      primary: executionProfileForReceipt(primaryExecutionProfile),
      verifier: executionProfileForReceipt(verifierExecutionProfile),
      adversarial: executionProfileForReceipt(adversarialExecutionProfile),
      defense: executionProfileForReceipt(defenseExecutionProfile),
    };
  }

  // Build the verification receipt (trimmed — no full review body)
  const verifierReceiptRecord = verifierReceipt ? {
    status: verifierReceipt.status,
    findings: (verifierReceipt.findings || []).map(f => ({
      severity: f.severity,
      category: f.category,
      claim: f.claim,
      evidenceRefs: f.evidenceRefs || [],
      proofType: f.proof?.type || null,
    })),
    rawFindings: (verifierReceipt.rawFindings || []).map(f => ({
      severity: f.severity, claim: (f.claim || "").slice(0, 120),
    })),
    hasMaterialFindings: verifierReceipt.hasMaterialFindings || false,
    materialFindingCount: verifierReceipt.materialFindingCount || 0,
    coverageSatisfied: verifierReceipt.coverageSatisfied,
    tokensUsed: verifierReceipt.tokensUsed || 0,
    durationMs: verifierReceipt.durationMs || 0,
    unresolvedContextRequests: verifierReceipt.unresolvedContextRequests || [],
    contextTrace: (verifierReceipt.contextTrace || []).map(t => ({
      type: t.type, result: t.result, path: t.path || null,
      ref: t.ref || t.resolvedSha || null, round: t.round || null,
      truncated: t.truncated || false, reason: t.reason || undefined,
    })),
    actualModel: verifierReceipt.actualModel || null,
    budgetState: verifierReceipt.budgetState || null,
    riskLedger: verifierReceipt.riskLedger || null,
    unresolvedObligations: verifierReceipt.unresolvedObligations || [],
    error: verifierReceipt.error || undefined,
    rawTextSnippet: verifierReceipt.rawTextSnippet || undefined,
  } : null;

  await db.query(
    `UPDATE ai_reviews SET
      evidence_manifest    = $1,
      verification_receipt = $2,
      approval_eligible    = $3,
      decision_reason      = $4,
      review_invocation_id = $5,
      integrity_version    = $6
    WHERE id = $7`,
    [
      JSON.stringify(manifest),
      verifierReceiptRecord ? JSON.stringify(verifierReceiptRecord) : null,
      decision?.approvalEligible || false,
      decision?.decisionReason || null,
      invocationId || null,
      integrityVersion,
      reviewRowId,
    ]
  );
}

/**
 * Build the evidence manifest from a ReviewEvidence object.
 *
 * The manifest stores file accounting, coverage states, Git/blob SHAs,
 * content digests, trimmed retrieval/context metadata with immutable
 * identities (no contents/fragments), primary validated finding evidence
 * refs, and budget consumption. Enough to reconstruct why a decision was
 * made without storing full source.
 */
function buildEvidenceManifest(evidence, primaryFindings, budgetState) {
  if (!evidence) return null;

  return {
    version: evidence.version || 1,
    review: evidence.review || null,
    coverage: evidence.coverage || null,
    changedFiles: (evidence.changedFiles || []).map(cf => ({
      path: cf.path,
      previousPath: cf.previousPath || null,
      status: cf.status,
      coverage: cf.coverage,
      coverageReason: cf.coverageReason || null,
      additions: cf.additions || 0,
      deletions: cf.deletions || 0,
      representedLines: cf.representedLines || 0,
      head: cf.head ? { sha: cf.head.sha, blobSha: cf.head.blobSha, contentDigest: cf.head.contentDigest } : null,
      base: cf.base ? { sha: cf.base.sha, blobSha: cf.base.blobSha, contentDigest: cf.base.contentDigest } : null,
      policyExemption: cf.policyExemption || null,
    })),
    // Trimmed context items: immutable identity only, no content/fragments
    contextItems: (evidence.contextItems || []).map(ci => ({
      id: ci.id || null,
      type: ci.type || null,
      path: ci.path || null,
      ref: ci.ref || ci.resolvedSha || null,
      resolvedSha: ci.resolvedSha || null,
      blobSha: ci.blobSha || null,
      contentDigest: ci.contentDigest || null,
      range: ci.range || null,
      truncated: ci.truncated || false,
      retrievalReason: ci.retrievalReason || null,
    })),
    // Trimmed retrieval trace: audit entries, no content
    retrievalTrace: (evidence.retrievalTrace || []).map(t => ({
      type: t.type,
      result: t.result,
      path: t.path || null,
      ref: t.ref || t.resolvedSha || null,
      round: t.round || null,
      truncated: t.truncated || false,
      reason: t.reason || undefined,
      contentLength: t.contentLength || undefined,
    })),
    // Primary validated findings: evidence refs and proof types (no full descriptions)
    primaryFindings: (primaryFindings || []).map(f => ({
      severity: f.severity,
      category: f.category,
      claim: f.claim,
      evidenceRefs: f.evidenceRefs || [],
      proofType: f.proof?.type || null,
      affectedPaths: f.affectedPaths || [],
    })),
    // Context broker budget consumption
    budgetConsumption: budgetState ? {
      fileReads: budgetState.fileReads || 0,
      searches: budgetState.searches || 0,
      retrievedChars: budgetState.retrievedChars || 0,
      contextRounds: budgetState.contextRounds || 0,
      exhausted: budgetState.exhausted || false,
      limits: budgetState.limits || null,
    } : null,
  };
}

// ── Observability ────────────────────────────────────────────────────────────

/**
 * Record observability metrics for a completed review.
 *
 * Metrics are stored as a structured log entry for aggregation by
 * downstream tooling (Prometheus, Grafana, etc.). No dashboard redesign
 * is required for this objective.
 *
 * @param {object} params
 * @param {object} params.decision - from computeReviewDecision
 * @param {object} params.evidence - ReviewEvidence
 * @param {object|null} params.verifierReceipt - verification receipt
 * @param {object} params.primaryFindings - validated findings from primary
 * @param {number} params.primaryTokens - tokens used by primary reviewer
 * @param {number} params.primaryLatencyMs - primary reviewer latency
 * @param {number} params.totalLatencyMs - total review latency
 * @param {object|null} params.budgetState - context broker budget state
 */
export async function recordReviewMetrics({
  decision,
  evidence,
  verifierReceipt,
  primaryFindings,
  primaryTokens = 0,
  primaryLatencyMs = 0,
  totalLatencyMs = 0,
  budgetState = null,
  mutationRetries = 0,
  duplicatePreventionEvents = 0,
}) {
  const metrics = {
    timestamp: new Date().toISOString(),

    // Decision outcome
    event: decision?.event || "UNKNOWN",
    checkState: decision?.checkState || "unknown",
    approvalEligible: decision?.approvalEligible || false,

    // Coverage
    coverageComplete: evidence?.coverage?.approvalEvidenceComplete || false,
    totalChangedFiles: evidence?.coverage?.totalChangedFiles || 0,
    fullyCoveredFiles: evidence?.coverage?.fullyCoveredFiles || 0,
    policyExemptFiles: evidence?.coverage?.policyExemptFiles || 0,
    partialFiles: evidence?.coverage?.partialFiles || 0,
    unavailableFiles: evidence?.coverage?.unavailableFiles || 0,
    coverageFailureReasons: evidence?.coverage?.limitsExceeded || [],

    // Primary findings
    primaryFindingCount: (primaryFindings || []).length,
    primaryMaterialCount: (primaryFindings || []).filter(f =>
      ["P0", "P1", "P2"].includes(f.severity)
    ).length,

    // Verifier
    verifierStatus: verifierReceipt?.status || "not_run",
    verifierFindingCount: verifierReceipt?.findings?.length || 0,
    verifierMaterialCount: verifierReceipt?.materialFindingCount || 0,
    verifierIncomplete: verifierReceipt?.status === "incomplete",
    verifierTokens: verifierReceipt?.tokensUsed || 0,
    verifierLatencyMs: verifierReceipt?.durationMs || 0,
    verifierUnresolvedContext: (verifierReceipt?.unresolvedContextRequests || []).length,

    // Tokens and latency (totalTokens computed later to include context retrieval)
    primaryTokens,
    verifierTokens: verifierReceipt?.tokensUsed || 0,
    contextRetrievedChars: budgetState?.retrievedChars || 0,
    primaryLatencyMs,
    totalLatencyMs,

    // Context broker
    contextReads: budgetState?.fileReads || 0,
    contextSearches: budgetState?.searches || 0,
    contextRounds: budgetState?.contextRounds || 0,
    contextExhausted: budgetState?.exhausted || false,

    // Mutation safety
    mutationRetries,
    duplicatePreventionEvents,

    // Verifier overturn (verifier finds material when primary found none)
    verifierOverturn: verifierReceipt?.hasMaterialFindings && (primaryFindings || []).filter(f =>
      ["P0", "P1", "P2"].includes(f.severity)
    ).length === 0,

    // Context-retrieval token estimate (approx 4 chars per token)
    contextRetrievalTokens: Math.round((budgetState?.retrievedChars || 0) / 4),
  };

  // totalTokens includes primary + verifier + context retrieval
  metrics.totalTokens = metrics.primaryTokens + metrics.verifierTokens + metrics.contextRetrievalTokens;

  // Record to the review_metrics_log table (created in migration 043)
  try {
    await db.query(
      `INSERT INTO review_metrics_log
       (recorded_at, event, check_state, approval_eligible,
        coverage_complete, total_changed_files, fully_covered,
        partial, unavailable, coverage_limits,
        primary_finding_count, primary_material_count,
        verifier_status, verifier_finding_count, verifier_material_count,
        verifier_incomplete, verifier_tokens, verifier_latency_ms,
        verifier_unresolved_context,
        primary_tokens, total_tokens,
        primary_latency_ms, total_latency_ms,
        context_reads, context_searches, context_rounds, context_exhausted,
        context_retrieved_chars,
        mutation_retries, duplicate_prevention_events,
        verifier_overturn, context_retrieval_tokens)
       VALUES (NOW(), $1, $2, $3, $4, $5, $6, $7, $8, $9,
               $10, $11, $12, $13, $14, $15, $16, $17, $18,
               $19, $20, $21, $22, $23, $24, $25, $26, $27,
               $28, $29, $30, $31)`,
      [
        metrics.event, metrics.checkState, metrics.approvalEligible,
        metrics.coverageComplete, metrics.totalChangedFiles, metrics.fullyCoveredFiles,
        metrics.partialFiles, metrics.unavailableFiles, JSON.stringify(metrics.coverageFailureReasons),
        metrics.primaryFindingCount, metrics.primaryMaterialCount,
        metrics.verifierStatus, metrics.verifierFindingCount, metrics.verifierMaterialCount,
        metrics.verifierIncomplete, metrics.verifierTokens, metrics.verifierLatencyMs,
        metrics.verifierUnresolvedContext,
        metrics.primaryTokens, metrics.totalTokens,
        metrics.primaryLatencyMs, metrics.totalLatencyMs,
        metrics.contextReads, metrics.contextSearches, metrics.contextRounds,
        metrics.contextExhausted, metrics.contextRetrievedChars,
        metrics.mutationRetries, metrics.duplicatePreventionEvents,
        metrics.verifierOverturn, metrics.contextRetrievalTokens,
      ]
    );
  } catch (_e) {
    // If the metrics table is unavailable, emit as structured JSON to stdout
    // as a fallback log sink for downstream aggregation.
    console.warn("review-metrics-log: table not available, emitting to stdout");
    console.log(JSON.stringify({ type: "review_metrics", ...metrics }));
  }

  return metrics;
}
