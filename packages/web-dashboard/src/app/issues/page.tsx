"use client";

import { ApiItem } from "@/lib/types";

import { useState } from "react";
import useSWR from "swr";

import { fetcher, API } from "@/lib/api";
import {
  PageHeader, StatCard, Badge, PriorityBadge,
  Skeleton, EmptyState, FilterPill,
} from "@/components/ui";
import { formatDistanceToNow } from "date-fns";
import clsx from "clsx";
import { ErrorBoundary } from '@/components/ErrorBoundary';

const PRIORITIES = ["All", "critical", "high", "medium", "low"];
const TYPES = ["All", "bug", "feature", "question", "documentation"];

export default function IssuesPage() {
  const [state, setState] = useState("open");
  const [priority, setPriority] = useState("");
  const [type, setType] = useState("");
  const [stale, setStale] = useState(false);
  const [unassigned, setUnassigned] = useState(false);
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);

  const { data: stats } = useSWR(API.issueStats(), fetcher, { refreshInterval: 30000 });

  const qs = new URLSearchParams({ state, per_page: "25", page: String(page) });
  if (priority && priority !== "All") qs.set("priority", priority);
  if (type && type !== "All") qs.set("type", type);
  if (stale) qs.set("stale", "true");
  if (unassigned) qs.set("unassigned", "true");
  if (search) qs.set("search", search);

  const { data, isLoading } = useSWR(API.issues(qs.toString()), fetcher, {
    refreshInterval: 20000,
    keepPreviousData: true,
  });

  const issues = data?.data ?? [];
  const meta = data?.meta ?? {};

  return (
    <ErrorBoundary>
    <div className="animate-fade-in">
      <PageHeader
        title="Issue triage"
        subtitle="AI-classified across all repositories"
        actions={
          <input
            type="search"
            placeholder="Search issues…"
            value={search}
            onChange={(e) => { setSearch(e.target.value); setPage(1); }}
            className="bg-surface-2 border border-border rounded px-3 py-1.5 text-sm text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent-green/60 w-52 font-mono"
          />
        }
      />

      {/* Stats row */}
      <div className="grid grid-cols-5 gap-3 px-6 py-4 border-b border-border">
        <StatCard label="Open" value={stats?.summary?.total_open} loading={!stats} />
        <StatCard label="Unassigned" value={stats?.summary?.unassigned} loading={!stats} accent="amber" />
        <StatCard label="Critical" value={stats?.summary?.critical} loading={!stats} accent="red" />
        <StatCard label="Bugs" value={stats?.summary?.bugs} loading={!stats} />
        <StatCard label="Stale >14d" value={stats?.summary?.stale} loading={!stats} accent="amber" />
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-6 py-3 border-b border-border">
        <div className="flex gap-1">
          {["open", "closed"].map((s) => (
            <FilterPill key={s} active={state === s} onClick={() => { setState(s); setPage(1); }}>
              {s}
            </FilterPill>
          ))}
        </div>
        <div className="w-px h-4 bg-border" />
        <div className="flex gap-1 items-center">
          <span className="text-xs text-text-tertiary font-mono mr-1">priority:</span>
          {PRIORITIES.map((p) => (
            <FilterPill key={p} active={(priority || "All") === p} onClick={() => { setPriority(p === "All" ? "" : p); setPage(1); }}>
              {p}
            </FilterPill>
          ))}
        </div>
        <div className="w-px h-4 bg-border" />
        <div className="flex gap-1 items-center">
          <span className="text-xs text-text-tertiary font-mono mr-1">type:</span>
          {TYPES.map((t) => (
            <FilterPill key={t} active={(type || "All") === t} onClick={() => { setType(t === "All" ? "" : t); setPage(1); }}>
              {t}
            </FilterPill>
          ))}
        </div>
        <div className="w-px h-4 bg-border" />
        <FilterPill active={unassigned} onClick={() => { setUnassigned((v) => !v); setPage(1); }}>unassigned</FilterPill>
        <FilterPill active={stale} onClick={() => { setStale((v) => !v); setPage(1); }}>stale</FilterPill>
      </div>

      {/* Issue list */}
      <div className="px-6 py-4">
        <div className="card overflow-hidden">
          {isLoading && (
            <div className="p-4 space-y-3">
              {[...Array(8)].map((_, i) => <Skeleton key={i} className="h-14" />)}
            </div>
          )}
          {!isLoading && !issues.length && (
            <EmptyState icon="◎" title="No issues match" body="Try adjusting filters." />
          )}
          {issues.map((issue: ApiItem, idx: number) => (
            <div
              key={String(issue.github_id)}
              className={clsx(
                "flex items-start gap-4 px-4 py-3 hover:bg-surface-2/50 transition-colors",
                idx < issues.length - 1 && "border-b border-border"
              )}
            >
              <div className={clsx("w-0.5 self-stretch rounded-full flex-shrink-0 mt-1", {
                "bg-accent-red":   issue.triage_priority === "critical",
                "bg-accent-amber": issue.triage_priority === "high",
                "bg-accent-blue":  issue.triage_priority === "medium",
                "bg-surface-4":    !issue.triage_priority || issue.triage_priority === "low",
              })} />

              <div className="flex-1 min-w-0">
                <div className="flex items-start gap-2 flex-wrap">
                  <span className="text-sm font-medium text-text-primary leading-snug">{String(issue.title)}</span>
                  {issue.triage_type && (
                    <Badge variant={String(issue.triage_type) === "bug" ? "red" : String(issue.triage_type) === "feature" ? "blue" : "default"}>
                      {String(issue.triage_type)}
                    </Badge>
                  )}
                  <PriorityBadge priority={issue.triage_priority as string | null | undefined} />
                  {Array.isArray(issue.assignees) && issue.assignees.length === 0 && (
                    <Badge variant="amber">unassigned</Badge>
                  )}
                </div>

                {issue.triage_summary && (
                  <p className="text-xs text-text-tertiary mt-1 leading-relaxed line-clamp-1">
                    {String(issue.triage_summary)}
                  </p>
                )}

                <div className="flex items-center gap-3 mt-1.5 flex-wrap">
                  <span className="font-mono text-[11px] text-text-tertiary">
                    {String(issue.repo_full_name)}#{String(issue.number)}
                  </span>
                  {Array.isArray(issue.labels) && (issue.labels as string[]).map((l: string) => (
                    <span key={l} className="font-mono text-[10px] text-text-tertiary border border-border rounded px-1.5 py-0.5">
                      {l}
                    </span>
                  ))}
                  <span className="text-[11px] text-text-tertiary">
                    {issue.created_at ? formatDistanceToNow(new Date(String(issue.created_at)), { addSuffix: true }) : ""}
                  </span>
                  {issue.triaged_at && (
                    <span className="text-[10px] text-accent-green/70 font-mono">✓ triaged</span>
                  )}
                </div>
              </div>

              {Array.isArray(issue.assignees) && issue.assignees.length > 0 && (
                <div className="flex -space-x-1 flex-shrink-0">
                  {(issue.assignees as string[]).slice(0, 3).map((a: string) => (
                    <div key={a} className="w-6 h-6 rounded-full bg-surface-4 border border-surface-1 flex items-center justify-center text-[9px] font-mono text-text-secondary uppercase">
                      {a[0]}
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}

          {meta.total_pages > 1 && (
            <div className="flex items-center justify-between px-4 py-3 border-t border-border">
              <span className="text-xs text-text-tertiary font-mono">
                {meta.total} issues · page {meta.page}/{meta.total_pages}
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
    </ErrorBoundary>
  );
}
