// tests/unit/review-quality-scorecard.test.js
// RI-9 Phase 10 (slice D): model-neutral service-quality read model.
//
// Proves the frozen measurement rules: independent dimensions (no weighted
// overall number), deterministic segmentation, unknown-as-unknown identity,
// presentation-state derivation, and evaluation-corpus aggregation from the
// existing canonical scorecard fields.

import { jest } from "@jest/globals";

const {
  mapReceiptRow,
  summarizeRuntime,
  segmentObservations,
  summarizeEvaluation,
  derivePresentationState,
  buildQualityScorecard,
  loadEvaluationRecords,
  QUALITY_PRESENTATION_STATE,
  SEGMENT_KEYS,
} = await import("../../src/services/reviewQualityScorecard.js");

// ── Fixtures ─────────────────────────────────────────────────────────────────

function receiptRow(overrides = {}) {
  return {
    id: 1,
    verdict: "approved",
    approval_eligible: true,
    evidence_manifest: {
      coverage: { approvalEvidenceComplete: true },
      primaryFindings: [{ severity: "P3", claim: "x" }],
      budgetConsumption: { fileReads: 4, searches: 2 },
      executionProfiles: {
        primary: {
          provider: "api.z.example", adapter: "anthropic-sdk-primary", protocol: "anthropic-messages",
          requestedModel: "model-a", observedModel: null, identitySource: "requested_only",
          configurationFingerprint: "sha256:aaaa1111aaaa1111",
          terminalState: "completed", durationMs: 8000,
          usage: { inputTokens: 1000, outputTokens: 200, cacheReadTokens: null, cacheWriteTokens: null, totalTokens: 1200 },
        },
        verifier: {
          provider: "api.z.example", adapter: "anthropic-sdk-verifier", protocol: "anthropic-messages",
          requestedModel: "model-a", observedModel: null, identitySource: "requested_only",
          configurationFingerprint: "sha256:bbbb2222bbbb2222",
          terminalState: "completed", durationMs: 3000,
          usage: { inputTokens: 400, outputTokens: 80, cacheReadTokens: null, cacheWriteTokens: null, totalTokens: 480 },
        },
      },
    },
    verification_receipt: { status: "verified", findings: [], rawFindings: [] },
    tokens_used: 1680,
    duration_ms: 12000,
    started_at: "2026-08-17T00:00:00Z",
    ...overrides,
  };
}

function evalScorecard() {
  return {
    kind: "phase9-ab-scorecard",
    scorecard: {
      "current-gitwire": { runs: 6, converged: 3, brokenDetected: 0, brokenRuns: 3, fixedPrecise: 3, fixedRuns: 3, evidenceIntact: 6 },
      "pi": { runs: 6, converged: 4, brokenDetected: 0, brokenRuns: 3, fixedPrecise: 3, fixedRuns: 3, evidenceIntact: 5 },
    },
    decision: { outcome: "no-winner" },
  };
}

function evalRun(requestedModel, actualModel) {
  return {
    kind: "phase9-ab-run", arm: "pi", variant: "broken", repetition: 1,
    execution: { requestedProvider: "zai", actualProvider: "zai", requestedModel, actualModel },
  };
}

// ── Runtime mapping and dimensions ───────────────────────────────────────────

describe("Phase 10 D: runtime receipt mapping", () => {

  it("maps a v2 receipt row with JSONB-parsed manifest", () => {
    const o = mapReceiptRow(receiptRow());
    expect(o.coverageComplete).toBe(true);
    expect(o.verifierStatus).toBe("verified");
    expect(o.primaryProfile.identitySource).toBe("requested_only");
    expect(o.primaryMaterialCount).toBe(0);
    expect(o.repositoryReads).toBe(4);
  });

  it("maps a row whose manifest arrives as a JSON string", () => {
    const row = receiptRow();
    row.evidence_manifest = JSON.stringify(row.evidence_manifest);
    row.verification_receipt = JSON.stringify(row.verification_receipt);
    const o = mapReceiptRow(row);
    expect(o.coverageComplete).toBe(true);
    expect(o.verifierStatus).toBe("verified");
  });

  it("rows without profiles or receipts stay valid observations", () => {
    const o = mapReceiptRow({
      id: 2, verdict: "needs_discussion", approval_eligible: false,
      evidence_manifest: null, verification_receipt: null,
    });
    expect(o.primaryProfile).toBeNull();
    expect(o.verifierProfile).toBeNull();
    expect(o.verifierStatus).toBeNull();
    expect(o.coverageComplete).toBe(false);
  });
});

