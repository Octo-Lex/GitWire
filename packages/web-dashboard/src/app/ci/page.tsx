"use client";

import { ApiItem } from "@/lib/types";

import { useState } from "react";
import useSWR from "swr";

import { fetcher, API, retryRun } from "@/lib/api";
import {
  PageHeader, StatCard, CIBadge, MiniBar,
  Skeleton, EmptyState, FilterPill, Badge,
} from "@/components/ui";
import { formatDistanceToNow } from "date-fns";
import clsx from "clsx";

const CONCLUSIONS = ["All", "failure", "success", "cancelled"];
const HEAL_STATUS = ["All", "healed", "attempted", "failed", "pending"];

export default function CIPage() {
  const [conclusion, setConclusion] = useState("");
  const [healStatus, setHealStatus] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [retrying, setRetrying] = useState<Record<string, boolean>>({});

  const { data: stats } = useSWR(API.ciStats(), fetcher, { refreshInterval: 15000 });

  const qs = new URLSearchParams({ per_page: "20", page: String(page) });
  if (conclusion && conclusion !== "All") qs.set("conclusion", conclusion);
  if (healStatus && healStatus !== "All") qs.set("heal_status", healStatus);
  if (search) qs.set("repo", search);

  const { data, isLoading, mutate } = useSWR(API.ciRuns(qs.toString()), fetcher, {
    refreshInterval: 10000,
    keepPreviousData: true,
  });

  const runs = data?.data ?? [];
  const meta = data?.meta ?? {};

  async function handleRetry(runId: string) {
    setRetrying((r) => ({ ...r, [runId]: true }));
    try {
      await retryRun(runId);
      setTimeout(() => mutate(), 3000);
    } finally {
      setRetrying((r) => ({ ...r, [runId]: false }));
    }
  }

  const healColor: Record<string, string> = {
    healed: "text-accent-purple",
    attempted: "text-accent-amber",
    failed: "text-accent-red",
    pending: "text-text-tertiary",
    skipped: "text-text-tertiary",
  };

  return (
    <div className="animate-fade-in">
      <PageHeader
        title="Self-healing CI"
        subtitle="AI root-cause detection across all workflows"
        actions={
          <input
            type="search"
            placeholder="Filter by repo…"
            value={search}
            onChange={(e) => { setSearch(e.target.value); setPage(1); }}
            className="bg-surface-2 border border-border rounded px-3 py-1.5 text-sm text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent-green/60 w-52 font-mono"
          />
        }
      />

      {/* Stats */}
      <div className="grid grid-cols-5 gap-3 px-6 py-4 border-b border-border">
        <StatCard label="Pass rate (7d)" value={stats?.summary?.pass_rate != null ? `${stats.summary.pass_rate}%` : null} loading={!stats} accent={stats?.summary?.pass_rate >= 90 ? "green" : "amber"} />
        <StatCard label="Total runs" value={stats?.summary?.total_runs} loading={!stats} />
        <StatCard label="Failures" value={stats?.summary?.failed} loading={!stats} accent="red" />
        <StatCard label="Auto-healed" value={stats?.summary?.auto_healed} loading={!stats} accent="purple" />
        <StatCard label="Heal failed" value={stats?.summary?.heal_failed} loading={!stats} accent="amber" />
      </div>

      {/* Failure type breakdown */}
      {stats?.by_failure_type?.length > 0 && (
        <div className="px-6 py-3 border-b border-border">
          <div className="text-[10px] font-mono text-text-tertiary uppercase tracking-wider mb-2">Failure breakdown (7d)</div>
          <div className="flex gap-2 flex-wrap">
            {stats.by_failure_type.map((f: { failure_type: string; count: string | number }) => (
              <button
                key={f.failure_type}
                onClick={() => { setConclusion("failure"); setPage(1); }}
                className="flex items-center gap-1.5 px-2 py-1 bg-surface-2 border border-border rounded text-xs font-mono text-text-secondary hover:border-border-bright transition-colors"
              >
                <span className="text-text-tertiary">{f.failure_type}</span>
                <span className="text-accent-red font-semibold">{f.count}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-6 py-3 border-b border-border">
        <div className="flex gap-1 items-center">
          <span className="text-xs text-text-tertiary font-mono mr-1">status:</span>
          {CONCLUSIONS.map((c) => (
            <FilterPill key={c} active={(conclusion || "All") === c} onClick={() => { setConclusion(c === "All" ? "" : c); setPage(1); }}>
              {c}
            </FilterPill>
          ))}
        </div>
        <div className="w-px h-4 bg-border" />
        <div className="flex gap-1 items-center">
          <span className="text-xs text-text-tertiary font-mono mr-1">heal:</span>
          {HEAL_STATUS.map((h) => (
            <FilterPill key={h} active={(healStatus || "All") === h} onClick={() => { setHealStatus(h === "All" ? "" : h); setPage(1); }}>
              {h}
            </FilterPill>
          ))}
        </div>
      </div>

      {/* Run list */}
      <div className="px-6 py-4">
        <div className="card overflow-hidden">
          {isLoading && (
            <div className="p-4 space-y-3">
              {[...Array(8)].map((_, i) => <Skeleton key={i} className="h-16" />)}
            </div>
          )}
          {!isLoading && !runs.length && (
            <EmptyState icon="⚙" title="No runs found" body="Try adjusting the filters." />
          )}

          {runs.map((run: ApiItem, idx: number) => (
            <div
              key={String(run.id)}
              className={clsx(
                "group flex items-start gap-4 px-4 py-3 hover:bg-surface-2/50 transition-colors",
                idx < runs.length - 1 && "border-b border-border"
              )}
            >
              {/* Left: status strip */}
              <div className={clsx("w-0.5 self-stretch rounded-full flex-shrink-0 mt-1", {
                "bg-accent-green":  run.conclusion === "success",
                "bg-accent-red":    run.conclusion === "failure" && run.heal_status !== "healed",
                "bg-accent-purple": run.heal_status === "healed",
                "bg-accent-amber":  run.heal_status === "attempted" || run.heal_status === "retrying",
                "bg-surface-4":     !run.conclusion,
              })} />

              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-mono text-sm font-medium text-text-primary">{String(run.repo_name)}</span>
                  <span className="text-text-tertiary font-mono text-xs">·</span>
                  <span className="font-mono text-xs text-text-secondary">{String(run.branch)}</span>
                  <CIBadge conclusion={String(run.conclusion ?? "")} healStatus={run.heal_status === "healed" ? "healed" : undefined} />
                </div>

                <div className="flex items-center gap-3 mt-0.5">
                  <span className="text-xs text-text-secondary">{String(run.workflow_name ?? "")}</span>
                  <span className="font-mono text-[10px] text-text-tertiary">{String(run.head_sha ?? "").slice(0, 7)}</span>
                </div>

                {run.heal_root_cause && (
                  <div className={clsx("mt-1.5 text-xs font-mono", healColor[String(run.heal_status)] ?? "text-text-tertiary")}>
                    {run.heal_status === "healed" && "⚡ "}
                    {run.heal_status === "attempted" && "↻ "}
                    {run.heal_status === "failed" && "✗ "}
                    {String(run.heal_root_cause)}
                    {run.heal_failure_type && (
                      <span className="ml-2 text-text-tertiary">· {String(run.heal_failure_type)}</span>
                    )}
                    {run.heal_confidence && (
                      <span className="ml-2 text-text-tertiary opacity-60">{String(run.heal_confidence)} confidence</span>
                    )}
                  </div>
                )}

                <div className="mt-1 text-[10px] text-text-tertiary font-mono">
                  {run.created_at ? formatDistanceToNow(new Date(String(run.created_at)), { addSuffix: true }) : ""}
                </div>
              </div>

              {run.conclusion === "failure" && run.heal_status !== "healed" && (
                <button
                  onClick={() => handleRetry(String(run.id))}
                  disabled={retrying[String(run.id)]}
                  className="btn text-xs opacity-0 group-hover:opacity-100 transition-opacity disabled:opacity-50 flex-shrink-0 mt-0.5"
                >
                  {retrying[String(run.id)] ? "↻ retrying…" : "↻ retry"}
                </button>
              )}
            </div>
          ))}

          {meta.total_pages > 1 && (
            <div className="flex items-center justify-between px-4 py-3 border-t border-border">
              <span className="text-xs text-text-tertiary font-mono">
                {meta.total} runs · page {meta.page}/{meta.total_pages}
              </span>
              <div className="flex gap-2">
                <button className="btn text-xs" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>← prev</button>
                <button className="btn text-xs" disabled={page >= meta.total_pages} onClick={() => setPage((p) => p + 1)}>next →</button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
