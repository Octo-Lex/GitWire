"use client";

import { useState } from "react";
import useSWR from "swr";
import { fetcher, API, confirmDuplicate, dismissDuplicate, triggerEmbeddingBackfill } from "@/lib/api";
import { ApiItem } from "@/lib/types";
import {
  PageHeader, StatCard, Badge, Skeleton, EmptyState, FilterPill,
} from "@/components/ui";
import { formatDistanceToNow } from "date-fns";
import clsx from "clsx";

// ── Similarity bar ────────────────────────────────────────────────────────
function SimBar({ value }: { value: number }) {
  const pct = Math.round(value * 100);
  const color =
    pct >= 97 ? "bg-accent-red" :
    pct >= 95 ? "bg-accent-amber" :
    pct >= 92 ? "bg-accent-purple" : "bg-accent-blue";
  return (
    <div className="flex items-center gap-2 min-w-[80px]">
      <div className="flex-1 h-1 bg-surface-3 rounded-full overflow-hidden">
        <div className={clsx("h-full rounded-full", color)} style={{ width: `${pct}%` }} />
      </div>
      <span className="font-mono text-xs text-text-secondary w-8 text-right">{pct}%</span>
    </div>
  );
}

function ConfidenceBadge({ similarity }: { similarity: number }) {
  const pct = Math.round(similarity * 100);
  if (pct >= 97) return <Badge variant="red">near identical</Badge>;
  if (pct >= 95) return <Badge variant="amber">very high</Badge>;
  if (pct >= 92) return <Badge variant="purple">high</Badge>;
  return <Badge variant="blue">moderate</Badge>;
}

// ── Coverage ring ─────────────────────────────────────────────────────────
function CoverageRing({ pct }: { pct: number }) {
  const r = 28, c = 32;
  const circ = 2 * Math.PI * r;
  const dash = (pct / 100) * circ;
  return (
    <svg width={64} height={64} className="shrink-0">
      <circle cx={c} cy={c} r={r} fill="none" stroke="var(--color-border)" strokeWidth={4} />
      <circle
        cx={c} cy={c} r={r}
        fill="none"
        stroke={pct >= 80 ? "#00d97e" : pct >= 50 ? "#ffb547" : "#ff4d6a"}
        strokeWidth={4}
        strokeLinecap="round"
        strokeDasharray={`${dash} ${circ - dash}`}
        strokeDashoffset={circ / 4}
        transform={`rotate(-90 ${c} ${c})`}
      />
      <text x={c} y={c} textAnchor="middle" dominantBaseline="central"
        style={{ fontSize: 12, fontFamily: "var(--font-mono)", fontWeight: 500, fill: "var(--color-text-primary)" }}>
        {Math.round(pct)}%
      </text>
    </svg>
  );
}