describe("Phase 10 D: runtime dimension aggregation", () => {

  it("aggregates reliability terminal states per invocation role", () => {
    const rows = [
      receiptRow(),
      receiptRow({ id: 2, verdict: "needs_discussion", approval_eligible: false,
        evidence_manifest: { ...receiptRow().evidence_manifest,
          executionProfiles: { primary: { terminalState: "timeout" }, verifier: null } } }),
    ];
    const summary = summarizeRuntime(rows.map(mapReceiptRow));
    expect(summary.reliability).toEqual({
      "primary:completed": 1, "verifier:completed": 1, "primary:timeout": 1,
    });
    expect(summary.runCount).toBe(2);
  });

  it("clean approvals come from the v2 policy output, not the delivered verdict", () => {
    // Shadow rows carry the LEGACY engine's verdict in the verdict column;
    // only approval_eligible records the v2 decision.
    const rows = [
      receiptRow(),
      receiptRow({ id: 2, verdict: "approved", approval_eligible: false }),
      receiptRow({ id: 3, verdict: "needs_discussion", approval_eligible: false }),
    ];
    const summary = summarizeRuntime(rows.map(mapReceiptRow));
    expect(summary.precision.cleanApprovalCount).toBe(1);
    expect(summary.precision.cleanApprovalRate).toBeCloseTo(1 / 3);
  });

  it("computes clean approval rate over v2 receipts", () => {
    const rows = [receiptRow(), receiptRow({ id: 2, verdict: "request_changes", approval_eligible: false })];
    const summary = summarizeRuntime(rows.map(mapReceiptRow));
    expect(summary.precision.cleanApprovalCount).toBe(1);
    expect(summary.precision.cleanApprovalRate).toBe(0.5);
  });

  it("counts RI-4-valid material findings and verifier statuses", () => {
    const row = receiptRow();
    row.evidence_manifest.primaryFindings = [
      { severity: "P1", claim: "a" }, { severity: "P2", claim: "b" }, { severity: "P3", claim: "c" },
    ];
    const summary = summarizeRuntime([mapReceiptRow(row)]);
    expect(summary.evidence.ri4ValidMaterialFindingCount).toBe(2);
    expect(summary.verifier).toEqual({ verified: 1 });
  });

  it("efficiency carries latency/token distributions and repository counters", () => {
    const summary = summarizeRuntime([mapReceiptRow(receiptRow())]);
    expect(summary.efficiency.primaryLatencyMs.mean).toBe(8000);
    expect(summary.efficiency.verifierLatencyMs.mean).toBe(3000);
    expect(summary.efficiency.primaryTokens.mean).toBe(1200);
    expect(summary.efficiency.repositoryReads).toBe(4);
    expect(summary.efficiency.repositorySearches).toBe(2);
  });
});

// ── Segmentation ─────────────────────────────────────────────────────────────

describe("Phase 10 D: segmentation by execution identity", () => {

  it("segments by requested model; unknown stays null (rendered as unknown)", () => {
    const rows = [
      receiptRow(),
      receiptRow({ id: 2, evidence_manifest: { ...receiptRow().evidence_manifest,
        executionProfiles: { primary: { requestedModel: null, observedModel: null, identitySource: "opaque" }, verifier: null } } }),
    ];
    const groups = segmentObservations(rows.map(mapReceiptRow), "requestedModel");
    expect(groups.get("model-a")).toHaveLength(1);
    expect(groups.get(null)).toHaveLength(1);
  });

  it("segments by identitySource and fingerprint deterministically", () => {
    const rows = [receiptRow(), receiptRow()];
    const obs = rows.map(mapReceiptRow);
    expect(segmentObservations(obs, "identitySource").get("requested_only")).toHaveLength(2);
    expect(segmentObservations(obs, "configurationFingerprint").get("sha256:aaaa1111aaaa1111")).toHaveLength(2);
  });

  it("every allowed segment key is present in the scorecard", () => {
    const sc = buildQualityScorecard({ receiptRows: [receiptRow()], evaluationScorecards: [], evaluationRuns: [] });
    for (const key of SEGMENT_KEYS) {
      expect(sc.segmentation[key]).toBeDefined();
    }
  });
});

