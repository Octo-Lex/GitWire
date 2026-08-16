// Phase 9 A/B scoring (RI-9 amendment). Pure functions over recorded run
// outcomes — no provider, no repository access. The decision rule is the
// manifest's predeclared rule, applied mechanically; the output is DATA
// for the client's harness decision, not a decision executed by GitWire.

import { parseEvidenceRef } from "../../services/findingValidator.js";

/** Per-run convergence score. */
export function scoreConvergence(record) {
  const execution = record.execution;
  return {
    converged: execution.status === "completed" && execution.terminationReason === "submitted" && !!execution.submission,
    terminationReason: execution.terminationReason,
    durationMs: execution.durationMs,
    toolCalls: execution.toolTrace.length,
    usage: execution.usage,
  };
}

/** Per-run broken-fixture effectiveness: an on-target material finding. */
export function scoreBrokenEffectiveness(record, expected) {
  const submission = record.execution.submission;
  if (!submission) return { detected: false, onTargetFindings: [], reason: "no_submission" };
  const onTarget = [];
  for (const [index, finding] of (submission.payload.findings ?? []).entries()) {
    const material = ["P0", "P1", "P2"].includes(finding.severity);
    if (!material) continue;
    const ver = record.submissionVerification?.findings?.[index];
    const refsTargetExpected = (finding.evidenceRefs ?? []).some((ref) => {
      const parsed = parseEvidenceRef(ref);
      return parsed && expected.evidencePaths.some((p) => parsed.path === p);
    });
    const ri4 = record.ri4FindingValidation?.[index]?.valid === true;
    const evidenceComplete = ver ? ver.evidenceComplete === true : false;
    if (refsTargetExpected && ri4 && evidenceComplete) {
      onTarget.push({ index, severity: finding.severity, claim: finding.claim });
    }
  }
  return { detected: onTarget.length > 0, onTargetFindings: onTarget };
}

/** Per-run fixed-fixture precision: false material findings count against. */
export function scoreFixedPrecision(record) {
  const submission = record.execution.submission;
  if (!submission) return { precise: false, falseMaterialCount: null, reason: "no_submission" };
  let falseMaterial = 0;
  for (const [index, finding] of (submission.payload.findings ?? []).entries()) {
    const material = ["P0", "P1", "P2"].includes(finding.severity);
    if (!material) continue;
    const ri4 = record.ri4FindingValidation?.[index]?.valid === true;
    const ver = record.submissionVerification?.findings?.[index];
    const evidenceComplete = ver ? ver.evidenceComplete === true : false;
    if (!ri4 || !evidenceComplete) falseMaterial += 1;
  }
  return { precise: falseMaterial === 0, falseMaterialCount: falseMaterial };
}

/** Per-run evidence integrity across all material findings. */
export function scoreEvidenceIntegrity(record) {
  const submission = record.execution.submission;
  if (!submission) return { intact: false, reason: "no_submission" };
  let allIntact = true;
  const detail = [];
  for (const [index, finding] of (submission.payload.findings ?? []).entries()) {
    if (!["P0", "P1", "P2"].includes(finding.severity)) continue;
    const ver = record.submissionVerification?.findings?.[index];
    const ok = ver ? ver.evidenceComplete === true : false;
    detail.push({ index, evidenceComplete: ok });
    if (!ok) allIntact = false;
  }
  return { intact: allIntact, findings: detail };
}

/** Score one record end-to-end. */
export function scoreRun(record) {
  const variant = record.variant;
  const expected = record.expectedSignature;
  return {
    arm: record.arm,
    variant,
    runIndex: record.runIndex,
    convergence: scoreConvergence(record),
    ...(variant === "broken"
      ? { effectiveness: scoreBrokenEffectiveness(record, expected) }
      : { precision: scoreFixedPrecision(record) }),
    evidenceIntegrity: scoreEvidenceIntegrity(record),
  };
}

/** Aggregate a scorecard by arm. */
export function buildScorecard(scored) {
  const byArm = { "current-gitwire": {}, pi: {} };
  for (const arm of Object.keys(byArm)) {
    const armRuns = scored.filter((s) => s.arm === arm);
    const broken = armRuns.filter((s) => s.variant === "broken");
    const fixed = armRuns.filter((s) => s.variant === "fixed");
    byArm[arm] = {
      runs: armRuns.length,
      converged: armRuns.filter((s) => s.convergence.converged).length,
      brokenDetected: broken.filter((s) => s.effectiveness?.detected).length,
      brokenRuns: broken.length,
      fixedPrecise: fixed.filter((s) => s.precision?.precise).length,
      fixedRuns: fixed.length,
      evidenceIntact: armRuns.filter((s) => s.evidenceIntegrity.intact).length,
    };
  }
  return byArm;
}

/** Apply the manifest's predeclared three-way decision rule. */
export function applyDecisionRule(scorecard) {
  const current = scorecard["current-gitwire"];
  const pi = scorecard.pi;

  const currentConverges = current.converged >= 4 && current.runs === 6;
  const currentDetects = current.brokenDetected >= 1;
  const piFailsToConverge = pi.converged <= 2;

  if (currentConverges && currentDetects && piFailsToConverge) {
    return {
      outcome: "keep-current",
      rationale:
        `current converged ${current.converged}/6 with ${current.brokenDetected}/${current.brokenRuns} broken detections; Pi converged only ${pi.converged}/6`,
    };
  }

  const piBetterDetection = pi.brokenDetected > current.brokenDetected;
  const piBetterConvergence = pi.converged > current.converged;
  const notWorse =
    pi.fixedPrecise >= current.fixedPrecise &&
    pi.evidenceIntact >= current.evidenceIntact &&
    pi.converged >= 1;
  if ((piBetterDetection || piBetterConvergence) && notWorse) {
    return {
      outcome: "choose-pi",
      rationale:
        `Pi broken detections ${pi.brokenDetected}/${pi.brokenRuns} vs ${current.brokenDetected}/${current.brokenRuns}; convergence ${pi.converged}/6 vs ${current.converged}/6; fixed precision ${pi.fixedPrecise}/${pi.fixedRuns} vs ${current.fixedPrecise}/${current.fixedRuns}; evidence intact ${pi.evidenceIntact}/6 vs ${current.evidenceIntact}/6`,
    };
  }

  return {
    outcome: "no-winner",
    rationale:
      `both arms failed similarly or results are materially mixed (current: converged ${current.converged}/6, detected ${current.brokenDetected}/${current.brokenRuns}; pi: converged ${pi.converged}/6, detected ${pi.brokenDetected}/${pi.brokenRuns}) — orchestration not established as the causal bottleneck; no per-arm tuning and rerun`,
  };
}
