"use client";

import useSWR from "swr";
import { fetcher } from "@/lib/api";
import { getActivity } from "@/lib/api";
import { PageHeader, Skeleton, EmptyState } from "@/components/ui";
import { formatDistanceToNow } from "date-fns";
import clsx from "clsx";
import { useState } from "react";

const SOURCE_COLORS: Record<string, string> = {
  ci_heal: "bg-blue-500/10 text-blue-400 border-blue-500/20",
  issue_fix: "bg-purple-500/10 text-purple-400 border-purple-500/20",
  maintainer: "bg-green-500/10 text-green-400 border-green-500/20",
  config_change: "bg-gray-500/10 text-gray-400 border-gray-500/20",
  duplicate: "bg-amber-500/10 text-amber-400 border-amber-500/20",
  merge_queue: "bg-indigo-500/10 text-indigo-400 border-indigo-500/20",
  ai_review: "bg-teal-500/10 text-teal-400 border-teal-500/20",
  enforcement: "bg-red-500/10 text-red-400 border-red-500/20",
  webhook: "bg-slate-500/10 text-slate-400 border-slate-500/20",
};

const SOURCE_ICONS: Record<string, string> = {
  ci_heal: "🔧",
  issue_fix: "🐛",
  maintainer: "🧹",
  config_change: "⚙️",
  duplicate: "📋",
  merge_queue: "🔀",
  ai_review: "🧠",
  enforcement: "🛡",
  webhook: "📡",
};

const SOURCE_LABELS: Record<string, string> = {
  ci_heal: "CI Heal",
  issue_fix: "Issue Fix",
  maintainer: "Maintainer",
  config_change: "Config",
  duplicate: "Duplicate",
  merge_queue: "Merge Queue",
  ai_review: "AI Review",
  enforcement: "Enforcement",
  webhook: "Webhook",
};

const ALL_SOURCES = ["ci_heal", "issue_fix", "maintainer", "config_change", "duplicate", "merge_queue", "ai_review", "enforcement", "webhook"];

export default function ActivityPage() {
  const [activeSource, setActiveSource] = useState<string | null>(null);
  const [page, setPage] = useState(1);

  const params = activeSource
    ? `source=${activeSource}&per_page=25&page=${page}`
    : `per_page=25&page=${page}`;

  const { data, isLoading } = useSWR(
    `/api/activity?${params}`,
    () => getActivity(params),
    { refreshInterval: 15000 }
  );

  const actions = data?.data ?? [];
  const pagination = data?.pagination;

  return (
    <div className="animate-fade-in">
      <PageHeader
        title="Activity"
        subtitle="Unified action feed across all GitWire operations"
      />

      {/* Source filter bar */}
      <div className="px-6 py-3 border-b border-border flex items-center gap-2 overflow-x-auto">
        <button
          onClick={() => { setActiveSource(null); setPage(1); }}
          className={clsx(
            "px-2.5 py-1 text-[10px] font-mono rounded border transition-colors whitespace-nowrap",
            !activeSource
              ? "bg-accent-green/10 text-accent-green border-accent-green/30"
              : "bg-bg-tertiary text-text-tertiary border-border hover:text-text-secondary"
          )}
        >
          All
        </button>
        {ALL_SOURCES.map((s) => (
          <button
            key={s}
            onClick={() => { setActiveSource(activeSource === s ? null : s); setPage(1); }}
            className={clsx(
              "px-2.5 py-1 text-[10px] font-mono rounded border transition-colors whitespace-nowrap",
              activeSource === s
                ? SOURCE_COLORS[s]
                : "bg-bg-tertiary text-text-tertiary border-border hover:text-text-secondary"
            )}
          >
            {SOURCE_ICONS[s]} {SOURCE_LABELS[s]}
          </button>
        ))}
      </div>

      {/* Activity list */}
      <div className="divide-y divide-border">
        {isLoading && [...Array(10)].map((_, i) => (
          <div key={i} className="px-6 py-4"><Skeleton className="h-10" /></div>
        ))}

        {!isLoading && actions.length === 0 && (
          <EmptyState
            icon="◉"
            title="No activity yet"
            body="Actions will appear here as GitWire processes webhooks, triages issues, heals CI, and more."
          />
        )}

        {actions.map((action: any, idx: number) => (
          <div key={`${action.source}-${action.source_id}-${idx}`} className="px-6 py-3 flex items-start gap-3 hover:bg-bg-secondary/50 transition-colors">
            {/* Icon */}
            <div className="mt-0.5 text-sm shrink-0">
              {SOURCE_ICONS[action.source] || "•"}
            </div>

            {/* Content */}
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className={clsx(
                  "px-1.5 py-0.5 text-[9px] font-mono rounded border",
                  SOURCE_COLORS[action.source] || "bg-gray-500/10 text-gray-400 border-gray-500/20"
                )}>
                  {SOURCE_LABELS[action.source] || action.source}
                </span>
                <span className="text-xs font-medium text-text-primary truncate">
                  {action.action_type}
                </span>
                {action.repo && (
                  <span className="text-[10px] font-mono text-text-tertiary truncate">
                    {action.repo}
                  </span>
                )}
              </div>

              <div className="flex items-center gap-3 mt-1">
                {action.target_number && (
                  <span className="text-[10px] font-mono text-text-tertiary">
                    #{action.target_number}
                  </span>
                )}
                {action.detail && (
                  <span className="text-[10px] text-text-tertiary truncate max-w-[400px]">
                    {action.detail}
                  </span>
                )}
              </div>
            </div>

            {/* Status + time */}
            <div className="shrink-0 text-right">
              <span className={clsx(
                "text-[10px] font-mono",
                action.status === "processed" || action.status === "applied" || action.status === "merged" || action.status === "approved"
                  ? "text-accent-green"
                  : action.status === "failed" || action.status === "rejected" || action.status === "open"
                    ? "text-red-400"
                    : "text-text-tertiary"
              )}>
                {action.status}
              </span>
              <div className="text-[9px] text-text-tertiary mt-0.5">
                {action.created_at && formatDistanceToNow(new Date(action.created_at), { addSuffix: true })}
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Pagination */}
      {pagination && pagination.total_pages > 1 && (
        <div className="px-6 py-3 border-t border-border flex items-center justify-between">
          <span className="text-[10px] font-mono text-text-tertiary">
            {pagination.total} actions
          </span>
          <div className="flex gap-2">
            <button
              onClick={() => setPage(Math.max(1, page - 1))}
              disabled={page <= 1}
              className="px-2 py-1 text-[10px] font-mono bg-bg-tertiary rounded border border-border disabled:opacity-30"
            >
              ← Prev
            </button>
            <span className="px-2 py-1 text-[10px] font-mono text-text-tertiary">
              Page {pagination.page} / {pagination.total_pages}
            </span>
            <button
              onClick={() => setPage(Math.min(pagination.total_pages, page + 1))}
              disabled={page >= pagination.total_pages}
              className="px-2 py-1 text-[10px] font-mono bg-bg-tertiary rounded border border-border disabled:opacity-30"
            >
              Next →
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