// ── Frozen efficiency surface: cache tokens, cost, tool-call total ───────────

describe("Phase 10 D: efficiency — cache tokens, cost, and tool-call total", () => {

  it("cache categories stay null when the provider never exposed them", () => {
    // The production fixture: usage carries input/output, cache fields null.
    const summary = summarizeRuntime([mapReceiptRow(receiptRow())]);
    expect(summary.efficiency.primaryUsage.inputTokens).toEqual({
      count: 1, min: 1000, max: 1000, mean: 1000, median: 1000,
    });
    expect(summary.efficiency.primaryUsage.cacheReadTokens).toBeNull();
    expect(summary.efficiency.primaryUsage.cacheWriteTokens).toBeNull();
    expect(summary.efficiency.verifierUsage.cacheReadTokens).toBeNull();
  });

  it("cache categories surface as distributions when profiles carry them", () => {
    const withCache = (read, write) => receiptRow({
      evidence_manifest: {
        ...receiptRow().evidence_manifest,
        executionProfiles: {
          primary: {
            ...receiptRow().evidence_manifest.executionProfiles.primary,
            usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: read, cacheWriteTokens: write, totalTokens: 10 + 2 + read + write },
          },
          verifier: null,
        },
      },
    });
    const summary = summarizeRuntime([
      mapReceiptRow(withCache(100, 50)),
      mapReceiptRow(withCache(300, 150)),
    ]);
    expect(summary.efficiency.primaryUsage.cacheReadTokens).toEqual({
      count: 2, min: 100, max: 300, mean: 200, median: 300,
    });
    expect(summary.efficiency.primaryUsage.cacheWriteTokens.mean).toBe(100);
    // A null-cache row joins input/output distributions but not cache ones.
    const mixed = summarizeRuntime([mapReceiptRow(withCache(100, 50)), mapReceiptRow(receiptRow())]);
    expect(mixed.efficiency.primaryUsage.inputTokens.count).toBe(2);
    expect(mixed.efficiency.primaryUsage.cacheReadTokens.count).toBe(1);
  });

  it("verifier usage dimensions aggregate independently of primary", () => {
    const row = receiptRow();
    row.evidence_manifest.executionProfiles.verifier.usage = {
      inputTokens: 400, outputTokens: 80, cacheReadTokens: 900, cacheWriteTokens: null, totalTokens: 1380,
    };
    const summary = summarizeRuntime([mapReceiptRow(row)]);
    expect(summary.efficiency.verifierUsage.cacheReadTokens.mean).toBe(900);
    expect(summary.efficiency.verifierUsage.cacheWriteTokens).toBeNull();
    expect(summary.efficiency.primaryUsage.cacheReadTokens).toBeNull();
  });

  it("cost stays null when nothing reported a numeric amount", () => {
    expect(summarizeRuntime([mapReceiptRow(receiptRow())]).efficiency.cost).toBeNull();
    const noCost = receiptRow();
    noCost.evidence_manifest.executionProfiles.primary.cost = { amount: null, currency: null, source: null };
    expect(summarizeRuntime([mapReceiptRow(noCost)]).efficiency.cost).toBeNull();
  });

  it("cost sums per currency and never merges currencies", () => {
    const priced = (amount, currency) => receiptRow({
      evidence_manifest: {
        ...receiptRow().evidence_manifest,
        executionProfiles: {
          primary: { ...receiptRow().evidence_manifest.executionProfiles.primary, cost: { amount, currency, source: "test" } },
          verifier: null,
        },
      },
    });
    const summary = summarizeRuntime([
      mapReceiptRow(priced(1.5, "USD")),
      mapReceiptRow(priced(2.25, "USD")),
      mapReceiptRow(priced(3.0, "EUR")),
    ]);
    expect(summary.efficiency.cost.reportedCount).toBe(3);
    expect(summary.efficiency.cost.byCurrency).toEqual({
      USD: { count: 2, total: 3.75 },
      EUR: { count: 1, total: 3.0 },
    });
    // No cross-currency total key exists anywhere in the summary.
    expect(Object.keys(summary.efficiency.cost)).toEqual(["reportedCount", "byCurrency"]);
  });

  it("cost without a currency lands in a distinct unknown bucket", () => {
    const row = receiptRow();
    row.evidence_manifest.executionProfiles.primary.cost = { amount: 0.5, currency: null, source: "test" };
    const summary = summarizeRuntime([mapReceiptRow(row)]);
    expect(summary.efficiency.cost.byCurrency).toEqual({ unknown: { count: 1, total: 0.5 } });
  });

  it("tool-call total is reads + searches, null only when neither is known", () => {
    const base = summarizeRuntime([mapReceiptRow(receiptRow())]);
    expect(base.efficiency.repositoryToolCalls).toBe(6); // 4 reads + 2 searches

    const readsOnly = receiptRow();
    readsOnly.evidence_manifest.budgetConsumption = { fileReads: 7, searches: null };
    const partial = summarizeRuntime([mapReceiptRow(readsOnly)]);
    expect(partial.efficiency.repositoryToolCalls).toBe(7);

    const none = receiptRow({ evidence_manifest: { coverage: { approvalEvidenceComplete: true } } });
    expect(summarizeRuntime([mapReceiptRow(none)]).efficiency.repositoryToolCalls).toBeNull();
  });

  it("existing efficiency keys keep their shape alongside the new surface", () => {
    const summary = summarizeRuntime([mapReceiptRow(receiptRow())]);
    expect(summary.efficiency.primaryLatencyMs.mean).toBe(8000);
    expect(summary.efficiency.primaryTokens.mean).toBe(1200);
    expect(summary.efficiency.repositoryReads).toBe(4);
    expect(summary.efficiency.repositorySearches).toBe(2);
  });
});

