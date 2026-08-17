// src/services/reviewQualityScorecard.js
// Model-neutral service-quality read model (RI-9 Phase 10 slice D).
//
// This is a MEASUREMENT surface, not a policy surface. It aggregates the
// existing evaluation corpus (frozen Phase 8/9 run records on disk) and
// the runtime RI-8 receipts (ai_reviews v2 rows, which since Phase 10
// carry execution profiles) into independent dimensions:
//
//   safety      — broken-fixture false APPROVE, expected-defect recall
//   precision   — fixed-fixture false material findings, clean approval rate
//   reliability — terminal states of primary/verifier invocations
//   evidence    — RI-4-valid material findings, coverage completeness, rejects
//   verifier    — verified / material_findings / incomplete / error
//   efficiency  — latency, tokens, repository reads/searches
//
// There is NO weighted overall quality number. Segmentation is by
// execution-profile identity (fingerprint, provider, adapter/protocol,
// requested/observed model, identity source). Unknown values are reported
// as unknown (null) — the dashboard renders "Not exposed by provider".
//
// PRESENTATION STATES ("Healthy", "Evaluating current configuration",
// "Degraded", "Insufficient evaluation data") are dashboard display
// states ONLY. They are derived here by explicit deterministic rules and
// must never be passed into RI-6 or any review-authority path.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// ── Presentation states (dashboard display only) ─────────────────────────────

export const QUALITY_PRESENTATION_STATE = Object.freeze({
  HEALTHY:      "Healthy",
  EVALUATING:   "Evaluating current configuration",
  DEGRADED:     "Degraded",
  INSUFFICIENT: "Insufficient evaluation data",
});

// Below this many broken+fixed evaluation runs, the state stays
// "Evaluating current configuration" — not enough evidence to claim health.
const EVALUATION_SAMPLE_FLOOR = 5;

// ── Runtime receipt rows → observations ──────────────────────────────────────

/**
 * Normalize one ai_reviews v2 row into a scorecard observation.
 * Tolerant of missing pieces: optional telemetry never invalidates a row.
 */
export function mapReceiptRow(row) {
  const manifest = row.evidence_manifest && typeof row.evidence_manifest === "object"
    ? row.evidence_manifest
    : safeJson(row.evidence_manifest);
  const verification = row.verification_receipt && typeof row.verification_receipt === "object"
    ? row.verification_receipt
    : safeJson(row.verification_receipt);

  const profiles = manifest?.executionProfiles || {};
  const primary = profiles.primary || null;
  const verifier = profiles.verifier || null;
  const coverage = manifest?.coverage || null;
  const primaryFindings = manifest?.primaryFindings || [];
  const budgetConsumption = manifest?.budgetConsumption || null;

  const rawFindingCount = verification?.rawFindings?.length ?? null;
  const validFindingCount = verification?.findings?.length ?? primaryFindings.length;

  return {
    id: row.id,
    verdict: row.verdict || null,
    approvalEligible: Boolean(row.approval_eligible),
    startedAt: row.started_at || null,
    durationMs: typeof row.duration_ms === "number" ? row.duration_ms : null,
    tokensUsed: typeof row.tokens_used === "number" ? row.tokens_used : null,

    primaryProfile: primary,
    verifierProfile: verifier,

    coverageComplete: coverage?.approvalEvidenceComplete === true,
    primaryMaterialCount: countMaterial(primaryFindings),
    primaryFindingCount: primaryFindings.length,
    // RI-4 rejects: raw model submissions that failed evidence validation
    // are only visible on the primary via raw vs validated counts when the
    // manifest carries both; verifier rejects are visible directly.
    evidenceValidationRejects: rawFindingCount !== null
      ? Math.max(0, rawFindingCount - validFindingCount)
      : null,

    verifierStatus: verification?.status || (verifier ? "not_run" : null),

    repositoryReads: budgetConsumption?.fileReads ?? null,
    repositorySearches: budgetConsumption?.searches ?? null,
  };
}

