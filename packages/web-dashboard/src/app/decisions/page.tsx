"use client";

import useSWR from "swr";
import { fetcher, API } from "@/lib/api";
import {
  PageHeader, StatCard, Badge, Skeleton, EmptyState,
} from "@/components/ui";
import { formatDistanceToNow } from "date-fns";
import Link from "next/link";
import { useState } from "react";

const SOURCE_COLORS: Record<string, string> = {
  ci_heal: "bg-blue-500/10 text-blue-400 border-blue-500/20",
  triage: "bg-purple-500/10 text-purple-400 border-purple-500/20",
  ai_review: "bg-green-500/10 text-green-400 border-green-500/20",
  issue_fix: "bg-amber-500/10 text-amber-400 border-amber-500/20",
  merge_queue: "bg-cyan-500/10 text-cyan-400 border-cyan-500/20",
  enforcement: "bg-red-500/10 text-red-400 border-red-500/20",
  trust: "bg-pink-500/10 text-pink-400 border-pink-500/20",
};

const DECISION_STYLES: Record<string, string> = {
  acted: "bg-green-500/10 text-green-400 border-green-500/20",
  skipped: "bg-gray-500/10 text-gray-400 border-gray-500/20",
  dry_run: "bg-yellow-500/10 text-yellow-400 border-yellow-500/20",
  blocked: "bg-red-500/10 text-red-400 border-red-500/20",
  error: "bg-red-500/10 text-red-400 border-red-500/20",
};

