"use client";

import { useState } from "react";
import { useApi, fetcher, API, grantWaiver, revokeWaiver } from "@/lib/api";
import {
  PageHeader, Badge, Skeleton, EmptyState, FilterPill,
} from "@/components/ui";
import { formatDistanceToNow } from "date-fns";

const PILLARS = [
  "ci_healing", "triage", "ai_review", "issue_fix",
  "maintainer", "enforcement", "trust", "merge_queue", "insights",
];

const SCOPE_OPTIONS = ["repo", "branch", "pr", "issue"];

export default function WaiversPage() {
  const [selectedRepo, setSelectedRepo] = useState<string | null>(null);
  const [pillarFilter, setPillarFilter] = useState<string | null>(null);
  const [showGrant, setShowGrant] = useState(false);
  const [revoking, setRevoking] = useState<number | null>(null);

  // Grant form state
  const [gPillar, setGPillar] = useState("ci_healing");
  const [gScope, setGScope] = useState("repo");
  const [gScopeValue, setGScopeValue] = useState("");
  const [gReason, setGReason] = useState("");
  const [gExpires, setGExpires] = useState("");
  const [gSubmitting, setGSubmitting] = useState(false);

  // Repos for dropdown
  const { data: repos } = useApi(API.repos("per_page=100"), { refreshInterval: 60000 });

  // Waivers for selected repo
  const waiverUrl = selectedRepo
    ? API.waivers(selectedRepo, pillarFilter ? `pillar=${pillarFilter}` : "")
    : null;
  const { data: waivers, meta, isLoading, mutate } = useApi(waiverUrl);

  const repoNames: string[] = repos.map((r: any) => r.full_name ?? r.name ?? "").filter(Boolean);

  async function handleGrant() {
    if (!selectedRepo || !gReason.trim()) return;
    setGSubmitting(true);
    try {
      await grantWaiver(
        selectedRepo,
        gPillar,
        gScope,
        gScope === "repo" ? "" : gScopeValue,
        gReason,
        "dashboard",
        gExpires || undefined,
      );
      setShowGrant(false);
      setGReason("");
      setGScopeValue("");
      setGExpires("");
      mutate();
    } catch (_e) {
      // Error will be visible in UI
    } finally {
      setGSubmitting(false);
    }
  }

  async function handleRevoke(id: number) {
    setRevoking(id);
    try {
      await revokeWaiver(id);
      mutate();
    } catch (_e) {
      // Error will be visible in UI
    } finally {
      setRevoking(null);
    }
  }

  return (
    <div className="animate-fade-in">
      <PageHeader
        title="Policy Waivers"
        subtitle="Manage time-limited exceptions to pillar enforcement"
        actions={
          <button
            onClick={() => setShowGrant(!showGrant)}
            className="px-4 py-2 bg-accent-green/15 border border-accent-green/40 text-accent-green text-xs font-mono rounded hover:bg-accent-green/25 transition-colors"
          >
            {showGrant ? "Cancel" : "+ Grant Waiver"}
          </button>
        }
      />

      {/* Repo selector + pillar filter */}
      <div className="px-6 py-4 border-b border-border flex flex-wrap items-center gap-3">
        <select
          value={selectedRepo ?? ""}
          onChange={(e) => setSelectedRepo(e.target.value || null)}
          className="bg-surface-2 border border-border rounded px-3 py-1.5 text-sm font-mono text-text-primary"
        >
          <option value="">Select a repository...</option>
          {repoNames.map((name: string) => (
            <option key={name} value={name}>{name}</option>
          ))}
        </select>

        <div className="flex items-center gap-1.5 flex-wrap">
          <FilterPill active={!pillarFilter} onClick={() => setPillarFilter(null)}>All</FilterPill>
          {PILLARS.map((p) => (
            <FilterPill key={p} active={pillarFilter === p} onClick={() => setPillarFilter(pillarFilter === p ? null : p)}>
              {p.replace("_", " ")}
            </FilterPill>
          ))}
        </div>
      </div>

      {/* Grant form */}
      {showGrant && selectedRepo && (
        <div className="px-6 py-4 border-b border-border bg-surface-1/50">
          <div className="text-xs font-mono text-text-tertiary uppercase tracking-wider mb-3">
            Grant new waiver for {selectedRepo}
          </div>
          <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
            <div>
              <label className="text-[10px] font-mono text-text-tertiary uppercase block mb-1">Pillar</label>
              <select value={gPillar} onChange={(e) => setGPillar(e.target.value)} className="w-full bg-surface-2 border border-border rounded px-2 py-1.5 text-sm font-mono text-text-primary">
                {PILLARS.map((p) => <option key={p} value={p}>{p}</option>)}
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
            disabled={gSubmitting || !gReason.trim()}
            className="mt-3 px-4 py-2 bg-accent-green text-surface-0 text-xs font-mono font-bold rounded hover:bg-accent-green/90 transition-colors disabled:opacity-50"
          >
            {gSubmitting ? "Granting..." : "Grant Waiver"}
          </button>
        </div>
      )}

      {/* Waivers table */}
      <div className="divide-y divide-border">
        {!selectedRepo && (
          <EmptyState icon="🛡" title="Select a repository" body="Choose a repo above to view and manage policy waivers." />
        )}
        {isLoading && selectedRepo && [...Array(3)].map((_, i) => (
          <div key={i} className="px-6 py-4"><Skeleton className="h-12" /></div>
        ))}
        {!isLoading && selectedRepo && waivers.length === 0 && (
          <EmptyState icon="✓" title="No waivers" body="No active policy waivers for this repository." />
        )}
        {waivers.map((w: any) => (
          <div key={String(w.id)} className="px-6 py-3 hover:bg-surface-2/50 transition-colors">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <Badge variant={w.active ? "amber" : "default"}>
                  {w.active ? "active" : "expired"}
                </Badge>
                <Badge variant="blue">{w.pillar}</Badge>
                {w.scope !== "repo" && (
                  <span className="text-xs font-mono text-text-tertiary">
                    {w.scope}: <span className="text-text-secondary">{w.scope_value}</span>
                  </span>
                )}
                <span className="text-sm text-text-primary">{w.reason}</span>
              </div>
              <div className="flex items-center gap-3">
                {w.expires_at && (
                  <span className="text-[10px] font-mono text-text-tertiary">
                    expires {formatDistanceToNow(new Date(String(w.expires_at)), { addSuffix: true })}
                  </span>
                )}
                <span className="text-[10px] font-mono text-text-tertiary">
                  by {w.granted_by}
                </span>
                {w.active && (
                  <button
                    onClick={() => handleRevoke(Number(w.id))}
                    disabled={revoking === Number(w.id)}
                    className="px-2 py-0.5 text-[10px] font-mono text-accent-red border border-accent-red/30 rounded hover:bg-accent-red/10 transition-colors disabled:opacity-50"
                  >
                    {revoking === Number(w.id) ? "Revoking..." : "Revoke"}
                  </button>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
