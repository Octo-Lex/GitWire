"use client";

import { useState } from "react";
import useSWR from "swr";
import { fetcher } from "@/lib/api";
import {
  Badge,
  StatCard,
  EmptyState,
  PageHeader,
} from "@/components/ui";

const STATUS_COLORS: Record<string, string> = {
  proposed: "bg-yellow-900/50 text-yellow-300",
  approved: "bg-blue-900/50 text-blue-300",
  executing: "bg-purple-900/50 text-purple-300",
  succeeded: "bg-green-900/50 text-green-300",
  failed: "bg-red-900/50 text-red-300",
  retrying: "bg-orange-900/50 text-orange-300",
  cancelled: "bg-gray-700/50 text-gray-400",
  reconciled: "bg-emerald-900/50 text-emerald-300",
};

const STATUS_ICONS: Record<string, string> = {
  proposed: "💡",
  approved: "✅",
  executing: "⚡",
  succeeded: "✅",
  failed: "❌",
  retrying: "🔄",
  cancelled: "🚫",
  reconciled: "🔒",
};

const PILLAR_OPTIONS = [
  "triage",
  "ci_healing",
  "contributor_fix",
  "review_gate",
  "merge_queue",
  "enforcement",
  "maintainer",
  "trust",
  "insights",
];

const ACTION_TYPE_OPTIONS = [
  "add-label",
  "add-comment",
  "create-pr",
  "commit-patch",
  "merge-pr",
  "close-issue",
  "close-pr",
];