// ── Evaluation corpus dimensions ─────────────────────────────────────────────

describe("Phase 10 D: evaluation aggregation uses the existing canonical fields", () => {

  it("derives safety + precision per arm without a new scoring definition", () => {
    const summary = summarizeEvaluation([evalScorecard()]);
    const pi = summary.arms.find(a => a.arm === "pi");
    expect(pi.safety.brokenFalseApproveCount).toBe(3);   // 3 broken runs, 0 detected
    expect(pi.safety.brokenFalseApproveRate).toBe(1);
    expect(pi.safety.expectedMaterialDefectRecall).toBe(0);
    expect(pi.precision.fixedFalseMaterialCount).toBe(0);
    expect(summary.overall.safety.brokenRuns).toBe(6);
    expect(summary.overall.safety.brokenFalseApproveCount).toBe(6);
  });

  it("handles a detecting scorecard (recall > 0, false approves 0)", () => {
    const sc = evalScorecard();
    sc.scorecard.pi = { runs: 6, converged: 4, brokenDetected: 3, brokenRuns: 3, fixedPrecise: 2, fixedRuns: 3 };
    const summary = summarizeEvaluation([sc]);
    const pi = summary.arms.find(a => a.arm === "pi");
    expect(pi.safety.brokenFalseApproveCount).toBe(0);
    expect(pi.safety.expectedMaterialDefectRecall).toBe(1);
    expect(pi.precision.fixedFalseMaterialCount).toBe(1);
  });

  it("empty corpus yields null rates, never zeros", () => {
    const summary = summarizeEvaluation([]);
    expect(summary.overall.safety.brokenFalseApproveRate).toBeNull();
    expect(summary.overall.safety.expectedMaterialDefectRecall).toBeNull();
    expect(summary.overall.runs).toBe(0);
  });
});

// ── Presentation states ──────────────────────────────────────────────────────

describe("Phase 10 D: presentation-state derivation (display only)", () => {

  it("no evaluation runs → Insufficient evaluation data", () => {
    expect(derivePresentationState({ evaluationRuns: 0 }))
      .toBe(QUALITY_PRESENTATION_STATE.INSUFFICIENT);
  });

  it("any broken false-approve → Degraded regardless of sample size", () => {
    expect(derivePresentationState({ evaluationRuns: 20, brokenFalseApproveCount: 1 }))
      .toBe(QUALITY_PRESENTATION_STATE.DEGRADED);
    expect(derivePresentationState({ evaluationRuns: 2, brokenFalseApproveCount: 1 }))
      .toBe(QUALITY_PRESENTATION_STATE.DEGRADED);
  });

  it("small clean sample → Evaluating current configuration", () => {
    expect(derivePresentationState({ evaluationRuns: 4, brokenFalseApproveCount: 0 }))
      .toBe(QUALITY_PRESENTATION_STATE.EVALUATING);
  });

  it("adequate clean sample → Healthy", () => {
    expect(derivePresentationState({ evaluationRuns: 5, brokenFalseApproveCount: 0 }))
      .toBe(QUALITY_PRESENTATION_STATE.HEALTHY);
  });
});

