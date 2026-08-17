"use client";

import useSWR from "swr";
import { fetcher, API } from "../../lib/api";
import { PageHeader, StatCard, Badge, Skeleton, EmptyState } from "../../components/ui";

// ── Types (subset of the server read model) ────────────────────────────────

type Distribution = { count: number; min: number; max: number; mean: number; median: number } | null;

type UsageDimensions = {
  inputTokens: Distribution; outputTokens: Distribution;
  cacheReadTokens: Distribution; cacheWriteTokens: Distribution;
};

type CostSummary = {
  reportedCount: number;
  byCurrency: Record<string, { count: number; total: number }>;
};

type Scorecard = {
  kind: string;
  presentationState: string;
  policy: { measurementOnly: boolean; feedsReviewAuthority: boolean; overallQualityNumber: boolean };
  dimensions: {
    safety: {
      brokenRuns: number; brokenDetected: number;
      brokenFalseApproveCount: number; brokenFalseApproveRate: number | null;
      expectedMaterialDefectRecall: number | null;
    };
    precision: {
      fixedRuns: number; fixedFalseMaterialCount: number; fixedFalseMaterialRate: number | null;
      runtimeCleanApprovalRate: number | null;
    };
    reliability: Record<string, number>;
    evidence: {
      approvalEvidenceCompleteCount: number; approvalEvidenceCompleteRate: number | null;
      ri4ValidMaterialFindingCount: number; evidenceValidationRejects: number | null;
    };
    verifier: Record<string, number>;
    efficiency: {
      latencyMs: Distribution; primaryLatencyMs: Distribution; verifierLatencyMs: Distribution;
      tokensUsed: Distribution; primaryTokens: Distribution; verifierTokens: Distribution;
      primaryUsage: UsageDimensions | null;
      verifierUsage: UsageDimensions | null;
      cost: CostSummary | null;
      repositoryReads: number | null; repositorySearches: number | null;
      repositoryToolCalls: number | null;
    };
  };
  evaluation: {
    arms: Array<{
      arm: string; runs: number;
      safety: { brokenFalseApproveCount: number; brokenFalseApproveRate: number | null; expectedMaterialDefectRecall: number | null };
      precision: { fixedFalseMaterialCount: number; fixedFalseMaterialRate: number | null };
    }>;
    byModel: Record<string, { runCount: number; actualModels: Array<string | null> }>;
    presentationStatesByArm: Record<string, string>;
  };
  segmentation: Record<string, Array<{ value: string | null; runCount: number }>>;
  runtimeRunCount: number;
  window: { limit: number; rowsReturned: number; totalV2Receipts: number; truncated: boolean } | null;
};

// Unknown identity is displayed as unknown — never guessed.
function identity(value: string | null | undefined, label = "unknown"): string {
  return value ?? label;
}

function pct(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  return (value * 100).toFixed(1) + "%";
}

function ms(value: Distribution): string {
  if (!value) return "—";
  return Math.round(value.mean).toLocaleString() + " ms";
}

// Cache tokens: show the mean over reviews that reported the category,
// with how many reviews that was. Unknown stays unknown.
function cachePair(usage: UsageDimensions | null | undefined, field: "cacheReadTokens" | "cacheWriteTokens"): string {
  const d = usage?.[field];
  if (!d) return "not exposed";
  return Math.round(d.mean).toLocaleString() + " (mean of " + d.count + ")";
}

// Cost: per-currency totals only. Currencies are never merged.
function costText(cost: CostSummary | null | undefined): string {
  if (!cost) return "not reported";
  return Object.entries(cost.byCurrency)
    .map(([ccy, v]) => ccy + " " + v.total.toFixed(2) + " · " + v.count + " report" + (v.count !== 1 ? "s" : ""))
    .join(" | ");
}

function stateVariant(state: string): string {
  switch (state) {
    case "Healthy": return "green";
    case "Degraded": return "red";
    case "Evaluating current configuration": return "amber";
    default: return "default";
  }
}

// ── Page ───────────────────────────────────────────────────────────────────