export default function ActionsPage() {
  const [statusFilter, setStatusFilter] = useState<string>("");
  const [pillarFilter, setPillarFilter] = useState<string>("");
  const [actionTypeFilter, setActionTypeFilter] = useState<string>("");
  const [repoFilter, setRepoFilter] = useState<string>("");

  const params = new URLSearchParams();
  if (statusFilter) params.set("status", statusFilter);
  if (pillarFilter) params.set("pillar", pillarFilter);
  if (actionTypeFilter) params.set("action_type", actionTypeFilter);
  if (repoFilter) params.set("repo", repoFilter);
  params.set("limit", "100");

  const { data: reposData } = useSWR<{ data: Array<{ full_name: string }> }>(
    "/api/repos?limit=100",
    fetcher
  );

  const { data: summary } = useSWR<{ summary: Array<{ status: string; count: number }> }>(
    "/api/actions/summary",
    fetcher
  );

  const { data: actions, error: actionsError, isLoading: actionsLoading } = useSWR<{
    data: Array<{
      id: number;
      repo_full_name: string;
      pillar: string;
      action_type: string;
      source: string;
      status: string;
      proposed_at: string;
      resolved_at: string;
      retries: number;
      error_message: string | null;
      evidence: Record<string, unknown>;
    }>;
    meta: { total: number };
  }>("/api/actions?" + params.toString(), fetcher);

  const rows = actions?.data ?? [];
  const stats = summary?.summary ?? [];

  const totalCount = stats.reduce((sum, s) => sum + s.count, 0);
  const failedCount = stats.find((s) => s.status === "failed")?.count || 0;
  const pendingCount = (stats.find((s) => s.status === "proposed")?.count || 0) +
    (stats.find((s) => s.status === "approved")?.count || 0) +
    (stats.find((s) => s.status === "executing")?.count || 0);
  const reconciledCount = stats.find((s) => s.status === "reconciled")?.count || 0;

  const hasActiveFilters = statusFilter || pillarFilter || actionTypeFilter || repoFilter;

  return (
    <div>
      <PageHeader title="Actions" subtitle="Action lifecycle — every GitWire mutation tracked from proposal to reconciliation" actions={
        <div className="flex gap-2">
          <button
            onClick={() => {
              const p = new URLSearchParams();
              if (repoFilter) p.set("repo", repoFilter);
              if (pillarFilter) p.set("pillar", pillarFilter);
              p.set("format", "json");
              window.open("/api/audit-bundles/export?" + p.toString(), "_blank");
            }}
            className="px-3 py-1.5 text-xs font-mono rounded border border-border bg-surface-2 text-text-secondary hover:border-text-tertiary transition-colors"
          >
            Export JSON
          </button>
        </div>
      } />

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 px-6 py-4 border-b border-border">
        <StatCard label="Total Actions" value={totalCount} />
        <StatCard label="Pending" value={pendingCount} accent="blue" />
        <StatCard label="Failed" value={failedCount} accent={failedCount > 0 ? "red" : undefined} />
        <StatCard label="Reconciled" value={reconciledCount} />
      </div>

      {/* Filters */}
      <div className="px-6 py-3 flex gap-2 flex-wrap items-center border-b border-border">
        <select
          className="bg-surface-2 border border-border rounded px-2 py-1 text-xs text-text-primary"
          value={repoFilter}
          onChange={(e) => setRepoFilter(e.target.value)}
        >
          <option value="">All Repos</option>
          {(reposData?.data ?? []).map((r) => (
            <option key={r.full_name} value={r.full_name}>{r.full_name}</option>
          ))}
        </select>
        <select
          className="bg-surface-2 border border-border rounded px-2 py-1 text-xs text-text-primary"
          value={pillarFilter}
          onChange={(e) => setPillarFilter(e.target.value)}
        >
          <option value="">All Pillars</option>
          {PILLAR_OPTIONS.map((p) => (
            <option key={p} value={p}>{p}</option>
          ))}
        </select>
        <select
          className="bg-surface-2 border border-border rounded px-2 py-1 text-xs text-text-primary"
          value={actionTypeFilter}
          onChange={(e) => setActionTypeFilter(e.target.value)}
        >
          <option value="">All Types</option>
          {ACTION_TYPE_OPTIONS.map((t) => (
            <option key={t} value={t}>{t}</option>
          ))}
        </select>
        <button
          className={"px-3 py-1 rounded-full text-xs " + (!statusFilter ? "bg-accent-green/20 text-accent-green" : "bg-gray-700 text-gray-400")}
          onClick={() => setStatusFilter("")}
        >
          All ({totalCount})
        </button>
        {stats.map((s) => (
          <button
            key={s.status}
            className={"px-3 py-1 rounded-full text-xs " + (statusFilter === s.status ? "bg-accent-green/20 text-accent-green" : "bg-gray-700 text-gray-400")}
            onClick={() => setStatusFilter(statusFilter === s.status ? "" : s.status)}
          >
            {STATUS_ICONS[s.status] || "•"} {s.status} ({s.count})
          </button>
        ))}
        {hasActiveFilters && (
          <button
            className="px-3 py-1 rounded-full text-xs bg-red-900/30 text-red-400 hover:bg-red-900/50"
            onClick={() => { setStatusFilter(""); setPillarFilter(""); setActionTypeFilter(""); setRepoFilter(""); }}
          >
            Clear filters
          </button>
        )}
      </div>

      {/* Actions table */}
      <div className="px-6 py-4">
        {actionsLoading ? (
          <div className="space-y-2">
            {[1,2,3,4,5].map((i) => (
              <div key={i} className="rounded shimmer h-10" />
            ))}
          </div>
        ) : actionsError ? (
          <div className="p-6 text-center">
            <div className="text-red-400 text-sm mb-2">Failed to load actions</div>
            <button
              className="text-xs text-accent-green hover:underline"
              onClick={() => window.location.reload()}
            >
              Retry
            </button>
          </div>
        ) : rows.length === 0 ? (
          <EmptyState
            title={hasActiveFilters ? "No actions match your filters" : "No actions found"}
            body={hasActiveFilters
              ? "Try adjusting or clearing your filters"
              : "Actions appear when GitWire takes or proposes mutations on your repositories"}
          />
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-[10px] font-mono text-text-tertiary uppercase tracking-wider">
                <th className="text-left px-3 py-2">ID</th>
                <th className="text-left px-3 py-2">Status</th>
                <th className="text-left px-3 py-2">Repo</th>
                <th className="text-left px-3 py-2">Pillar</th>
                <th className="text-left px-3 py-2">Action</th>
                <th className="text-left px-3 py-2">Source</th>
                <th className="text-left px-3 py-2">Time</th>
                <th className="text-left px-3 py-2">Retries</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((a) => (
                <tr key={a.id} className="border-b border-border/50 hover:bg-surface-2/40">
                  <td className="px-3 py-2 text-xs font-mono text-text-tertiary">
                    <a href={`/actions/${a.id}`} className="text-accent-green hover:underline">{a.id}</a>
                  </td>
                  <td className="px-3 py-2">
                    <Badge className={STATUS_COLORS[a.status] || "bg-gray-700 text-gray-400"}>
                      {STATUS_ICONS[a.status]} {a.status}
                    </Badge>
                  </td>
                  <td className="px-3 py-2 text-xs font-mono">{a.repo_full_name}</td>
                  <td className="px-3 py-2 text-xs text-text-secondary">{a.pillar}</td>
                  <td className="px-3 py-2 text-xs font-mono">{a.action_type}</td>
                  <td className="px-3 py-2 text-xs text-text-tertiary">{a.source}</td>
                  <td className="px-3 py-2 text-xs text-text-tertiary whitespace-nowrap">
                    {a.proposed_at ? new Date(a.proposed_at).toLocaleString() : "—"}
                  </td>
                  <td className="px-3 py-2 text-xs text-center">
                    {a.retries > 0 ? (
                      <span className="text-orange-400">{a.retries}/3</span>
                    ) : <span>0</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
