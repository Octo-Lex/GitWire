"use client";

import useSWR from "swr";
import { fetcher, API } from "@/lib/api";
import {
  PageHeader, StatCard, Skeleton, EmptyState,
} from "@/components/ui";
import { formatDistanceToNow } from "date-fns";
import Link from "next/link";
import { useState } from "react";

/**
 * Export current view as audit bundle (decision=dry_run pinned)
 */
function exportAuditBundle(params: URLSearchParams, format: string) {
  const exportParams = new URLSearchParams(params);
  exportParams.delete("per_page");
  exportParams.delete("page");
  exportParams.set("format", format);
  const url = "/api/audit-bundles/export?" + exportParams.toString();
  window.open(url, "_blank");
}

/**
 * Dry-Run Proof View
 *
 * Shows decisions where GitWire would have acted but did NOT mutate GitHub
 * because dry-run mode was active. This is safety-critical evidence:
 * the UI must never imply an action was executed.
 *
 * Data source: decision_log WHERE decision = 'dry_run'
 * The decision field is pinned server-side; operators cannot see
 * executed actions here.
 */

const SOURCE_COLORS: Record<string, string> = {
  ci_heal: "bg-blue-500/10 text-blue-400 border-blue-500/20",
  triage: "bg-purple-500/10 text-purple-400 border-purple-500/20",
  ai_review: "bg-green-500/10 text-green-400 border-green-500/20",
  issue_fix: "bg-amber-500/10 text-amber-400 border-amber-500/20",
  merge_queue: "bg-cyan-500/10 text-cyan-400 border-cyan-500/20",
  enforcement: "bg-red-500/10 text-red-400 border-red-500/20",
  trust: "bg-pink-500/10 text-pink-400 border-pink-500/20",
};

const PILLAR_OPTIONS = [
  "triage", "ci_healing", "contributor_fix", "review_gate",
  "merge_queue", "enforcement", "maintainer", "trust", "insights",
];

