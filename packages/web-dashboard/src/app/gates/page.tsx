"use client";

import { useState } from "react";
import useSWR from "swr";
import {
  fetcher,
  API,
  evaluateGates,
  createGate,
  deleteGate,
} from "@/lib/api";
import {
  Badge,
  StatCard,
  EmptyState,
  PageHeader,
} from "@/components/ui";

interface GateCondition {
  metric: string;
  operator: string;
  threshold: number;
  actual?: number;
  passed?: boolean;
}

interface RepoGates {
  repo: string;
  overall: string;
  gates: Array<{
    id: number;
    name: string;
    is_default: boolean;
    conditions: GateCondition[];
    block_on_fail: boolean;
    latest_evaluation: {
      result: string;
      score: number;
      passed_count: number;
      failed_count: number;
      total_count: number;
      conditions: GateCondition[];
      evaluated_at: string;
    } | null;
  }>;
  total: number;
}

interface FleetGate {
  total_repos: number;
  passed: number;
  failed: number;
  repos: Array<{
    repo: string;
    repoId: number;
    overall: string;
    gates: Array<{
      name: string;
      result: string;
      score: number;
      block_on_fail: boolean;
      evaluated_at: string;
    }>;
  }>;
}

function formatMetricValue(metric: string, value: number | null | undefined): string {
  if (value === null || value === undefined) return "N/A";
  if (metric.includes("rate") || metric.includes("coverage")) {
    return `${(value * 100).toFixed(1)}%`;
  }
  if (metric === "readiness_score") return `${Math.round(value)}/100`;
  if (metric.includes("time_hours")) return `${value.toFixed(1)}h`;
  return String(value);
}