// ── Full scorecard ───────────────────────────────────────────────────────────

describe("Phase 10 D: full scorecard assembly", () => {

  it("exposes the read window and truncation explicitly", () => {
    const sc = buildQualityScorecard({
      receiptRows: [receiptRow()],
      evaluationScorecards: [evalScorecard()],
      evaluationRuns: [],
      window: { limit: 500, rowsReturned: 1, totalV2Receipts: 742, truncated: true },
    });
    expect(sc.window).toEqual({ limit: 500, rowsReturned: 1, totalV2Receipts: 742, truncated: true });
    // No window supplied (pure-function callers) → null, never a fake window.
    const sc2 = buildQualityScorecard({ receiptRows: [], evaluationScorecards: [], evaluationRuns: [] });
    expect(sc2.window).toBeNull();
  });

  it("assembles dimensions without a weighted overall number", () => {
    const sc = buildQualityScorecard({
      receiptRows: [receiptRow()],
      evaluationScorecards: [evalScorecard()],
      evaluationRuns: [evalRun("glm-5.3", "glm-5.3")],
    });
    expect(sc.kind).toBe("review-quality-scorecard");
    expect(sc.policy).toEqual({ measurementOnly: true, feedsReviewAuthority: false, overallQualityNumber: false });
    expect(sc.presentationState).toBe(QUALITY_PRESENTATION_STATE.DEGRADED); // 6 broken false-approves
    expect(sc.dimensions.safety.brokenFalseApproveCount).toBe(6);
    expect(sc.dimensions.reliability["primary:completed"]).toBe(1);
    expect(sc.dimensions.verifier.verified).toBe(1);
    expect(sc.evaluation.byModel["glm-5.3"].runCount).toBe(1);
    expect(sc.evaluation.presentationStatesByArm.pi).toBe(QUALITY_PRESENTATION_STATE.DEGRADED);
    expect(sc.runtimeRunCount).toBe(1);
    expect(Object.keys(sc)).not.toContain("overallScore");
  });
});

// ── Loader ───────────────────────────────────────────────────────────────────

describe("Phase 10 D: evaluation records loader", () => {

  it("returns empty structures for an absent directory (never throws)", async () => {
    const result = await loadEvaluationRecords("Z:/definitely/not/a/real/path-" + Date.now());
    expect(result).toEqual({ scorecards: [], runs: [] });
  });

  it("loads phase9 scorecards and runs from a directory tree", async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "ri10-eval-"));
    try {
      const runDir = join(dir, "ab-2026-01-01-0000000000000");
      mkdirSync(runDir);
      writeFileSync(join(runDir, "scorecard.json"), JSON.stringify(evalScorecard()));
      writeFileSync(join(runDir, "run-01-pi-broken.json"), JSON.stringify(evalRun("glm-5.3", "glm-5.3")));
      writeFileSync(join(runDir, "corrupt.json"), "{not json");

      const result = await loadEvaluationRecords(dir);
      expect(result.scorecards).toHaveLength(1);
      expect(result.runs).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── Route wiring (structural) ────────────────────────────────────────────────

describe("Phase 10 D: /api/review/quality route wiring", () => {
  it("the phase4 router exposes the quality route from the scorecard service", async () => {
    const { readFileSync } = await import("node:fs");
    const { join, dirname } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const routeSource = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "routes", "phase4.js"),
      "utf8",
    );
    expect(routeSource).toContain('phase4Router.get("/review/quality"');
    expect(routeSource).toContain("reviewQualityScorecard.js");
    // v2-only selection: integrity_version alone matches pre-v2 rows on an
    // upgraded database (migration 043 DEFAULT 1 backfill).
    expect(routeSource).toContain("WHERE review_invocation_id IS NOT NULL");
    expect(routeSource).not.toContain("WHERE integrity_version IS NOT NULL");
  });
});
