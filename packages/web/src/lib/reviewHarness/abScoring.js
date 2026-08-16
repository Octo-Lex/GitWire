// Phase 9 A/B scoring (RI-9 amendment). Pure functions over recorded run
// outcomes — no provider, no repository access. The decision rule is the
// manifest's predeclared rule, applied mechanically; the output is DATA
// for the client's harness decision, not a decision executed by GitWire.
//
// Broken-fixture detection uses the STRICT per-fixture semantic oracle
// (exactly equivalent to tests/evaluation/review-integrity/expected-defect.js):
// a material finding counts only when its text matches the expected
// defect's signature — for RI-04: marker lookup + pagination + duplicate
// comments. Path/keyword citation alone awards no credit.

function has(text, terms) {
  return terms.some((t) => text.includes(t));
}

/** Strict per-fixture expected-defect signatures (exact equivalents of the
 *  qualified evaluation oracle; see expected-defect.js). */
const STRICT_SIGNATURES = {
  "RI-01": (t) =>
    has(t, ["synchron", "stale", "contradict", "inconsisten", "outdated", "not updated", "still says", "still declares", "still marks"]) &&
    has(t, ["status", "phase", "declaration", "reopened", "closed", "pending"]) &&
    has(t, ["readme", "constitution", "phase-0-spec", "roadmap", "docs/", "documentation", "spec"]),
  "RI-02": (t) =>
    has(t, ["gate", "exit"]) &&
    has(t, ["agent"]) &&
    has(t, ["replac", "restart", "swap", "resummon", "kill", "terminate", "preserv"]),
  "RI-03": (t) =>
    has(t, ["basepath", "base path", "/dashboard/intelligence", "dashboard basepath"]) ||
    (has(t, ["url", "link"]) && has(t, ["basepath", "base path", "/dashboard"])),
  "RI-04": (t) =>
    has(t, ["findcommentbymarker", "marker lookup", "comment marker", "findcomment", "commentmarkers"]) &&
    has(t, ["paginat", "per_page", "first page", "page 1", "single page", "one page", "only one page", "100 comments", "next page"]) &&
    has(t, ["duplicate", "duplicat"]),
};

/** Does this finding match the fixture's strict expected defect? EXACTLY
 *  equivalent to the canonical oracle: v2 material-finding text is the
 *  CLAIM ONLY — description is never consulted, so signature keywords
 *  present only in a description cannot score. */
export function strictExpectedDefect(caseId, finding) {
  const signature = STRICT_SIGNATURES[caseId];
  if (!signature) return false;
  return signature((finding.claim || "").toLowerCase());
}

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

/** Per-run broken-fixture effectiveness: strict-oracle on-target material
 *  finding that ALSO survives RI-4 validation and evidence verification. */
export function scoreBrokenEffectiveness(record, expected) {
  const submission = record.execution.submission;
  if (!submission) return { detected: false, onTargetFindings: [], reason: "no_submission" };
  const onTarget = [];
  for (const [index, finding] of (submission.payload.findings ?? []).entries()) {
    const material = ["P0", "P1", "P2"].includes(finding.severity);
    if (!material) continue;
    const signature = strictExpectedDefect(expected.caseId, finding);
    if (!signature) continue;
    const ri4 = record.ri4FindingValidation?.[index]?.valid === true;
    const ver = record.submissionVerification?.findings?.[index];
    const evidenceComplete = ver ? ver.evidenceComplete === true : false;
    if (ri4 && evidenceComplete) {
      onTarget.push({ index, severity: finding.severity, claim: finding.claim });
    }
  }
  return { detected: onTarget.length > 0, onTargetFindings: onTarget };
}

/** Per-run fixed-fixture precision: a material claim on the frozen clean
 *  fixture counts AGAINST precision unless a separately frozen adjudication
 *  establishes it as a true material defect. RI-4 validity establishes
 *  evidence validity, not claim truth. */
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
    const adjudicatedTrue = record.adjudication?.trueMaterialByIndex?.[index] === true;
    if (adjudicatedTrue) continue; // separately adjudicated as a true defect
    if (!ri4 || !evidenceComplete) {
      falseMaterial += 1; // unsupported material claim
    } else {
      falseMaterial += 1; // supported but unadjudicated claim on the CLEAN fixture
    }
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

/** Apply the manifest's predeclared three-way decision rule.
 *
 *  "Materially better" means strict-oracle detection superiority, or a
 *  convergence margin GREATER than one run — a single stochastic run does
 *  not demonstrate material superiority. evidenceIntact is vacuously true
 *  on submissions with no material findings, so it can gate (not-worse)
 *  but cannot independently rescue a result. */
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
        `current converged ${current.converged}/6 with ${current.brokenDetected}/${current.brokenRuns} strict-oracle broken detections; Pi converged only ${pi.converged}/6`,
    };
  }

  const piMateriallyBetter =
    pi.brokenDetected > current.brokenDetected ||
    pi.converged - current.converged > 1;
  const notWorse =
    pi.fixedPrecise >= current.fixedPrecise &&
    pi.evidenceIntact >= current.evidenceIntact &&
    pi.converged >= 1;
  if (piMateriallyBetter && notWorse) {
    return {
      outcome: "choose-pi",
      rationale:
        `Pi materially better: strict-oracle detections ${pi.brokenDetected}/${pi.brokenRuns} vs ${current.brokenDetected}/${current.brokenRuns}, convergence margin ${pi.converged - current.converged} runs (${pi.converged}/6 vs ${current.converged}/6); fixed precision ${pi.fixedPrecise}/${pi.fixedRuns} vs ${current.fixedPrecise}/${current.fixedRuns}; evidence intact ${pi.evidenceIntact}/6 vs ${current.evidenceIntact}/6`,
    };
  }

  if (piMateriallyBetter && !notWorse) {
    return {
      outcome: "no-winner",
      rationale:
        `Pi showed a material advantage (strict-oracle detections ${pi.brokenDetected}/${pi.brokenRuns} vs ${current.brokenDetected}/${current.brokenRuns}, convergence ${pi.converged}/6 vs ${current.converged}/6) but was worse on fixed precision (${pi.fixedPrecise}/${pi.fixedRuns} vs ${current.fixedPrecise}/${current.fixedRuns}) or evidence integrity (${pi.evidenceIntact}/6 vs ${current.evidenceIntact}/6) — no winner`,
    };
  }

  const margin = Math.abs(pi.converged - current.converged);
  const detectionTied = pi.brokenDetected === current.brokenDetected;
  return {
    outcome: "no-winner",
    rationale:
      `both arms failed similarly or results are materially mixed (current: converged ${current.converged}/6, strict-oracle detections ${current.brokenDetected}/${current.brokenRuns}; pi: converged ${pi.converged}/6, detections ${pi.brokenDetected}/${pi.brokenRuns}` +
      (detectionTied && margin <= 1 ? `; convergence margin of ${margin} run(s) is not material` : "") +
      `) — orchestration not established as the causal bottleneck; no per-arm tuning and rerun`,
  };
}
