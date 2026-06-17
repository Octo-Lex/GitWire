"use client";

import { useState } from "react";
import useSWR from "swr";
import { fetcher, API, grantWaiver, revokeWaiver } from "@/lib/api";
import {
  PageHeader, Badge, Skeleton, EmptyState, FilterPill,
} from "@/components/ui";
import { formatDistanceToNow } from "date-fns";
import Link from "next/link";

const PILLAR_OPTIONS = [
  "ci_healing", "triage", "ai_review", "issue_fix",
  "maintainer", "enforcement", "trust", "merge_queue", "insights",
];

const SCOPE_OPTIONS = ["repo", "branch", "pr", "issue"];

/**
 * Compute the display status of a waiver.
 * active = currently in effect
 * expired = past expiry or revoked
 * expiring = active but expires within 7 days
 */
function computeWaiverStatus(w: any): "active" | "expired" | "expiring" {
  if (!w.active) return "expired";
  if (w.expires_at) {
    const expiry = new Date(String(w.expires_at));
    const now = new Date();
    const daysLeft = (expiry.getTime() - now.getTime()) / (1000 * 60 * 60 * 24);
    if (daysLeft <= 0) return "expired";
    if (daysLeft <= 7) return "expiring";
  }
  return "active";
}

const STATUS_STYLES: Record<string, string> = {
  active: "bg-green-500/10 text-green-400 border-green-500/20",
  expiring: "bg-amber-500/10 text-amber-400 border-amber-500/20",
  expired: "bg-gray-500/10 text-gray-400 border-gray-500/20",
};