function safeJson(value) {
  if (typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch (_e) {
    return null;
  }
}

function countMaterial(findings) {
  return (findings || []).filter(f => ["P0", "P1", "P2"].includes(f.severity)).length;
}

// ── Runtime dimension aggregation ────────────────────────────────────────────

/**
 * Aggregate runtime observations into the reliability / precision /
 * evidence / verifier / efficiency dimensions. Pure; null-safe.
 */
export function summarizeRuntime(observations) {
  const rows = observations || [];
  const total = rows.length;

  // Clean approvals are measured from approval_eligible — the RI-6 policy
  // output recorded in the receipt. The `verdict` column holds the DELIVERED
  // event, which on shadow rows is the legacy engine's verdict, not the v2
  // decision; mixing them would corrupt the v2 precision dimension.
  const approvals = rows.filter(o => o.approvalEligible).length;

  const reliability = countBy(rows, o => terminalStatesOf(o));
  const verifier = countBy(rows, o => o.verifierStatus ? [o.verifierStatus] : []);

  const latencies = rows.map(o => o.durationMs).filter(v => typeof v === "number");
  const primaryLatencies = rows.map(o => o.primaryProfile?.durationMs).filter(v => typeof v === "number");
  const verifierLatencies = rows.map(o => o.verifierProfile?.durationMs).filter(v => typeof v === "number");
  const tokens = rows.map(o => o.tokensUsed).filter(v => typeof v === "number");
  const primaryUsageTotals = rows.map(o => o.primaryProfile?.usage?.totalTokens).filter(v => typeof v === "number");
  const verifierUsageTotals = rows.map(o => o.verifierProfile?.usage?.totalTokens).filter(v => typeof v === "number");

  return {
    runCount: total,
    precision: {
      cleanApprovalCount: approvals,
      cleanApprovalRate: total > 0 ? approvals / total : null,
    },
    reliability: reliability,
    evidence: {
      approvalEvidenceCompleteCount: rows.filter(o => o.coverageComplete).length,
      approvalEvidenceCompleteRate: total > 0 ? rows.filter(o => o.coverageComplete).length / total : null,
      ri4ValidMaterialFindingCount: rows.reduce((s, o) => s + (o.primaryMaterialCount || 0), 0),
      evidenceValidationRejects: sumNullable(rows.map(o => o.evidenceValidationRejects)),
    },
    verifier: verifier,
    efficiency: {
      latencyMs: distribution(latencies),
      primaryLatencyMs: distribution(primaryLatencies),
      verifierLatencyMs: distribution(verifierLatencies),
      tokensUsed: distribution(tokens),
      primaryTokens: distribution(primaryUsageTotals),
      verifierTokens: distribution(verifierUsageTotals),
      repositoryReads: sumNullable(rows.map(o => o.repositoryReads)),
      repositorySearches: sumNullable(rows.map(o => o.repositorySearches)),
    },
  };
}

function terminalStatesOf(observation) {
  const states = [];
  if (observation.primaryProfile?.terminalState) states.push("primary:" + observation.primaryProfile.terminalState);
  if (observation.verifierProfile?.terminalState) states.push("verifier:" + observation.verifierProfile.terminalState);
  return states;
}

function countBy(rows, keyFn) {
  const counts = {};
  for (const row of rows) {
    for (const key of keyFn(row)) {
      counts[key] = (counts[key] || 0) + 1;
    }
  }
  return counts;
}

function distribution(values) {
  if (!values || values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((s, v) => s + v, 0);
  return {
    count: sorted.length,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    mean: sum / sorted.length,
    median: sorted[Math.floor(sorted.length / 2)],
  };
}

function sumNullable(values) {
  const known = (values || []).filter(v => typeof v === "number");
  return known.length > 0 ? known.reduce((s, v) => s + v, 0) : null;
}

// ── Segmentation ────────────────────────────────────────────────────────────

export const SEGMENT_KEYS = Object.freeze([
  "configurationFingerprint",
  "provider",
  "adapter",
  "protocol",
  "requestedModel",
  "observedModel",
  "identitySource",
]);

/**
 * Segment runtime observations by one execution-profile key of the PRIMARY
 * profile (verifier segmentation is the same mechanism on the verifier
 * profile via profileOf). Unknown/missing values segment under null.
 */
export function segmentObservations(observations, key, profileOf = (o) => o.primaryProfile) {
  const groups = new Map();
  for (const o of observations || []) {
    const value = profileOf(o)?.[key] ?? null;
    if (!groups.has(value)) groups.set(value, []);
    groups.get(value).push(o);
  }
  return groups;
}

/**
 * Build segmentation summary across every allowed key. Deterministic:
 * segments are emitted in SEGMENT_KEYS order, values sorted with null last.
 */
export function buildSegmentation(observations) {
  const segmentation = {};
  for (const key of SEGMENT_KEYS) {
    const groups = segmentObservations(observations, key);
    const segments = [...groups.entries()]
      .sort((a, b) => {
        if (a[0] === null) return 1;
        if (b[0] === null) return -1;
        return String(a[0]).localeCompare(String(b[0]));
      })
      .map(([value, rows]) => ({
        value,
        runCount: rows.length,
        summary: summarizeRuntime(rows),
        presentationState: null, // runtime-only rows carry no corpus verdicts
      }));
    segmentation[key] = segments;
  }
  return segmentation;
}

// ── Evaluation corpus dimensions ─────────────────────────────────────────────

/**
 * Aggregate frozen evaluation scorecards (Phase 8/9 records) into the
 * safety and precision dimensions per arm. Uses the existing canonical
 * scorecard fields — no replacement scoring definition is introduced.
 *
 * scorecard file shape (kind: "phase9-ab-scorecard"):
 *   scorecard: { <arm>: { runs, converged, brokenDetected, brokenRuns,
 *                         fixedPrecise, fixedRuns, evidenceIntact } }
 */
export function summarizeEvaluation(evaluationScorecards) {
  const arms = [];
  let totalRuns = 0, totalBrokenRuns = 0, totalBrokenDetected = 0,
      totalFixedRuns = 0, totalFixedPrecise = 0;

  for (const sc of evaluationScorecards || []) {
    const perArm = sc?.scorecard || {};
    for (const [arm, stats] of Object.entries(perArm)) {
      const brokenRuns = stats.brokenRuns ?? 0;
      const brokenDetected = stats.brokenDetected ?? 0;
      const fixedRuns = stats.fixedRuns ?? 0;
      const fixedPrecise = stats.fixedPrecise ?? 0;

      totalRuns += stats.runs ?? 0;
      totalBrokenRuns += brokenRuns;
      totalBrokenDetected += brokenDetected;
      totalFixedRuns += fixedRuns;
      totalFixedPrecise += fixedPrecise;

      arms.push({
        arm,
        runs: stats.runs ?? 0,
        safety: {
          brokenFalseApproveCount: brokenRuns - brokenDetected,
          brokenFalseApproveRate: brokenRuns > 0 ? (brokenRuns - brokenDetected) / brokenRuns : null,
          expectedMaterialDefectRecall: brokenRuns > 0 ? brokenDetected / brokenRuns : null,
        },
        precision: {
          fixedFalseMaterialCount: fixedRuns - fixedPrecise,
          fixedFalseMaterialRate: fixedRuns > 0 ? (fixedRuns - fixedPrecise) / fixedRuns : null,
        },
      });
    }
  }

  return {
    arms,
    overall: {
      runs: totalRuns,
      safety: {
        brokenRuns: totalBrokenRuns,
        brokenDetected: totalBrokenDetected,
        brokenFalseApproveCount: totalBrokenRuns - totalBrokenDetected,
        brokenFalseApproveRate: totalBrokenRuns > 0 ? (totalBrokenRuns - totalBrokenDetected) / totalBrokenRuns : null,
        expectedMaterialDefectRecall: totalBrokenRuns > 0 ? totalBrokenDetected / totalBrokenRuns : null,
      },
      precision: {
        fixedRuns: totalFixedRuns,
        fixedFalseMaterialCount: totalFixedRuns - totalFixedPrecise,
        fixedFalseMaterialRate: totalFixedRuns > 0 ? (totalFixedRuns - totalFixedPrecise) / totalFixedRuns : null,
      },
    },
  };
}

/**
 * Deterministic presentation-state rule (dashboard display only):
 *   no evaluation runs                    → Insufficient evaluation data
 *   fewer than EVALUATION_SAMPLE_FLOOR    → Evaluating current configuration
 *   any broken-fixture false APPROVE      → Degraded
 *   otherwise                             → Healthy
 */
export function derivePresentationState({ evaluationRuns = 0, brokenFalseApproveCount = 0 } = {}) {
  if (evaluationRuns <= 0) return QUALITY_PRESENTATION_STATE.INSUFFICIENT;
  if (brokenFalseApproveCount > 0) return QUALITY_PRESENTATION_STATE.DEGRADED;
  if (evaluationRuns < EVALUATION_SAMPLE_FLOOR) return QUALITY_PRESENTATION_STATE.EVALUATING;
  return QUALITY_PRESENTATION_STATE.HEALTHY;
}

// ── Full scorecard ───────────────────────────────────────────────────────────

/**
 * Build the model-neutral quality scorecard from runtime receipt rows and
 * frozen evaluation records. Pure — all IO happens in the loader/route.
 */
export function buildQualityScorecard({ receiptRows = [], evaluationScorecards = [], evaluationRuns = [], window = null } = {}) {
  const observations = (receiptRows || []).map(mapReceiptRow);
  const runtime = summarizeRuntime(observations);
  const evaluation = summarizeEvaluation(evaluationScorecards);

  // Segment evaluation runs by their recorded execution identity so corpus
  // measurements can be compared across configurations without merging them.
  const evaluationByModel = {};
  const modelGroups = new Map();
  for (const run of evaluationRuns || []) {
    const exec = run?.execution || {};
    const key = exec.requestedModel || null;
    if (!modelGroups.has(key)) modelGroups.set(key, []);
    modelGroups.get(key).push(run);
  }
  for (const [model, runs] of modelGroups) {
    evaluationByModel[String(model)] = {
      runCount: runs.length,
      actualModels: [...new Set(runs.map(r => r.execution?.actualModel ?? null))],
    };
  }

  const presentationState = derivePresentationState({
    evaluationRuns: evaluation.overall.runs,
    brokenFalseApproveCount: evaluation.overall.safety.brokenFalseApproveCount,
  });

  return {
    kind: "review-quality-scorecard",
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    policy: {
      // Frozen boundary, restated on every response so consumers cannot
      // mistake this for a policy surface.
      measurementOnly: true,
      feedsReviewAuthority: false,
      overallQualityNumber: false,
    },
    presentationState,
    dimensions: {
      safety: evaluation.overall.safety,
      precision: {
        ...evaluation.overall.precision,
        runtimeCleanApprovalRate: runtime.precision.cleanApprovalRate,
      },
      reliability: runtime.reliability,
      evidence: runtime.evidence,
      verifier: runtime.verifier,
      efficiency: runtime.efficiency,
    },
    evaluation: {
      arms: evaluation.arms,
      byModel: evaluationByModel,
      presentationStatesByArm: Object.fromEntries(
        evaluation.arms.map(a => [a.arm, derivePresentationState({
          evaluationRuns: a.runs,
          brokenFalseApproveCount: a.safety.brokenFalseApproveCount,
        })]),
      ),
    },
    segmentation: buildSegmentation(observations),
    runtimeRunCount: runtime.runCount,
    // Explicit read window: when the caller caps the receipt query, the cap
    // and any truncation are part of the measurement, never silent.
    window: window || null,
  };
}

// ── Evaluation corpus loader ─────────────────────────────────────────────────

/**
 * Load frozen evaluation records from the evaluation runs directory
 * (tests/evaluation/review-integrity/runs). Returns
 * { scorecards, runs } — each [] when the directory is absent (e.g. a
 * production image without the test tree). Never throws.
 */
export async function loadEvaluationRecords(runsDir) {
  const dir = runsDir || defaultRunsDir();
  const scorecards = [];
  const runs = [];
  try {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (!statSync(full).isDirectory()) continue;
      for (const file of readdirSync(full)) {
        if (!file.endsWith(".json")) continue;
        let record = null;
        try {
          record = JSON.parse(readFileSync(join(full, file), "utf8"));
        } catch (_e) {
          continue;
        }
        if (record?.kind === "phase9-ab-scorecard") scorecards.push(record);
        else if (record?.kind === "phase9-ab-run") runs.push(record);
      }
    }
  } catch (err) {
    // Directory absent or unreadable — no evaluation records. Logged, never
    // silent: an operational packaging failure must be distinguishable from
    // a genuinely empty corpus.
    // Same fallback-logging pattern as recordReviewMetrics: structured
    // stdout, no runtime-initialized logger dependency.
    console.warn(
      "review-quality: evaluation corpus unavailable — scorecard degrades to runtime-only"
        + " (dir: " + dir + ", err: " + err.message + ")"
    );
  }
  return { scorecards, runs };
}

function defaultRunsDir() {
  const here = dirname(fileURLToPath(import.meta.url));
  // src/services → packages/web/tests/evaluation/review-integrity/runs
  return join(here, "..", "..", "tests", "evaluation", "review-integrity", "runs");
}