// ── Signal row ────────────────────────────────────────────────────────────
function SignalRow({ signal, onAction }: { signal: ApiItem; onAction: () => void }) {
  const [acting, setActing] = useState<string | null>(null);

  async function act(action: "confirm" | "dismiss") {
    setActing(action);
    try {
      if (action === "confirm") await confirmDuplicate(signal.id);
      else await dismissDuplicate(signal.id);
      onAction();
    } finally {
      setActing(null);
    }
  }

  const isPending = signal.status === "pending";

  return (
    <div className="flex items-start gap-4 px-4 py-3 border-b border-border last:border-0 hover:bg-surface-2/40 transition-colors group">
      {/* Similarity strip */}
      <div className={clsx("w-0.5 self-stretch rounded-full shrink-0", {
        "bg-accent-red":    signal.similarity >= 0.97,
        "bg-accent-amber":  signal.similarity >= 0.95,
        "bg-accent-purple": signal.similarity >= 0.92,
        "bg-accent-blue":   signal.similarity <  0.92,
      })} />

      <div className="flex-1 min-w-0">
        {/* Source issue */}
        <div className="flex items-center gap-2 mb-1">
          <span className="text-xs text-text-tertiary font-mono">new:</span>
          <span className="text-sm font-medium text-text-primary truncate">{signal.source_title}</span>
          <span className="font-mono text-xs text-text-tertiary shrink-0">#{signal.source_number}</span>
          {signal.source_state === "closed" && <Badge variant="default">closed</Badge>}
        </div>

        {/* Target issue */}
        <div className="flex items-center gap-2">
          <span className="text-xs text-text-tertiary font-mono">vs:</span>
          <span className="text-sm text-text-secondary truncate">{signal.target_title}</span>
          <span className="font-mono text-xs text-text-tertiary shrink-0">#{signal.target_number}</span>
          {signal.target_state === "closed" && <Badge variant="default">closed</Badge>}
        </div>

        {/* Meta row */}
        <div className="flex items-center gap-3 mt-2 flex-wrap">
          <span className="font-mono text-[10px] text-text-tertiary">{signal.repo_full_name}</span>
          <SimBar value={signal.similarity} />
          <ConfidenceBadge similarity={signal.similarity} />
          <span className="text-[10px] text-text-tertiary">
            {formatDistanceToNow(new Date(signal.created_at), { addSuffix: true })}
          </span>
          {signal.status === "confirmed" && <Badge variant="green">confirmed duplicate</Badge>}
          {signal.status === "dismissed" && <Badge variant="default">dismissed</Badge>}
        </div>
      </div>

      {/* Actions */}
      {isPending && (
        <div className="flex gap-1.5 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity self-center">
          <button
            onClick={() => act("confirm")}
            disabled={!!acting}
            className="px-2.5 py-1 text-xs rounded border border-accent-green/30 text-accent-green hover:bg-accent-green/10 disabled:opacity-50 transition-colors"
          >
            {acting === "confirm" ? "…" : "✓ confirm"}
          </button>
          <button
            onClick={() => act("dismiss")}
            disabled={!!acting}
            className="px-2.5 py-1 text-xs rounded border border-border text-text-tertiary hover:text-text-primary disabled:opacity-50 transition-colors"
          >
            {acting === "dismiss" ? "…" : "✕ dismiss"}
          </button>
        </div>
      )}
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────
export default function DuplicatesPage() {
  const [status, setStatus] = useState("pending");
  const [repoFilter, setRepo] = useState("");
  const [minSim, setMinSim] = useState(0.92);
  const [page, setPage] = useState(1);
  const [backfilling, setBackfilling] = useState(false);

  const { data: stats, mutate: mutateStats } =
    useSWR(API.dupStats(), fetcher, { refreshInterval: 30000 });

  const qs = new URLSearchParams({ status, per_page: "30", page: String(page) });
  if (repoFilter) qs.set("repo", repoFilter);
  if (minSim > 0) qs.set("min_similarity", String(minSim));

  const { data, isLoading, mutate } = useSWR(
    API.duplicates(qs.toString()), fetcher, { refreshInterval: 20000, keepPreviousData: true }
  );

  const signals = data?.data ?? [];
  const meta = data?.meta ?? {};

  function refresh() { mutate(); mutateStats(); }

  async function handleBackfill() {
    const repo = repoFilter || prompt("Enter repo (owner/name) to backfill embeddings:");
    if (!repo || !repo.includes("/")) return;
    const [owner, name] = repo.split("/");
    setBackfilling(true);
    try {
      await triggerEmbeddingBackfill(owner, name);
    } finally {
      setBackfilling(false);
    }
  }

  const coverage = stats?.coverage;

  return (
    <div className="animate-fade-in">
      <PageHeader
        title="Duplicate issue detection"
        subtitle="Embedding similarity across all repositories"
        actions={
          <button
            onClick={handleBackfill}
            disabled={backfilling}
            className="px-3 py-1.5 text-xs font-mono rounded border border-border text-text-secondary hover:text-text-primary disabled:opacity-50 transition-colors"
          >
            {backfilling ? "↻ backfilling…" : "↻ backfill embeddings"}
          </button>
        }
      />

      {/* Stats row */}
      <div className="grid grid-cols-5 gap-3 px-6 py-4 border-b border-border">
        <StatCard label="Pending review" value={stats?.summary?.pending} loading={!stats} accent="amber" />
        <StatCard label="Confirmed" value={stats?.summary?.confirmed} loading={!stats} accent="green" />
        <StatCard label="Near-identical" value={stats?.summary?.near_identical} loading={!stats} accent="red" />
        <StatCard label="Issues flagged" value={stats?.summary?.issues_flagged} loading={!stats} />
        <div className="card p-4 flex items-center gap-4">
          {coverage ? (
            <>
              <CoverageRing pct={Number(coverage.coverage_pct ?? 0)} />
              <div>
                <div className="text-[10px] font-mono text-text-tertiary uppercase tracking-wider mb-1">
                  Embedding coverage
                </div>
                <div className="text-sm font-medium text-text-primary">
                  {coverage.embedded}/{coverage.total_open_issues}
                </div>
                <div className="text-xs text-text-tertiary">open issues</div>
              </div>
            </>
          ) : (
            <Skeleton className="h-16 w-full" />
          )}
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-6 py-3 border-b border-border">
        <div className="flex gap-1">
          {["pending", "confirmed", "dismissed"].map((s) => (
            <FilterPill key={s} active={status === s} onClick={() => { setStatus(s); setPage(1); }}>
              {s}
            </FilterPill>
          ))}
        </div>
        <div className="w-px h-4 bg-border" />
        <div className="flex items-center gap-2">
          <span className="text-xs text-text-tertiary font-mono">min similarity:</span>
          {[
            { label: "80%+", val: 0.80 },
            { label: "92%+", val: 0.92 },
            { label: "95%+", val: 0.95 },
            { label: "97%+", val: 0.97 },
          ].map(({ label, val }) => (
            <FilterPill key={val} active={minSim === val} onClick={() => { setMinSim(val); setPage(1); }}>
              {label}
            </FilterPill>
          ))}
        </div>
        <div className="w-px h-4 bg-border" />
        <input
          type="text"
          placeholder="Filter by repo…"
          value={repoFilter}
          onChange={(e) => { setRepo(e.target.value); setPage(1); }}
          className="bg-surface-2 border border-border rounded px-3 py-1.5 text-xs text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent-green/60 w-48 font-mono"
        />
        <span className="text-xs text-text-tertiary font-mono ml-auto">
          {meta.total != null ? `${meta.total} signals` : ""}
        </span>
      </div>

      {/* Signal list */}
      <div className="px-6 py-4">
        <div className="card overflow-hidden">
          {isLoading && (
            <div className="p-4 space-y-3">
              {[...Array(8)].map((_, i) => <Skeleton key={i} className="h-20" />)}
            </div>
          )}
          {!isLoading && !signals.length && (
            <EmptyState
              icon="⊗"
              title={status === "pending" ? "No pending signals" : `No ${status} signals`}
              body={
                status === "pending"
                  ? "New issues are automatically compared as they arrive. Run a backfill to scan existing issues."
                  : "Signals will appear here as issues are opened."
              }
            />
          )}
          {signals.map((signal: ApiItem) => (
            <SignalRow key={signal.id} signal={signal} onAction={refresh} />
          ))}

          {meta.total_pages > 1 && (
            <div className="flex items-center justify-between px-4 py-3 border-t border-border">
              <span className="text-xs text-text-tertiary font-mono">
                {meta.total} signals · page {meta.page}/{meta.total_pages}
              </span>
              <div className="flex gap-2">
                <button className="px-3 py-1 text-xs rounded border border-border text-text-secondary hover:text-text-primary disabled:opacity-50" disabled={page <= 1} onClick={() => setPage(p => p - 1)}>← prev</button>
                <button className="px-3 py-1 text-xs rounded border border-border text-text-secondary hover:text-text-primary disabled:opacity-50" disabled={page >= meta.total_pages} onClick={() => setPage(p => p + 1)}>next →</button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* How it works */}
      <div className="px-6 pb-6">
        <div className="card p-4">
          <div className="text-[10px] font-mono text-text-tertiary uppercase tracking-wider mb-3">How it works</div>
          <div className="grid grid-cols-4 gap-4">
            {[
              { step: "1", title: "Issue opened", body: "Webhook triggers triage worker within seconds" },
              { step: "2", title: "Embedding generated", body: "Title + body encoded into a 512-dim vector via Voyage AI" },
              { step: "3", title: "Cosine similarity", body: "New vector compared against all open issues in the repo" },
              { step: "4", title: "Signal posted", body: "GitHub comment + label applied if similarity ≥ 92%" },
            ].map((s) => (
              <div key={s.step} className="flex gap-3">
                <div className="w-6 h-6 rounded bg-surface-3 border border-border flex items-center justify-center font-mono text-xs text-text-tertiary shrink-0 mt-0.5">
                  {s.step}
                </div>
                <div>
                  <div className="text-sm font-medium text-text-primary mb-0.5">{s.title}</div>
                  <div className="text-xs text-text-tertiary leading-relaxed">{s.body}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