export default function DryRunProofPage() {
  const [repoFilter, setRepoFilter] = useState<string>("");
  const [pillarFilter, setPillarFilter] = useState<string>("");
  const [sourceFilter, setSourceFilter] = useState<string>("");
  const [targetTypeFilter, setTargetTypeFilter] = useState<string>("");
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [fromDate, setFromDate] = useState<string>("");
  const [toDate, setToDate] = useState<string>("");
  const [page, setPage] = useState(1);
  const [expandedId, setExpandedId] = useState<number | null>(null);

  // Build query params — decision=dry_run is ALWAYS pinned
  const params = new URLSearchParams();
  params.set("decision", "dry_run");
  params.set("per_page", "25");
  params.set("page", String(page));
  if (repoFilter) params.set("repo", repoFilter);
  if (pillarFilter) params.set("pillar", pillarFilter);
  if (sourceFilter) params.set("source", sourceFilter);
  if (targetTypeFilter) params.set("target_type", targetTypeFilter);
  if (searchQuery.trim()) params.set("q", searchQuery.trim());
  if (fromDate) params.set("from", fromDate);
  if (toDate) params.set("to", toDate);

  const { data: reposData } = useSWR<{ data: Array<{ full_name: string }> }>(
    "/api/repos?limit=100", fetcher, { refreshInterval: 60000 }
  );

  const { data, isLoading, error: proofError } = useSWR(
    API.decisions(params.toString()), fetcher, { refreshInterval: 15000 }
  );
  const { data: summary } = useSWR(API.decisionsSummary(), fetcher, { refreshInterval: 30000 });

  const proofs = data?.data ?? [];
  const meta = data?.meta ?? { total: 0, page: 1, totalPages: 1 };

  const dryRunTotal = summary?.data
    ?.filter((s: any) => s.decision === "dry_run")
    .reduce((acc: number, s: any) => acc + Number(s.count), 0) ?? 0;
  const dryRunSources = summary?.data
    ?.filter((s: any) => s.decision === "dry_run")
    .length ?? 0;
  const dryRunRepos = new Set(proofs.map((p: any) => p.repo)).size;

  const hasActiveFilters = repoFilter || pillarFilter || sourceFilter || targetTypeFilter || searchQuery.trim() || fromDate || toDate;

  function clearFilters() {
    setRepoFilter(""); setPillarFilter(""); setSourceFilter("");
    setTargetTypeFilter(""); setSearchQuery(""); setFromDate(""); setToDate("");
    setPage(1);
  }

  return (
    <div className="animate-fade-in">
      <PageHeader
        title="Dry-Run Proof"
        subtitle="What GitWire would have done — evidence of non-mutating evaluations"
        actions={
          <div className="flex gap-2">
            <button
              onClick={() => exportAuditBundle(params, "json")}
              className="px-3 py-1.5 text-xs font-mono rounded border border-border bg-surface-2 text-text-secondary hover:border-text-tertiary transition-colors"
            >
              Export JSON
            </button>
            <button
              onClick={() => exportAuditBundle(params, "markdown")}
              className="px-3 py-1.5 text-xs font-mono rounded border border-border bg-surface-2 text-text-secondary hover:border-text-tertiary transition-colors"
            >
              Export MD
            </button>
          </div>
        }
      />

      {/* Safety banner */}
      <div className="mx-6 mt-4 rounded-lg border border-amber-500/30 bg-amber-500/5 px-4 py-2 flex items-center gap-2">
        <span className="text-amber-400 text-sm">[SAFE]</span>
        <span className="text-amber-400/80 text-xs">
          These evaluations did not mutate GitHub. The decision field is pinned to dry-run.
        </span>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-3 px-6 py-4 border-b border-border">
        <StatCard label="Dry-run proofs recorded" value={dryRunTotal} loading={!summary} accent="yellow" />
        <StatCard label="Sources producing proofs" value={dryRunSources} loading={!summary} />
        <StatCard label="Repos in current view" value={dryRunRepos} loading={!summary} />
      </div>

      {/* Filters */}
      <div className="flex gap-2 px-6 py-3 border-b border-border items-center flex-wrap">
        <input
          type="text"
          placeholder="Search planned action..."
          value={searchQuery}
          onChange={(e) => { setSearchQuery(e.target.value); setPage(1); }}
          className="bg-surface-2 border border-border rounded px-3 py-1 text-xs text-text-primary w-52"
        />
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
        <select
          className="bg-surface-2 border border-border rounded px-2 py-1 text-xs text-text-primary"
          value={pillarFilter}
          onChange={(e) => { setPillarFilter(e.target.value); setPage(1); }}
        >
          <option value="">All Pillars</option>
          {PILLAR_OPTIONS.map((p) => (
            <option key={p} value={p}>{p}</option>
          ))}
        </select>
        <select
          className="bg-surface-2 border border-border rounded px-2 py-1 text-xs text-text-primary"
          value={sourceFilter}
          onChange={(e) => { setSourceFilter(e.target.value); setPage(1); }}
        >
          <option value="">All Sources</option>
          {["ci_heal", "triage", "ai_review", "issue_fix", "merge_queue", "enforcement", "trust"].map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
        <select
          className="bg-surface-2 border border-border rounded px-2 py-1 text-xs text-text-primary"
          value={targetTypeFilter}
          onChange={(e) => { setTargetTypeFilter(e.target.value); setPage(1); }}
        >
          <option value="">All Targets</option>
          <option value="issue">Issues</option>
          <option value="pr">Pull Requests</option>
        </select>
        <input
          type="date"
          value={fromDate}
          onChange={(e) => { setFromDate(e.target.value); setPage(1); }}
          className="bg-surface-2 border border-border rounded px-2 py-1 text-xs text-text-primary"
        />
        <span className="text-text-tertiary text-xs">to</span>
        <input
          type="date"
          value={toDate}
          onChange={(e) => { setToDate(e.target.value); setPage(1); }}
          className="bg-surface-2 border border-border rounded px-2 py-1 text-xs text-text-primary"
        />
        {hasActiveFilters && (
          <button
            className="px-3 py-1 rounded-full text-xs bg-red-900/30 text-red-400 hover:bg-red-900/50"
            onClick={clearFilters}
          >
            Clear
          </button>
        )}
      </div>

      {/* Proof list */}
      <div className="divide-y divide-border">
        {/* Error state */}
        {proofError && (
          <div className="px-6 py-8 text-center">
            <div className="text-red-400 text-sm mb-2">Failed to load dry-run proofs</div>
            <button
              className="text-xs text-accent-green hover:underline"
              onClick={() => window.location.reload()}
            >
              Retry
            </button>
          </div>
        )}

        {/* Loading */}
        {isLoading && Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="px-6 py-3">
            <Skeleton className="h-4 w-3/4" />
          </div>
        ))}

        {/* Empty */}
        {!isLoading && !proofError && proofs.length === 0 && (
          <EmptyState
            title={hasActiveFilters ? "No dry-run proofs match your filters" : "No dry-run proofs found"}
          />
        )}

        {/* Proof rows */}
        {!isLoading && !proofError && proofs.map((p: any) => (
          <div key={p.id} className="hover:bg-surface-2/50 transition-colors">
            <div
              className="px-6 py-3 cursor-pointer"
              onClick={() => setExpandedId(expandedId === p.id ? null : p.id)}
            >
              <div className="flex items-center gap-3">
                {/* Source badge */}
                <span className={"text-[10px] font-mono px-2 py-0.5 rounded border " +
                  (SOURCE_COLORS[p.source] || "bg-gray-500/10 text-gray-400 border-gray-500/20")}>
                  {p.source}
                </span>

                {/* Target */}
                <span className="text-xs text-text-secondary">
                  {p.target_type}#{p.target_number}
                </span>

                {/* Would-do action (reason) */}
                <span className="text-xs text-text-primary truncate flex-1">
                  <span className="text-amber-400/80 font-mono text-[10px] uppercase mr-1">Would have:</span>
                  {p.reason || "No planned action recorded"}
                </span>

                {/* Pillar */}
                {p.pillar && (
                  <span className="text-[10px] font-mono text-text-tertiary">{p.pillar}</span>
                )}

                {/* Time */}
                <span className="text-[10px] text-text-tertiary whitespace-nowrap">
                  {formatDistanceToNow(new Date(p.created_at), { addSuffix: true })}
                </span>

                <span className="text-text-tertiary text-[10px]">
                  {expandedId === p.id ? "▲" : "▼"}
                </span>
              </div>

              {/* Conditions (inline) */}
              {p.conditions && Array.isArray(p.conditions) && p.conditions.length > 0 && (
                <div className="mt-1.5 ml-2 flex flex-wrap gap-1.5">
                  {p.conditions.map((c: any, i: number) => (
                    <span
                      key={i}
                      className={"text-[10px] font-mono px-1.5 py-0.5 rounded " +
                        (c.result
                          ? "bg-green-500/5 text-green-500/70"
                          : "bg-red-500/5 text-red-500/70")}
                    >
                      {c.result ? "[+]" : "[x]"} {c.check}
                    </span>
                  ))}
                </div>
              )}
            </div>

            {/* Expanded detail */}
            {expandedId === p.id && (
              <div className="px-6 pb-4">
                {/* Safety reminder */}
                <div className="mb-3 rounded border border-amber-500/20 bg-amber-500/5 px-3 py-1.5">
                  <span className="text-[10px] font-mono text-amber-400/80 uppercase">
                    Skipped mutation due to dry-run — no GitHub API writes were made
                  </span>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {/* Metadata */}
                  <div className="bg-surface-2 rounded-lg p-3">
                    <div className="text-[10px] font-mono uppercase text-text-tertiary tracking-wider mb-2">
                      Planned Action
                    </div>
                    <div className="space-y-1 text-xs">
                      <div className="flex justify-between">
                        <span className="text-text-tertiary">Source</span>
                        <span className="font-mono text-text-secondary">{p.source}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-text-tertiary">Pillar</span>
                        <span className="font-mono text-text-secondary">{p.pillar || "—"}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-text-tertiary">Trigger</span>
                        <span className="font-mono text-text-secondary">{p.trigger_event || "—"}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-text-tertiary">Target</span>
                        <span className="font-mono text-text-secondary">{p.target_type} #{p.target_number}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-text-tertiary">Actor</span>
                        <span className="font-mono text-text-secondary">{p.actor || "gitwire[bot]"}</span>
                      </div>
                      {p.commit_sha && (
                        <div className="flex justify-between">
                          <span className="text-text-tertiary">Commit</span>
                          <span className="font-mono text-text-secondary">{p.commit_sha.slice(0, 8)}</span>
                        </div>
                      )}
                      <div className="flex justify-between">
                        <span className="text-text-tertiary">Evaluated</span>
                        <span className="font-mono text-text-secondary">{new Date(p.created_at).toLocaleString()}</span>
                      </div>
                    </div>

                    {/* Deep links */}
                    <div className="mt-3 pt-2 border-t border-border space-y-1">
                      <Link
                        href={"/decisions?decision=dry_run&source=" + encodeURIComponent(p.source) + "&pillar=" + encodeURIComponent(p.pillar || "")}
                        className="block text-xs text-accent-green hover:underline"
                      >
                        View in decision log
                      </Link>
                      {p.repo_id && (
                        <Link
                          href={"/actions?status=proposed&pillar=" + encodeURIComponent(p.pillar || "")}
                          className="block text-xs text-accent-green hover:underline"
                        >
                          View related managed actions
                        </Link>
                      )}
                    </div>
                  </div>

                  {/* Config used + reason */}
                  <div className="bg-surface-2 rounded-lg p-3">
                    <div className="text-[10px] font-mono uppercase text-text-tertiary tracking-wider mb-2">
                      Planned Reason
                    </div>
                    <div className="text-xs text-text-primary mb-3">
                      {p.reason || "No reason recorded"}
                    </div>

                    <div className="text-[10px] font-mono uppercase text-text-tertiary tracking-wider mb-2 mt-3 pt-2 border-t border-border">
                      Config Used
                    </div>
                    {p.config_used ? (
                      <pre className="text-[10px] font-mono text-text-secondary overflow-auto max-h-32 whitespace-pre-wrap">
                        {JSON.stringify(p.config_used, null, 2)}
                      </pre>
                    ) : (
                      <div className="text-xs text-text-tertiary">No config snapshot recorded</div>
                    )}
                  </div>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Pagination */}
      {meta.totalPages > 1 && (
        <div className="flex items-center justify-between px-6 py-3 border-t border-border">
          <span className="text-[10px] text-text-tertiary">
            {meta.total} dry-run proofs . page {meta.page} of {meta.totalPages}
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