export default function ReviewQualityPage() {
  const { data: scorecard, error, isLoading } = useSWR<{ data: Scorecard }>(API.reviewQuality(), fetcher, {
    refreshInterval: 30_000,
  });
  const sc = scorecard?.data;

  return (
    <div>
      <PageHeader
        title="Review Quality"
        subtitle="Model-neutral service-quality measurement — execution configurations, not model qualifications."
      />

      {error && (
        <EmptyState title="Could not load the quality scorecard" body={String(error.message ?? error)} />
      )}

      {isLoading && !sc && (
        <div className="grid gap-4 md:grid-cols-3">
          {[0, 1, 2].map(i => <Skeleton key={i} className="h-28" />)}
        </div>
      )}

      {sc && (
        <div className="space-y-6">

          {/* Overall presentation state — display only */}
          <div className="card p-4 flex items-center justify-between">
            <div>
              <div className="text-sm text-text-tertiary">Current presentation state</div>
              <div className="text-lg font-semibold mt-1">{sc.presentationState}</div>
              <div className="text-xs text-text-tertiary mt-1">
                Measurement surface only — quality metadata never affects review authority.
              </div>
              {sc.window && (
                <div className="text-xs text-text-tertiary mt-1">
                  Runtime window: {sc.window.rowsReturned.toLocaleString()} of {sc.window.totalV2Receipts.toLocaleString()} v2 receipts
                  {sc.window.truncated ? ` (most recent ${sc.window.limit.toLocaleString()} — older history truncated)` : ""}
                </div>
              )}
            </div>
            <Badge variant={stateVariant(sc.presentationState)}>{sc.presentationState}</Badge>
          </div>

          {/* Safety + precision */}
          <div className="grid gap-4 md:grid-cols-4">
            <StatCard
              label="Broken false APPROVE"
              value={sc.dimensions.safety.brokenFalseApproveCount}
              sub={`rate ${pct(sc.dimensions.safety.brokenFalseApproveRate)} · ${sc.dimensions.safety.brokenRuns} broken runs`}
              accent="red"
            />
            <StatCard
              label="Expected-defect recall"
              value={pct(sc.dimensions.safety.expectedMaterialDefectRecall)}
              sub={`${sc.dimensions.safety.brokenDetected}/${sc.dimensions.safety.brokenRuns} broken fixtures detected`}
            />
            <StatCard
              label="Fixed false material"
              value={sc.dimensions.precision.fixedFalseMaterialCount}
              sub={`rate ${pct(sc.dimensions.precision.fixedFalseMaterialRate)} · ${sc.dimensions.precision.fixedRuns} fixed runs`}
              accent="amber"
            />
            <StatCard
              label="Runtime clean approvals"
              value={pct(sc.dimensions.precision.runtimeCleanApprovalRate)}
              sub={`${sc.runtimeRunCount} v2 receipts`}
            />
          </div>

          {/* Reliability / evidence / verifier */}
          <div className="grid gap-4 md:grid-cols-3">
            <div className="card p-4">
              <div className="text-sm font-semibold mb-2">Reliability — invocation terminal states</div>
              {Object.keys(sc.dimensions.reliability).length === 0
                ? <div className="text-text-tertiary text-sm">No execution profiles recorded yet.</div>
                : (
                  <table className="w-full text-sm">
                    <tbody>
                      {Object.entries(sc.dimensions.reliability).map(([state, count]) => (
                        <tr key={state}>
                          <td className="py-0.5 text-text-secondary font-mono text-xs">{state}</td>
                          <td className="py-0.5 text-right">{count}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
            </div>
            <div className="card p-4">
              <div className="text-sm font-semibold mb-2">Evidence quality</div>
              <table className="w-full text-sm">
                <tbody>
                  <tr><td className="py-0.5 text-text-secondary">Approval evidence complete</td><td className="py-0.5 text-right">{pct(sc.dimensions.evidence.approvalEvidenceCompleteRate)}</td></tr>
                  <tr><td className="py-0.5 text-text-secondary">RI-4-valid material findings</td><td className="py-0.5 text-right">{sc.dimensions.evidence.ri4ValidMaterialFindingCount}</td></tr>
                  <tr><td className="py-0.5 text-text-secondary">Evidence-validation rejects</td><td className="py-0.5 text-right">{sc.dimensions.evidence.evidenceValidationRejects ?? "—"}</td></tr>
                </tbody>
              </table>
            </div>
            <div className="card p-4">
              <div className="text-sm font-semibold mb-2">Verifier</div>
              {Object.keys(sc.dimensions.verifier).length === 0
                ? <div className="text-text-tertiary text-sm">No verifier runs recorded.</div>
                : (
                  <table className="w-full text-sm">
                    <tbody>
                      {Object.entries(sc.dimensions.verifier).map(([status, count]) => (
                        <tr key={status}>
                          <td className="py-0.5 text-text-secondary font-mono text-xs">{status}</td>
                          <td className="py-0.5 text-right">{count}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
            </div>
          </div>

          {/* Efficiency — frozen Phase 10 surface: latency, tokens/cache/cost, tool calls/retrieval */}
          <div className="grid gap-4 md:grid-cols-4">
            <StatCard label="Primary latency (mean)" value={ms(sc.dimensions.efficiency.primaryLatencyMs)} sub="per primary invocation" />
            <StatCard label="Verifier latency (mean)" value={ms(sc.dimensions.efficiency.verifierLatencyMs)} sub="per verifier invocation" />
            <StatCard label="Total latency (mean)" value={ms(sc.dimensions.efficiency.latencyMs)} sub="per review" />
            <StatCard
              label="Tool calls (reads + searches)"
              value={sc.dimensions.efficiency.repositoryToolCalls ?? "—"}
              sub={`${sc.dimensions.efficiency.repositoryReads ?? "—"} reads · ${sc.dimensions.efficiency.repositorySearches ?? "—"} searches (context broker)`}
            />
          </div>
          <div className="grid gap-4 md:grid-cols-4">
            <StatCard label="Primary cache read" value={cachePair(sc.dimensions.efficiency.primaryUsage, "cacheReadTokens")} sub="mean over reporting reviews" />
            <StatCard label="Primary cache write" value={cachePair(sc.dimensions.efficiency.primaryUsage, "cacheWriteTokens")} sub="mean over reporting reviews" />
            <StatCard
              label="Primary input / output tokens (mean)"
              value={sc.dimensions.efficiency.primaryUsage?.inputTokens && sc.dimensions.efficiency.primaryUsage?.outputTokens
                ? Math.round(sc.dimensions.efficiency.primaryUsage.inputTokens.mean).toLocaleString() + " / " + Math.round(sc.dimensions.efficiency.primaryUsage.outputTokens.mean).toLocaleString()
                : "—"}
              sub={`verifier: ${sc.dimensions.efficiency.verifierUsage?.inputTokens && sc.dimensions.efficiency.verifierUsage?.outputTokens
                ? Math.round(sc.dimensions.efficiency.verifierUsage.inputTokens.mean).toLocaleString() + " / " + Math.round(sc.dimensions.efficiency.verifierUsage.outputTokens.mean).toLocaleString()
                : "—"}`}
            />
            <StatCard label="Reported cost" value={costText(sc.dimensions.efficiency.cost)} sub="per currency · never merged" />
          </div>

          {/* Evaluation arms */}
          <div className="card p-4">
            <div className="text-sm font-semibold mb-2">Evaluation corpus — per configuration arm</div>
            {sc.evaluation.arms.length === 0
              ? <div className="text-text-tertiary text-sm">No frozen evaluation records found (Insufficient evaluation data).</div>
              : (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-text-tertiary text-xs">
                      <th className="py-1">Arm</th>
                      <th className="py-1">Runs</th>
                      <th className="py-1">Broken false APPROVE</th>
                      <th className="py-1">Defect recall</th>
                      <th className="py-1">Fixed false material</th>
                      <th className="py-1">State</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sc.evaluation.arms.map(arm => (
                      <tr key={arm.arm} className="border-t border-border">
                        <td className="py-1.5 font-mono text-xs">{arm.arm}</td>
                        <td className="py-1.5">{arm.runs}</td>
                        <td className="py-1.5">{arm.safety.brokenFalseApproveCount} ({pct(arm.safety.brokenFalseApproveRate)})</td>
                        <td className="py-1.5">{pct(arm.safety.expectedMaterialDefectRecall)}</td>
                        <td className="py-1.5">{arm.precision.fixedFalseMaterialCount} ({pct(arm.precision.fixedFalseMaterialRate)})</td>
                        <td className="py-1.5"><Badge variant={stateVariant(sc.evaluation.presentationStatesByArm[arm.arm] ?? "")}>{sc.evaluation.presentationStatesByArm[arm.arm] ?? "—"}</Badge></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
          </div>

          {/* Execution-configuration segmentation */}
          <div className="card p-4">
            <div className="text-sm font-semibold mb-2">Runtime segmentation — execution configurations</div>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-text-tertiary text-xs">
                  <th className="py-1">Segment</th>
                  <th className="py-1">Value</th>
                  <th className="py-1">Reviews</th>
                </tr>
              </thead>
              <tbody>
                {["configurationFingerprint", "provider", "requestedModel", "observedModel", "identitySource"].map(key => (
                  (sc.segmentation[key] ?? []).map((seg, i) => (
                    <tr key={key + "-" + i} className="border-t border-border">
                      <td className="py-1.5 font-mono text-xs">{key}</td>
                      <td className="py-1.5 font-mono text-xs">
                        {key === "observedModel" && seg.value === null
                          ? "Not exposed by provider"
                          : identity(seg.value)}
                      </td>
                      <td className="py-1.5">{seg.runCount}</td>
                    </tr>
                  ))
                ))}
              </tbody>
            </table>
          </div>

        </div>
      )}
    </div>
  );
}