export default function GatesPage() {
  const [selectedRepo, setSelectedRepo] = useState<string | null>(null);
  const [evaluating, setEvaluating] = useState(false);
  const [showNewGate, setShowNewGate] = useState(false);

  const { data: fleet, mutate: mutateFleet } = useSWR<FleetGate>(API.gates(), fetcher);
  const { data: repoGates, mutate: mutateRepo } = useSWR<RepoGates>(
    selectedRepo ? API.gatesRepo(selectedRepo.split("/")[0], selectedRepo.split("/")[1]) : null,
    fetcher
  );
  const { data: metrics } = useSWR<{ repo: string; metrics: Record<string, number> }>(
    selectedRepo ? API.gatesMetrics(selectedRepo.split("/")[0], selectedRepo.split("/")[1]) : null,
    fetcher
  );

  const { data: trends } = useSWR<{
    repo: string;
    days: number;
    gate_trends: Array<{ date: string; gate_name: string; avg_score: string; result: string; passed_count: number; failed_count: number }>;
    metric_trends: Array<{ date: string; gate_name: string; metric: string; actual: number; threshold: number; passed: boolean }>;
  }>(
    selectedRepo ? API.gatesTrends(selectedRepo.split("/")[0], selectedRepo.split("/")[1], 30) : null,
    fetcher
  );

  const handleEvaluate = async () => {
    if (!selectedRepo) return;
    setEvaluating(true);
    try {
      const [owner, repo] = selectedRepo.split("/");
      await evaluateGates(owner, repo);
      await mutateRepo();
      await mutateFleet();
    } catch (_e) {
      // Silently handle
    } finally {
      setEvaluating(false);
    }
  };

  const handleCreateGate = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!selectedRepo) return;
    const form = e.currentTarget;
    const formData = new FormData(form);

    const name = formData.get("name") as string;
    const metric = formData.get("metric") as string;
    const operator = formData.get("operator") as string;
    const threshold = parseFloat(formData.get("threshold") as string);

    if (!name || !metric || !operator || isNaN(threshold)) return;

    const [owner, repo] = selectedRepo.split("/");
    await createGate(owner, repo, name, [{ metric, operator, threshold }]);
    await mutateRepo();
    await mutateFleet();
    setShowNewGate(false);
    (e.target as HTMLFormElement).reset();
  };

  const handleDelete = async (name: string) => {
    if (!selectedRepo || !confirm("Delete gate \"" + name + "\"?")) return;
    const [owner, repo] = selectedRepo.split("/");
    await deleteGate(owner, repo, name);
    await mutateRepo();
    await mutateFleet();
  };

  const repos = fleet ?? { total_repos: 0, passed: 0, failed: 0, repos: [] };

  return (
    <div>
      <PageHeader title="Quality Gates" subtitle="Metric thresholds that evaluate repo health and can block PR merges" />

      {/* Fleet metrics */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
        <StatCard label="Monitored Repos" value={repos.total_repos} />
        <StatCard label="All Gates Passing" value={repos.passed} accent="green" />
        <StatCard label="Gates Failing" value={repos.failed} accent="red" />
        <StatCard
          label="Pass Rate"
          value={repos.total_repos > 0 ? ((repos.passed / repos.total_repos) * 100).toFixed(0) + "%" : "0%"}
        />
      </div>

      <div className="card">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold">Repositories</h2>
          {selectedRepo && (
            <div className="flex gap-2">
              <button
                onClick={() => setShowNewGate(!showNewGate)}
                className="px-3 py-1.5 rounded text-sm bg-gray-700 hover:bg-gray-600 transition-colors"
              >
                + New Gate
              </button>
              <button
                onClick={handleEvaluate}
                disabled={evaluating}
                className="px-3 py-1.5 rounded text-sm bg-accent-green/20 text-accent-green hover:bg-accent-green/30 transition-colors disabled:opacity-50"
              >
                {evaluating ? "Evaluating..." : "Evaluate Now"}
              </button>
            </div>
          )}
        </div>

        {!selectedRepo ? (
          /* Fleet view */
          repos.repos.length === 0 ? (
            <EmptyState title="No evaluations yet" body="Quality gates will appear after repos are evaluated" />
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-[10px] font-mono text-text-tertiary uppercase tracking-wider">
                  <th className="text-left px-4 py-2.5">Repository</th>
                  <th className="text-left px-4 py-2.5">Overall</th>
                  <th className="text-left px-4 py-2.5">Gates</th>
                  <th className="text-left px-4 py-2.5">Last Evaluated</th>
                </tr>
              </thead>
              <tbody>
                {repos.repos.map((r) => (
                  <tr
                    key={r.repo}
                    className="border-b border-border hover:bg-surface-2/40 cursor-pointer transition-colors"
                    onClick={() => setSelectedRepo(r.repo)}
                  >
                    <td className="px-4 py-3 font-medium">{r.repo}</td>
                    <td className="px-4 py-3">
                      <Badge className={
                        r.overall === "passed"
                          ? "bg-green-900/50 text-green-300"
                          : r.overall === "failed"
                          ? "bg-red-900/50 text-red-300"
                          : "bg-yellow-900/50 text-yellow-300"
                      }>
                        {r.overall.toUpperCase()}
                      </Badge>
                    </td>
                    <td className="px-4 py-3">
                      {r.gates.map((g) => (
                        <Badge
                          key={g.name}
                          className={
                            g.result === "passed"
                              ? "bg-green-900/50 text-green-300 mr-1"
                              : "bg-red-900/50 text-red-300 mr-1"
                          }
                        >
                          {g.name}: {g.score}%
                        </Badge>
                      ))}
                    </td>
                    <td className="px-4 py-3 text-text-tertiary">
                      {r.gates[0]?.evaluated_at
                        ? new Date(r.gates[0].evaluated_at).toLocaleString()
                        : "Never"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
        ) : (
          /* Repo detail view */
          <div>
            <button
              className="text-sm text-text-secondary hover:text-text-primary mb-4"
              onClick={() => {
                setSelectedRepo(null);
                setShowNewGate(false);
              }}
            >
              &larr; Back to all repos
            </button>

            {/* New gate form */}
            {showNewGate && (
              <form
                onSubmit={handleCreateGate}
                className="bg-gray-800/50 rounded-lg p-4 mb-4 space-y-3"
              >
                <h3 className="font-semibold">Create Gate</h3>
                <div className="grid grid-cols-2 gap-3">
                  <input
                    name="name"
                    placeholder="Gate name (e.g. strict)"
                    className="bg-gray-700 rounded px-3 py-2 text-sm"
                    required
                  />
                  <input
                    name="metric"
                    placeholder="Metric (e.g. ci_failure_rate_7d)"
                    className="bg-gray-700 rounded px-3 py-2 text-sm"
                    required
                  />
                  <select
                    name="operator"
                    className="bg-gray-700 rounded px-3 py-2 text-sm"
                    required
                  >
                    <option value="<">&lt; less than</option>
                    <option value="<=">&le; less or equal</option>
                    <option value=">">&gt; greater than</option>
                    <option value=">=">&ge; greater or equal</option>
                    <option value="==">== equals</option>
                    <option value="!=">!= not equals</option>
                  </select>
                  <input
                    name="threshold"
                    type="number"
                    step="0.01"
                    placeholder="Threshold (e.g. 0.3)"
                    className="bg-gray-700 rounded px-3 py-2 text-sm"
                    required
                  />
                </div>
                <div className="flex gap-2">
                  <button type="submit" className="px-3 py-1.5 rounded text-sm bg-accent-green/20 text-accent-green hover:bg-accent-green/30">
                    Create Gate
                  </button>
                  <button
                    type="button"
                    className="px-3 py-1.5 rounded text-sm bg-gray-700 hover:bg-gray-600"
                    onClick={() => setShowNewGate(false)}
                  >
                    Cancel
                  </button>
                </div>
              </form>
            )}

            {/* Gates list */}
            {!repoGates || repoGates.gates.length === 0 ? (
              <EmptyState title="No gates configured" body="Create a gate to start monitoring repo health metrics" />
            ) : (
              <div className="space-y-4">
                {repoGates.gates.map((gate) => {
                  const eval_ = gate.latest_evaluation;
                  const conditions = eval_?.conditions || gate.conditions;

                  return (
                    <div key={gate.id} className="bg-gray-800/50 rounded-lg p-4">
                      <div className="flex items-center justify-between mb-3">
                        <div className="flex items-center gap-2">
                          <h3 className="font-semibold">{gate.name}</h3>
                          {gate.is_default && (
                            <Badge className="bg-blue-900/50 text-blue-300">DEFAULT</Badge>
                          )}
                          {eval_ ? (
                            <Badge className={
                              eval_.result === "passed"
                                ? "bg-green-900/50 text-green-300"
                                : "bg-red-900/50 text-red-300"
                            }>
                              {eval_.result === "passed" ? "\u2705 PASSED" : "\u274C FAILED"}
                            </Badge>
                          ) : (
                            <Badge className="bg-gray-700 text-gray-400">NOT EVALUATED</Badge>
                          )}
                          {!gate.block_on_fail && (
                            <Badge className="bg-yellow-900/50 text-yellow-300">NON-BLOCKING</Badge>
                          )}
                        </div>
                        <div className="flex items-center gap-3">
                          {eval_ && (
                            <span className="text-sm text-text-secondary">
                              Score: {eval_.score}% ({eval_.passed_count}/{eval_.total_count})
                            </span>
                          )}
                          <button
                            onClick={() => handleDelete(gate.name)}
                            className="text-red-400 hover:text-red-300 text-sm"
                          >
                            Delete
                          </button>
                        </div>
                      </div>

                      <table className="w-full text-sm">
                        <thead>
                          <tr className="border-b border-border text-[10px] font-mono text-text-tertiary uppercase tracking-wider">
                            <th className="text-left px-3 py-2">Status</th>
                            <th className="text-left px-3 py-2">Metric</th>
                            <th className="text-left px-3 py-2">Condition</th>
                            <th className="text-left px-3 py-2">Threshold</th>
                            <th className="text-left px-3 py-2">Actual</th>
                          </tr>
                        </thead>
                        <tbody>
                          {conditions.map((c, i) => (
                            <tr key={i} className="border-b border-border/50">
                              <td className="px-3 py-2">
                                {c.passed === undefined ? "\u25CB" : c.passed ? "\u2705" : "\u274C"}
                              </td>
                              <td className="px-3 py-2 font-mono text-xs">{c.metric}</td>
                              <td className="px-3 py-2">{c.operator}</td>
                              <td className="px-3 py-2">{c.threshold}</td>
                              <td className="px-3 py-2">{formatMetricValue(c.metric, c.actual)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>

                      {eval_?.evaluated_at && (
                        <p className="text-xs text-text-tertiary mt-2">
                          Evaluated: {new Date(eval_.evaluated_at).toLocaleString()}
                        </p>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            {/* Gate score trends */}
            {trends && trends.gate_trends.length > 0 && (
              <div className="mt-6">
                <h3 className="text-sm font-semibold text-text-secondary mb-2">
                  Gate Score Trends (30 days)
                </h3>
                <div className="space-y-3">
                  {Array.from(new Set(trends.gate_trends.map((t) => t.gate_name))).map((gateName) => {
                    const gateData = trends.gate_trends.filter((t) => t.gate_name === gateName);
                    const maxScore = 100;
                    return (
                      <div key={gateName} className="bg-gray-800/30 rounded p-3">
                        <div className="flex items-center justify-between mb-2">
                          <span className="text-xs font-medium">{gateName}</span>
                          <span className="text-xs text-text-tertiary">{gateData.length} evaluations</span>
                        </div>
                        <div className="flex items-end gap-0.5 h-16">
                          {gateData.map((d, i) => {
                            const score = parseFloat(d.avg_score);
                            const h = Math.max((score / maxScore) * 100, 2);
                            const isFail = d.result === "failed";
                            return (
                              <div
                                key={i}
                                className="flex-1 rounded-t transition-colors"
                                title={d.date + ": " + score + "% (" + d.passed_count + "/" + (d.passed_count + d.failed_count) + " passed)"}
                                style={{
                                  height: h + "%",
                                  backgroundColor: isFail ? "rgba(239,68,68,0.3)" : "rgba(0,217,126,0.3)",
                                }}
                              />
                            );
                          })}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Metric trends */}
            {trends && trends.metric_trends.length > 0 && (
              <div className="mt-6">
                <h3 className="text-sm font-semibold text-text-secondary mb-2">
                  Metric Trends (30 days)
                </h3>
                <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                  {Array.from(new Set(trends.metric_trends.map((t) => t.metric))).map((metric) => {
                    const metricData = trends.metric_trends.filter((t) => t.metric === metric);
                    const latest = metricData[metricData.length - 1];
                    const allPassed = metricData.every((d) => d.passed);
                    const maxVal = Math.max(...metricData.map((d) => d.actual), latest?.threshold || 0, 0.01);
                    return (
                      <div key={metric} className="bg-gray-800/30 rounded p-3">
                        <div className="flex items-center justify-between mb-1">
                          <span className="text-xs font-mono text-text-tertiary">{metric}</span>
                          <span className={allPassed ? "text-green-400" : "text-red-400"}>
                            {allPassed ? "\u2705" : "\u274C"}
                          </span>
                        </div>
                        <p className="text-sm font-mono font-medium">
                          {formatMetricValue(metric, latest?.actual)}
                        </p>
                        <div className="flex items-end gap-px h-8 mt-1">
                          {metricData.slice(-14).map((d, i) => {
                            const h = Math.max((d.actual / maxVal) * 100, 2);
                            return (
                              <div
                                key={i}
                                className="flex-1 rounded-t"
                                style={{
                                  height: h + "%",
                                  backgroundColor: d.passed ? "rgba(0,217,126,0.3)" : "rgba(239,68,68,0.3)",
                                }}
                              />
                            );
                          })}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Raw metrics */}
            {metrics && (
              <div className="mt-6">
                <h3 className="text-sm font-semibold text-text-secondary mb-2">Raw Metrics</h3>
                <div className="grid grid-cols-3 md:grid-cols-5 gap-2">
                  {Object.entries(metrics.metrics || {}).map(([key, value]) => (
                    <div key={key} className="bg-gray-800/30 rounded p-2 text-center">
                      <p className="text-xs text-text-tertiary">{key}</p>
                      <p className="text-sm font-mono">{formatMetricValue(key, value)}</p>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