export default function DecisionsPage() {
  const [sourceFilter, setSourceFilter] = useState<string>("");
  const [decisionFilter, setDecisionFilter] = useState<string>("");
  const [repoFilter, setRepoFilter] = useState<string>("");
  const [page, setPage] = useState(1);

  const params = new URLSearchParams();
  if (sourceFilter) params.set("source", sourceFilter);
  if (decisionFilter) params.set("decision", decisionFilter);
  if (repoFilter) params.set("repo", repoFilter);
  params.set("per_page", "25");
  params.set("page", String(page));

  const { data: reposData } = useSWR<{ data: Array<{ full_name: string }> }>(
    "/api/repos?limit=100",
    fetcher
  );

  const { data, isLoading } = useSWR(API.decisions(params.toString()), fetcher, { refreshInterval: 15000 });
  const { data: summary } = useSWR(API.decisionsSummary(), fetcher, { refreshInterval: 30000 });

  const decisions = data?.data ?? [];
  const meta = data?.meta ?? { total: 0, page: 1, totalPages: 1 };

  const actedCount = summary?.data?.filter((s: any) => s.decision === "acted").reduce((acc: number, s: any) => acc + Number(s.count), 0) ?? 0;
  const skippedCount = summary?.data?.filter((s: any) => s.decision === "skipped").reduce((acc: number, s: any) => acc + Number(s.count), 0) ?? 0;
  const dryRunCount = summary?.data?.filter((s: any) => s.decision === "dry_run").reduce((acc: number, s: any) => acc + Number(s.count), 0) ?? 0;
  const blockedCount = summary?.data?.filter((s: any) => s.decision === "blocked").reduce((acc: number, s: any) => acc + Number(s.count), 0) ?? 0;

  return (
    <div className="animate-fade-in">
      <PageHeader
        title="Decisions"
        subtitle="Why GitWire acted — or chose not to"
      />

      {/* Stats */}
      <div className="grid grid-cols-4 gap-3 px-6 py-4 border-b border-border">
        <StatCard label="Actions taken" value={actedCount} loading={!summary} accent="green" />
        <StatCard label="Skipped" value={skippedCount} loading={!summary} />
        <StatCard label="Dry runs" value={dryRunCount} loading={!summary} accent="yellow" />
        <StatCard label="Blocked" value={blockedCount} loading={!summary} accent="red" />
      </div>

      {/* Filters */}
      <div className="flex gap-2 px-6 py-3 border-b border-border items-center flex-wrap">
        <select
          className="bg-surface-2 border border-border rounded px-2 py-1 text-xs text-text-primary"
          value={repoFilter}
          onChange={(e) => { setRepoFilter(e.target.value); setPage(1); }}
        >
          <option value="">All Repos</option>
          {(reposData?.data ?? []).map((r) => (
            <option key={r.full_name} value={r.full_name}>{r.full_name}</option>
          ))}
        </select>
        <span className="text-[10px] font-mono text-text-tertiary uppercase tracking-wider mr-2">Source</span>
        {["", "ci_heal", "triage", "ai_review", "issue_fix", "merge_queue", "enforcement", "trust"].map((s) => (
          <button
            key={s}
            onClick={() => { setSourceFilter(s); setPage(1); }}
            className={"text-[11px] px-2 py-1 rounded border transition-colors " +
              (sourceFilter === s
                ? "bg-accent-primary/20 text-accent-primary border-accent-primary/30"
                : "bg-surface-2 text-text-secondary border-border hover:border-text-tertiary")}
          >
            {s || "All"}
          </button>
        ))}
        <span className="text-[10px] font-mono text-text-tertiary uppercase tracking-wider ml-4 mr-2">Decision</span>
        {["", "acted", "skipped", "dry_run", "blocked"].map((d) => (
          <button
            key={d}
            onClick={() => { setDecisionFilter(d); setPage(1); }}
            className={"text-[11px] px-2 py-1 rounded border transition-colors " +
              (decisionFilter === d
                ? "bg-accent-primary/20 text-accent-primary border-accent-primary/30"
                : "bg-surface-2 text-text-secondary border-border hover:border-text-tertiary")}
          >
            {d || "All"}
          </button>
        ))}
      </div>

      {/* Decision list */}
      <div className="divide-y divide-border">
        {isLoading && Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="px-6 py-3">
            <Skeleton className="h-4 w-3/4" />
          </div>
        ))}

        {!isLoading && decisions.length === 0 && (
          <EmptyState title="No decisions recorded yet" />
        )}

        {!isLoading && decisions.map((d: any) => (
          <div key={d.id} className="px-6 py-3 hover:bg-surface-2/50 transition-colors">
            <div className="flex items-center gap-3">
              {/* Source badge */}
              <span className={"text-[10px] font-mono px-2 py-0.5 rounded border " +
                (SOURCE_COLORS[d.source] || "bg-gray-500/10 text-gray-400 border-gray-500/20")}>
                {d.source}
              </span>

              {/* Decision badge */}
              <span className={"text-[10px] font-mono px-2 py-0.5 rounded border " +
                (DECISION_STYLES[d.decision] || "bg-gray-500/10 text-gray-400 border-gray-500/20")}>
                {d.decision}
              </span>

              {/* Target */}
              <span className="text-xs text-text-secondary">
                {d.target_type}#{d.target_number}
              </span>

              {/* Reason */}
              <span className="text-xs text-text-primary truncate flex-1">
                {d.reason || "—"}
              </span>

              {/* Time */}
              <span className="text-[10px] text-text-tertiary whitespace-nowrap">
                {formatDistanceToNow(new Date(d.created_at), { addSuffix: true })}
              </span>
            </div>

            {/* Conditions (collapsed) */}
            {d.conditions && Array.isArray(d.conditions) && d.conditions.length > 0 && (
              <div className="mt-1.5 ml-2 flex flex-wrap gap-1.5">
                {d.conditions.map((c: any, i: number) => (
                  <span
                    key={i}
                    className={"text-[10px] font-mono px-1.5 py-0.5 rounded " +
                      (c.result
                        ? "bg-green-500/5 text-green-500/70"
                        : "bg-red-500/5 text-red-500/70")}
                  >
                    {c.result ? "✓" : "✗"} {c.check}
                  </span>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Pagination */}
      {meta.totalPages > 1 && (
        <div className="flex items-center justify-between px-6 py-3 border-t border-border">
          <span className="text-[10px] text-text-tertiary">
            {meta.total} decisions · page {meta.page} of {meta.totalPages}
          </span>
          <div className="flex gap-2">
            <button
              onClick={() => setPage(Math.max(1, page - 1))}
              disabled={page <= 1}
              className="text-[11px] px-3 py-1 rounded border border-border bg-surface-2 text-text-secondary disabled:opacity-40"
            >
              Previous
            </button>
            <button
              onClick={() => setPage(Math.min(meta.totalPages, page + 1))}
              disabled={page >= meta.totalPages}
              className="text-[11px] px-3 py-1 rounded border border-border bg-surface-2 text-text-secondary disabled:opacity-40"
            >
              Next
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