export default function WaiversPage() {
  // Filters
  const [repoFilter, setRepoFilter] = useState<string>("");
  const [pillarFilter, setPillarFilter] = useState<string>("");
  const [scopeFilter, setScopeFilter] = useState<string>("");
  const [statusFilter, setStatusFilter] = useState<string>("active");
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [page, setPage] = useState(1);
  const [expandedId, setExpandedId] = useState<number | null>(null);

  // Grant form state (existing functionality, preserved)
  const [showGrant, setShowGrant] = useState(false);
  const [grantRepo, setGrantRepo] = useState("");
  const [gPillar, setGPillar] = useState("ci_healing");
  const [gScope, setGScope] = useState("repo");
  const [gScopeValue, setGScopeValue] = useState("");
  const [gReason, setGReason] = useState("");
  const [gExpires, setGExpires] = useState("");
  const [gSubmitting, setGSubmitting] = useState(false);
  const [revoking, setRevoking] = useState<number | null>(null);

  const limit = 50;
  const offset = (page - 1) * limit;

  // Build query params for global waiver list
  const waiverParams = new URLSearchParams();
  waiverParams.set("limit", String(limit));
  waiverParams.set("offset", String(offset));
  if (pillarFilter) waiverParams.set("pillar", pillarFilter);
  if (scopeFilter) waiverParams.set("scope", scopeFilter);
  if (statusFilter) waiverParams.set("status", statusFilter);
  if (repoFilter) waiverParams.set("repo", repoFilter);
  if (searchQuery.trim()) waiverParams.set("q", searchQuery.trim());

  // Repos for dropdown
  const { data: reposData } = useSWR<{ data: Array<{ full_name: string }> }>(
    "/api/repos?limit=100", fetcher, { refreshInterval: 60000 }
  );

  const { data, isLoading, error: waiverError, mutate } = useSWR(
    API.waivers("", waiverParams.toString()), fetcher, { refreshInterval: 30000 }
  );

  const waivers = data?.data ?? [];
  const meta = data?.meta ?? { total: 0, limit, offset };
  const totalPages = Math.ceil((meta.total || 0) / limit);

  const hasActiveFilters = pillarFilter || scopeFilter || statusFilter !== "active" || repoFilter || searchQuery.trim();

  function clearFilters() {
    setPillarFilter("");
    setScopeFilter("");
    setStatusFilter("active");
    setRepoFilter("");
    setSearchQuery("");
    setPage(1);
  }

  async function handleGrant() {
    if (!grantRepo || !gReason.trim()) return;
    setGSubmitting(true);
    try {
      await grantWaiver(
        grantRepo, gPillar, gScope,
        gScope === "repo" ? "" : gScopeValue,
        gReason, "dashboard", gExpires || undefined,
      );
      setShowGrant(false);
      setGReason(""); setGScopeValue(""); setGExpires("");
      mutate();
    } catch { /* visible in UI */ } finally {
      setGSubmitting(false);
    }
  }

  async function handleRevoke(id: number) {
    setRevoking(id);
    try { await revokeWaiver(id); mutate(); }
    catch { /* visible in UI */ } finally { setRevoking(null); }
  }

  return (
    <div className="animate-fade-in">
      <PageHeader
        title="Policy Waivers"
        subtitle="Time-limited exceptions to pillar enforcement"
        actions={
          <button
            onClick={() => setShowGrant(!showGrant)}
            className="px-4 py-2 bg-accent-green/15 border border-accent-green/40 text-accent-green text-xs font-mono rounded hover:bg-accent-green/25 transition-colors"
          >
            {showGrant ? "Cancel" : "+ Grant Waiver"}
          </button>
        }
      />

      {/* Stats */}
      <div className="grid grid-cols-3 gap-3 px-6 py-4 border-b border-border">
        <div className="bg-surface-2 rounded-lg p-3">
          <div className="text-[10px] font-mono uppercase text-text-tertiary tracking-wider">Active</div>
          <div className="text-2xl font-bold text-green-400">
            {waivers.filter((w: any) => computeWaiverStatus(w) === "active").length}
          </div>
          <div className="text-[10px] text-text-tertiary">in current view</div>
        </div>
        <div className="bg-surface-2 rounded-lg p-3">
          <div className="text-[10px] font-mono uppercase text-text-tertiary tracking-wider">Expiring Soon</div>
          <div className="text-2xl font-bold text-amber-400">
            {waivers.filter((w: any) => computeWaiverStatus(w) === "expiring").length}
          </div>
          <div className="text-[10px] text-text-tertiary">within 7 days</div>
        </div>
        <div className="bg-surface-2 rounded-lg p-3">
          <div className="text-[10px] font-mono uppercase text-text-tertiary tracking-wider">Total Records</div>
          <div className="text-2xl font-bold text-text-primary">{meta.total}</div>
          <div className="text-[10px] text-text-tertiary">all-time</div>
        </div>
      </div>

      {/* Filters */}
      <div className="flex gap-2 px-6 py-3 border-b border-border items-center flex-wrap">
        <input
          type="text"
          placeholder="Search reason..."
          value={searchQuery}
          onChange={(e) => { setSearchQuery(e.target.value); setPage(1); }}
          className="bg-surface-2 border border-border rounded px-3 py-1 text-xs text-text-primary w-48"
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
          value={scopeFilter}
          onChange={(e) => { setScopeFilter(e.target.value); setPage(1); }}
        >
          <option value="">All Scopes</option>
          {SCOPE_OPTIONS.map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
        {hasActiveFilters && (
          <button
            className="px-3 py-1 rounded-full text-xs bg-red-900/30 text-red-400 hover:bg-red-900/50"
            onClick={clearFilters}
          >
            Clear
          </button>
        )}
      </div>

      {/* Status filter buttons */}
      <div className="flex gap-2 px-6 py-2 border-b border-border items-center">
        <span className="text-[10px] font-mono text-text-tertiary uppercase tracking-wider mr-1">Status</span>
        {["active", "expiring", "expired", ""].map((s) => (
          <button
            key={s || "all"}
            onClick={() => { setStatusFilter(s); setPage(1); }}
            className={"text-[11px] px-2 py-1 rounded border transition-colors " +
              (statusFilter === s
                ? "bg-accent-primary/20 text-accent-primary border-accent-primary/30"
                : "bg-surface-2 text-text-secondary border-border hover:border-text-tertiary")}
          >
            {s || "All"}
          </button>
        ))}
      </div>

      {/* Grant form */}
      {showGrant && (
        <div className="px-6 py-4 border-b border-border bg-surface-1/50">
          <div className="text-xs font-mono text-text-tertiary uppercase tracking-wider mb-3">
            Grant new waiver
          </div>
          <div className="grid grid-cols-2 lg:grid-cols-6 gap-3">
            <div>
              <label className="text-[10px] font-mono text-text-tertiary uppercase block mb-1">Repo *</label>
              <select
                value={grantRepo}
                onChange={(e) => setGrantRepo(e.target.value)}
                className="w-full bg-surface-2 border border-border rounded px-2 py-1.5 text-sm font-mono text-text-primary"
              >
                <option value="">Select...</option>
                {(reposData?.data ?? []).map((r) => (
                  <option key={r.full_name} value={r.full_name}>{r.full_name}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-[10px] font-mono text-text-tertiary uppercase block mb-1">Pillar</label>
              <select value={gPillar} onChange={(e) => setGPillar(e.target.value)} className="w-full bg-surface-2 border border-border rounded px-2 py-1.5 text-sm font-mono text-text-primary">
                {PILLAR_OPTIONS.map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
            </div>
            <div>
              <label className="text-[10px] font-mono text-text-tertiary uppercase block mb-1">Scope</label>
              <select value={gScope} onChange={(e) => setGScope(e.target.value)} className="w-full bg-surface-2 border border-border rounded px-2 py-1.5 text-sm font-mono text-text-primary">
                {SCOPE_OPTIONS.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
            {gScope !== "repo" && (
              <div>
                <label className="text-[10px] font-mono text-text-tertiary uppercase block mb-1">Scope Value</label>
                <input
                  value={gScopeValue}
                  onChange={(e) => setGScopeValue(e.target.value)}
                  placeholder={gScope === "branch" ? "release/*" : "42"}
                  className="w-full bg-surface-2 border border-border rounded px-2 py-1.5 text-sm font-mono text-text-primary"
                />
              </div>
            )}
            <div>
              <label className="text-[10px] font-mono text-text-tertiary uppercase block mb-1">Expires</label>
              <input
                type="date"
                value={gExpires}
                onChange={(e) => setGExpires(e.target.value)}
                className="w-full bg-surface-2 border border-border rounded px-2 py-1.5 text-sm font-mono text-text-primary"
              />
            </div>
            <div>
              <label className="text-[10px] font-mono text-text-tertiary uppercase block mb-1">Reason *</label>
              <input
                value={gReason}
                onChange={(e) => setGReason(e.target.value)}
                placeholder="Release freeze"
                className="w-full bg-surface-2 border border-border rounded px-2 py-1.5 text-sm font-mono text-text-primary"
              />
            </div>
          </div>
          <button
            onClick={handleGrant}
            disabled={gSubmitting || !gReason.trim() || !grantRepo}
            className="mt-3 px-4 py-2 bg-accent-green text-surface-0 text-xs font-mono font-bold rounded hover:bg-accent-green/90 transition-colors disabled:opacity-50"
          >
            {gSubmitting ? "Granting..." : "Grant Waiver"}
          </button>
        </div>
      )}

      {/* Error state */}
      {waiverError && (
        <div className="px-6 py-8 text-center">
          <div className="text-red-400 text-sm mb-2">Failed to load waivers</div>
          <button
            className="text-xs text-accent-green hover:underline"
            onClick={() => mutate()}
          >
            Retry
          </button>
        </div>
      )}

      {/* Loading */}
      {isLoading && Array.from({ length: 5 }).map((_, i) => (
        <div key={i} className="px-6 py-4">
          <Skeleton className="h-12" />
        </div>
      ))}

      {/* Empty */}
      {!isLoading && !waiverError && waivers.length === 0 && (
        <EmptyState
          title={hasActiveFilters ? "No waivers match your filters" : "No waivers found"}
        />
      )}

      {/* Waiver rows */}
      {!isLoading && !waiverError && waivers.map((w: any) => {
        const status = computeWaiverStatus(w);
        const repoName = w.repo_full_name || "";
        return (
          <div key={String(w.id)} className="hover:bg-surface-2/50 transition-colors">
            <div
              className="px-6 py-3 cursor-pointer"
              onClick={() => setExpandedId(expandedId === Number(w.id) ? null : Number(w.id))}
            >
              <div className="flex items-center gap-3">
                {/* Status badge */}
                <span className={"text-[10px] font-mono px-2 py-0.5 rounded border " + (STATUS_STYLES[status] || "")}>
                  {status}
                </span>

                {/* Pillar badge */}
                <span className="text-[10px] font-mono px-2 py-0.5 rounded border bg-blue-500/10 text-blue-400 border-blue-500/20">
                  {w.pillar}
                </span>

                {/* Scope */}
                {w.scope !== "repo" && (
                  <span className="text-[10px] font-mono text-text-tertiary">
                    {w.scope}: <span className="text-text-secondary">{w.scope_value}</span>
                  </span>
                )}

                {/* Repo */}
                {repoName && (
                  <span className="text-xs font-mono text-text-secondary">{repoName}</span>
                )}

                {/* Reason */}
                <span className="text-xs text-text-primary truncate flex-1">
                  {w.reason}
                </span>

                {/* Expiry */}
                {w.expires_at && (
                  <span className="text-[10px] font-mono text-text-tertiary whitespace-nowrap">
                    {status === "expired"
                      ? "expired " + formatDistanceToNow(new Date(String(w.expires_at)), { addSuffix: true })
                      : "expires " + formatDistanceToNow(new Date(String(w.expires_at)), { addSuffix: true })}
                  </span>
                )}

                {/* Grantor */}
                <span className="text-[10px] font-mono text-text-tertiary">
                  by {w.granted_by}
                </span>

                {w.active && (
                  <button
                    onClick={(e) => { e.stopPropagation(); handleRevoke(Number(w.id)); }}
                    disabled={revoking === Number(w.id)}
                    className="px-2 py-0.5 text-[10px] font-mono text-accent-red border border-accent-red/30 rounded hover:bg-accent-red/10 transition-colors disabled:opacity-50"
                  >
                    {revoking === Number(w.id) ? "Revoking..." : "Revoke"}
                  </button>
                )}

                <span className="text-text-tertiary text-[10px]">
                  {expandedId === Number(w.id) ? "up" : "down"}
                </span>
              </div>
            </div>

            {/* Expanded detail */}
            {expandedId === Number(w.id) && (
              <div className="px-6 pb-4 grid grid-cols-1 md:grid-cols-2 gap-4">
                {/* Metadata */}
                <div className="bg-surface-2 rounded-lg p-3">
                  <div className="text-[10px] font-mono uppercase text-text-tertiary tracking-wider mb-2">Details</div>
                  <div className="space-y-1 text-xs">
                    <div className="flex justify-between">
                      <span className="text-text-tertiary">ID</span>
                      <span className="font-mono text-text-secondary">{w.id}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-text-tertiary">Repo</span>
                      <span className="font-mono text-text-secondary">{repoName || "unknown"}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-text-tertiary">Pillar</span>
                      <span className="font-mono text-text-secondary">{w.pillar}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-text-tertiary">Scope</span>
                      <span className="font-mono text-text-secondary">{w.scope}{w.scope_value ? " = " + w.scope_value : ""}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-text-tertiary">Granted by</span>
                      <span className="font-mono text-text-secondary">{w.granted_by}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-text-tertiary">Created</span>
                      <span className="font-mono text-text-secondary">{new Date(String(w.created_at)).toLocaleString()}</span>
                    </div>
                    {w.expires_at && (
                      <div className="flex justify-between">
                        <span className="text-text-tertiary">Expires</span>
                        <span className="font-mono text-text-secondary">{new Date(String(w.expires_at)).toLocaleString()}</span>
                      </div>
                    )}
                    {w.revoked_at && (
                      <div className="flex justify-between">
                        <span className="text-text-tertiary">Revoked</span>
                        <span className="font-mono text-text-secondary">{new Date(String(w.revoked_at)).toLocaleString()}</span>
                      </div>
                    )}
                  </div>
                </div>

                {/* Reason + Decision Linkage */}
                <div className="bg-surface-2 rounded-lg p-3">
                  <div className="text-[10px] font-mono uppercase text-text-tertiary tracking-wider mb-2">Reason</div>
                  <div className="text-xs text-text-primary mb-3">{w.reason}</div>

                  {/* Link to decisions filtered by this pillar+repo */}
                  {repoName && (
                    <div className="mt-2 pt-2 border-t border-border">
                      <div className="text-[10px] font-mono uppercase text-text-tertiary tracking-wider mb-1">
                        Decision linkage
                      </div>
                      <Link
                        href={"/decisions?pillar=" + encodeURIComponent(w.pillar) + "&repo=" + encodeURIComponent(repoName) + "&decision=skipped"}
                        className="text-xs text-accent-green hover:underline"
                      >
                        View skipped decisions for {w.pillar} in {repoName}
                      </Link>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        );
      })}

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between px-6 py-3 border-t border-border">
          <span className="text-[10px] text-text-tertiary">
            {meta.total} waivers - page {page} of {totalPages}
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
              onClick={() => setPage(Math.min(totalPages, page + 1))}
              disabled={page >= totalPages}
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
