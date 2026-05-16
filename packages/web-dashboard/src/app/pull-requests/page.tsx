"use client";

import { ApiItem } from "@/lib/types";

import { useState } from "react";
import useSWR from "swr";

import { fetcher, API } from "@/lib/api";
import {
  PageHeader, StatCard, Badge,
  Skeleton, EmptyState, FilterPill,
} from "@/components/ui";
import { formatDistanceToNow } from "date-fns";
import clsx from "clsx";

const SIZES = ["All", "size/XS", "size/S", "size/M", "size/L", "size/XL"];
const RISKS = ["All", "low", "medium", "high"];
const TYPES = ["All", "feature", "bugfix", "refactor", "chore", "docs", "test"];

export default function PullRequestsPage() {
  const [state, setState] = useState("open");
  const [size, setSize] = useState("");
  const [risk, setRisk] = useState("");
  const [type, setType] = useState("");
  const [draft, setDraft] = useState<boolean | null>(null);
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);

  const { data: stats } = useSWR(API.prStats(), fetcher, { refreshInterval: 30000 });

  const qs = new URLSearchParams({ state, per_page: "25", page: String(page) });
  if (size && size !== "All") qs.set("size", size);
  if (risk && risk !== "All") qs.set("risk", risk);
  if (type && type !== "All") qs.set("type", type);
  if (draft !== null) qs.set("draft", String(draft));
  if (search) qs.set("search", search);

  const { data, isLoading } = useSWR(API.prs(qs.toString()), fetcher, {
    refreshInterval: 20000,
    keepPreviousData: true,
  });

  const prs = data?.data ?? [];
  const meta = data?.meta ?? {};

  const sizeColor: Record<string, string> = {
    "size/XS": "green", "size/S": "green",
    "size/M": "blue",
    "size/L": "amber", "size/XL": "red",
  };

  return (
    <div className="animate-fade-in">
      <PageHeader
        title="Pull requests"
        subtitle="AI-triaged across all repositories"
        actions={
          <input
            type="search"
            placeholder="Search PRs…"
            value={search}
            onChange={(e) => { setSearch(e.target.value); setPage(1); }}
            className="bg-surface-2 border border-border rounded px-3 py-1.5 text-sm text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent-green/60 w-52 font-mono"
          />
        }
      />

      {/* Stats */}
      <div className="grid grid-cols-4 gap-3 px-6 py-4 border-b border-border">
        <StatCard label="Open" value={stats?.summary?.total_open} loading={!stats} />
        <StatCard label="Draft" value={stats?.summary?.draft} loading={!stats} accent="amber" />
        <StatCard label="Ready" value={stats?.summary?.ready_for_review} loading={!stats} accent="green" />
        <StatCard label="High risk" value={stats?.summary?.high_risk} loading={!stats} accent="red" />
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-6 py-3 border-b border-border">
        <div className="flex gap-1">
          {["open", "closed", "merged"].map((s) => (
            <FilterPill key={s} active={state === s} onClick={() => { setState(s); setPage(1); }}>
              {s}
            </FilterPill>
          ))}
        </div>
        <div className="w-px h-4 bg-border" />
        <div className="flex gap-1 items-center">
          <span className="text-xs text-text-tertiary font-mono mr-1">size:</span>
          {SIZES.map((s) => (
            <FilterPill key={s} active={(size || "All") === s} onClick={() => { setSize(s === "All" ? "" : s); setPage(1); }}>
              {s}
            </FilterPill>
          ))}
        </div>
        <div className="w-px h-4 bg-border" />
        <div className="flex gap-1 items-center">
          <span className="text-xs text-text-tertiary font-mono mr-1">risk:</span>
          {RISKS.map((r) => (
            <FilterPill key={r} active={(risk || "All") === r} onClick={() => { setRisk(r === "All" ? "" : r); setPage(1); }}>
              {r}
            </FilterPill>
          ))}
        </div>
        <div className="w-px h-4 bg-border" />
        <FilterPill active={draft === false} onClick={() => setDraft(draft === false ? null : false)}>ready only</FilterPill>
        <FilterPill active={draft === true} onClick={() => setDraft(draft === true ? null : true)}>drafts only</FilterPill>
      </div>

      {/* PR list */}
      <div className="px-6 py-4">
        <div className="card overflow-hidden">
          {isLoading && (
            <div className="p-4 space-y-3">
              {[...Array(8)].map((_, i) => <Skeleton key={i} className="h-16" />)}
            </div>
          )}
          {!isLoading && !prs.length && (
            <EmptyState icon="⌥" title="No pull requests match" body="Try adjusting the filters." />
          )}

          {prs.map((pr: ApiItem, idx: number) => (
            <div
              key={String(pr.github_id)}
              className={clsx(
                "flex items-start gap-4 px-4 py-3 hover:bg-surface-2/50 transition-colors",
                idx < prs.length - 1 && "border-b border-border"
              )}
            >
              <div className={clsx("w-0.5 self-stretch rounded-full flex-shrink-0 mt-1", {
                "bg-accent-red":   pr.triage_risk === "high",
                "bg-accent-amber": pr.triage_risk === "medium",
                "bg-surface-4":    !pr.triage_risk || pr.triage_risk === "low",
              })} />

              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  {pr.draft && <Badge variant="default">draft</Badge>}
                  <span className="text-sm font-medium text-text-primary leading-snug">{String(pr.title)}</span>
                  {pr.triage_type && (
                    <Badge variant={String(pr.triage_type) === "bugfix" ? "red" : String(pr.triage_type) === "feature" ? "blue" : "default"}>
                      {String(pr.triage_type)}
                    </Badge>
                  )}
                  {pr.triage_size && (
                    <Badge variant={sizeColor[String(pr.triage_size)] ?? "default"}>{String(pr.triage_size)}</Badge>
                  )}
                  {pr.triage_risk === "high" && <Badge variant="red">high risk</Badge>}
                </div>

                {pr.triage_summary && (
                  <p className="text-xs text-text-tertiary mt-1 leading-relaxed line-clamp-1">{String(pr.triage_summary)}</p>
                )}

                <div className="flex items-center gap-3 mt-1.5 flex-wrap">
                  <span className="font-mono text-[11px] text-text-tertiary">
                    {String(pr.repo_full_name)}#{String(pr.number)}
                  </span>
                  <span className="font-mono text-[11px] text-text-tertiary">
                    {String(pr.head_branch ?? "")} → {String(pr.base_branch ?? "")}
                  </span>
                  {Array.isArray(pr.labels) && (pr.labels as string[]).map((l: string) => (
                    <span key={l} className="font-mono text-[10px] text-text-tertiary border border-border rounded px-1.5 py-0.5">
                      {l}
                    </span>
                  ))}
                  <span className="text-[11px] text-text-tertiary">
                    {pr.created_at ? formatDistanceToNow(new Date(String(pr.created_at)), { addSuffix: true }) : ""}
                  </span>
                  {pr.triaged_at && (
                    <span className="text-[10px] text-accent-green/70 font-mono">✓ triaged</span>
                  )}
                </div>
              </div>
            </div>
          ))}

          {meta.total_pages > 1 && (
            <div className="flex items-center justify-between px-4 py-3 border-t border-border">
              <span className="text-xs text-text-tertiary font-mono">
                {meta.total} PRs · page {meta.page}/{meta.total_pages}
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
