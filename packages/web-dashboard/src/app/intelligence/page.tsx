"use client";

import { useState } from "react";
import useSWR from "swr";
import {
  BarChart, Bar, LineChart, Line,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
} from "recharts";
import { fetcher } from "../../lib/api";
import {
  PageHeader, StatCard, Badge, Skeleton, EmptyState, FilterPill,
} from "../../components/ui";
import { formatDistanceToNow, format, parseISO, subDays } from "date-fns";
import clsx from "clsx";

const BASE = process.env.NEXT_PUBLIC_API_URL || "";
const API_KEY = process.env.NEXT_PUBLIC_API_KEY || "";

function authHeaders(extra?: Record<string, string>): Record<string, string> {
  return {
    ...(API_KEY ? { Authorization: `Bearer ${API_KEY}` } : {}),
    ...extra,
  };
}

// ── Chart tooltip ──────────────────────────────────────────────────────────
function ChartTip({ active, payload, label }: { active?: boolean; payload?: Array<{ name: string; value: number; color: string }>; label?: string }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-surface-2 border border-border rounded px-3 py-2 text-xs font-mono shadow-xl">
      <div className="text-text-tertiary mb-1">{label}</div>
      {payload.map(p => (
        <div key={p.name} style={{ color: p.color }}>{p.name}: {p.value}</div>
      ))}
    </div>
  );
}

// ── Verdict badge ──────────────────────────────────────────────────────────
function VerdictBadge({ verdict }: { verdict: string }) {
  const map: Record<string, { label: string; variant: string }> = {
    approved:         { label: "approved",          variant: "green"   },
    needs_discussion: { label: "needs discussion",  variant: "amber"   },
    request_changes:  { label: "changes requested", variant: "red"     },
  };
  const { label, variant } = map[verdict] ?? { label: verdict, variant: "default" };
  return <Badge variant={variant as "green" | "amber" | "red" | "default"}>{label}</Badge>;
}

// ── Severity chip ─────────────────────────────────────────────────────────
function SeverityChip({ severity }: { severity: string }) {
  const colors: Record<string, string> = {
    critical: "bg-accent-red/10 border-accent-red/25 text-accent-red",
    high:     "bg-accent-amber/10 border-accent-amber/25 text-accent-amber",
    medium:   "bg-accent-blue/10 border-accent-blue/25 text-accent-blue",
    low:      "bg-surface-3 border-border text-text-secondary",
    info:     "bg-surface-3 border-border text-text-tertiary",
  };
  return (
    <span className={clsx("text-[10px] font-mono px-1.5 py-0.5 rounded border", colors[severity] ?? colors.info)}>
      {severity}
    </span>
  );
}

// ── Category badge ─────────────────────────────────────────────────────────
function CategoryBadge({ category }: { category: string }) {
  const map: Record<string, { label: string; variant: string }> = {
    ai_decision:             { label: "AI decision",   variant: "purple" },
    auto_merge:              { label: "Auto merge",    variant: "green"  },
    policy_bypass:           { label: "Policy bypass", variant: "red"    },
    branch_rule:             { label: "Branch rule",   variant: "blue"   },
    heal:                    { label: "CI heal",       variant: "purple" },
    rollback:                { label: "Rollback",      variant: "amber"  },
    vulnerability_dismissed: { label: "Vuln dismissed",variant: "amber"  },
    quarantine:              { label: "Quarantine",    variant: "blue"   },
    review_gate:             { label: "Review gate",   variant: "red"    },
    config_change:           { label: "Config change", variant: "default"},
  };
  const { label, variant } = map[category] ?? { label: category, variant: "default" };
  return <Badge variant={variant as "purple" | "green" | "red" | "blue" | "amber" | "default"}>{label}</Badge>;
}

// ════════════════════════════════════════════════════════════════════════════
// Tab: AI Review Gate
// ════════════════════════════════════════════════════════════════════════════
function ReviewTab() {
  const [verdict, setVerdict] = useState("");
  const [repo, setRepo] = useState("");
  const [page, setPage] = useState(1);
  const [configRepo, setConfigRepo] = useState("");
  const [configView, setConfigView] = useState(false);
  const [configForm, setConfigForm] = useState<Record<string, unknown> | null>(null);
  const [saving, setSaving] = useState(false);
  const [expanded, setExpanded] = useState<number | null>(null);

  const { data: stats } = useSWR("/api/review/stats", fetcher, { refreshInterval: 30000 });

  const qs = new URLSearchParams({ per_page: "20", page: String(page) });
  if (verdict) qs.set("verdict", verdict);
  if (repo) qs.set("repo", repo);

  const { data, isLoading } = useSWR(`/api/review/results?${qs}`, fetcher, { refreshInterval: 20000 });
  const reviews = data?.data ?? [];
  const meta = data?.meta ?? {};

  const trendData = stats?.verdict_trend?.map((d: { day: string; approved: number; blocked: number }) => ({
    day: format(parseISO(d.day), "MMM d"),
    approved: Number(d.approved),
    blocked: Number(d.blocked),
  })) ?? [];

  async function loadConfig(repoFullName: string) {
    const [owner, name] = repoFullName.split("/");
    const res = await fetch(`${BASE}/api/review/config/${owner}/${name}`, { headers: authHeaders() });
    const cfg = await res.json();
    setConfigForm(cfg);
    setConfigRepo(repoFullName);
    setConfigView(true);
  }

  async function saveConfig() {
    if (!configForm || !configRepo) return;
    setSaving(true);
    try {
      const [owner, name] = configRepo.split("/");
      await fetch(`${BASE}/api/review/config/${owner}/${name}`, {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify(configForm),
      });
      setConfigView(false);
    } finally { setSaving(false); }
  }

  async function triggerReview(repoFullName: string, prNumber: number) {
    const [owner, name] = repoFullName.split("/");
    await fetch(`${BASE}/api/review/trigger/${owner}/${name}/${prNumber}`, {
      method: "POST",
      headers: authHeaders(),
    });
  }

  function Toggle({ label, field }: { label: string; field: string }) {
    return (
      <label className="flex items-center justify-between py-1 cursor-pointer">
        <span className="text-sm text-text-secondary">{label}</span>
        <button
          onClick={() => setConfigForm(f => f ? { ...f, [field]: !f[field] } : f)}
          className={clsx("w-9 h-5 rounded-full transition-all relative flex-shrink-0",
            configForm?.[field] ? "bg-accent-green/80" : "bg-surface-4")}>
          <span className={clsx("absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all",
            configForm?.[field] ? "left-4" : "left-0.5")} />
        </button>
      </label>
    );
  }

  return (
    <div className="px-6 py-4 space-y-4">
      {/* Stats */}
      <div className="grid grid-cols-5 gap-3">
        <StatCard label="Reviews (30d)" value={stats?.summary?.total_reviews} loading={!stats} />
        <StatCard label="Approved" value={stats?.summary?.approved} loading={!stats} accent="green" />
        <StatCard label="Changes requested" value={stats?.summary?.request_changes} loading={!stats} accent="red" />
        <StatCard label="Avg duration" value={stats?.summary?.avg_duration_s != null ? `${stats.summary.avg_duration_s}s` : null} loading={!stats} />
        <StatCard label="Avg tokens" value={stats?.summary?.avg_tokens} loading={!stats} accent="purple" />
      </div>

      {/* Verdict trend chart */}
      {trendData.length > 0 && (
        <div className="card p-4">
          <div className="text-[10px] font-mono text-text-tertiary uppercase tracking-wider mb-3">
            Review verdicts — last 14 days
          </div>
          <ResponsiveContainer width="100%" height={140}>
            <BarChart data={trendData} margin={{ top: 4, right: 4, left: -24, bottom: 0 }} barSize={8} barGap={2}>
              <CartesianGrid strokeDasharray="3 3" stroke="#2e2e36" vertical={false} />
              <XAxis dataKey="day" tick={{ fontSize: 9, fontFamily: "JetBrains Mono", fill: "#5a5a6e" }} axisLine={false} tickLine={false} interval="preserveStartEnd" />
              <YAxis tick={{ fontSize: 9, fontFamily: "JetBrains Mono", fill: "#5a5a6e" }} axisLine={false} tickLine={false} />
              <Tooltip content={<ChartTip />} />
              <Legend wrapperStyle={{ fontSize: "10px", fontFamily: "JetBrains Mono", color: "#8e8ea0" }} />
              <Bar dataKey="approved" fill="#00d97e" fillOpacity={0.8} radius={[2, 2, 0, 0]} />
              <Bar dataKey="blocked" fill="#ff4d6a" fillOpacity={0.8} radius={[2, 2, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Config panel */}
      {configView && configForm && (
        <div className="card p-4 space-y-3 border-accent-purple/30 bg-accent-purple/5">
          <div className="flex items-center justify-between">
            <div className="font-display font-bold text-text-primary">AI Review Config</div>
            <button onClick={() => setConfigView(false)} className="text-xs text-text-tertiary hover:text-text-primary">✕</button>
          </div>
          <div className="divide-y divide-border">
            <Toggle label="Enabled" field="enabled" />
            <Toggle label="Logic review" field="check_logic" />
            <Toggle label="Security review" field="check_security" />
            <Toggle label="Architecture review" field="check_architecture" />
            <Toggle label="Cost leak detection" field="check_cost_leaks" />
            <Toggle label="Test coverage check" field="check_tests" />
          </div>
          <div>
            <label className="text-xs font-mono text-text-tertiary block mb-1">Architecture context (injected into prompt)</label>
            <textarea
              value={(configForm.architecture_context as string) ?? ""}
              onChange={e => setConfigForm(f => f ? { ...f, architecture_context: e.target.value } : f)}
              rows={3}
              placeholder="e.g. This is a microservices app. All DB access goes through the repository layer..."
              className="w-full bg-surface-2 border border-border rounded px-3 py-2 text-xs text-text-primary font-mono focus:outline-none focus:border-accent-green/60 resize-none"
            />
          </div>
          <div className="flex justify-end gap-2">
            <button className="btn text-xs" onClick={() => setConfigView(false)}>cancel</button>
            <button className="btn-primary text-xs" disabled={saving} onClick={saveConfig}>
              {saving ? "saving…" : "save config"}
            </button>
          </div>
        </div>
      )}

      {/* Filters */}
      <div className="flex items-center gap-2 flex-wrap">
        {["", "approved", "needs_discussion", "request_changes"].map(v => (
          <FilterPill key={v || "all"} active={verdict === v} onClick={() => { setVerdict(v); setPage(1); }}>
            {v ? v.replace(/_/g, " ") : "all"}
          </FilterPill>
        ))}
        <input type="text" placeholder="Filter by repo…" value={repo}
          onChange={e => { setRepo(e.target.value); setPage(1); }}
          className="bg-surface-2 border border-border rounded px-3 py-1.5 text-xs text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent-green/60 w-44 font-mono ml-auto" />
        {repo.includes("/") && (
          <button onClick={() => loadConfig(repo)} className="btn text-xs">⚙ config</button>
        )}
      </div>

      {/* Review list */}
      <div className="card overflow-hidden">
        {isLoading && <div className="p-4 space-y-3">{[...Array(6)].map((_, i) => <Skeleton key={i} className="h-20" />)}</div>}
        {!isLoading && !reviews.length && (
          <EmptyState icon="◎" title="No reviews yet"
            body="Enable AI review for a repo and open a PR to see results here." />
        )}
        {reviews.map((r: Record<string, unknown>, idx: number) => (
          <div key={r.id as number}>
            <div
              className={clsx(
                "flex items-start gap-4 px-4 py-3 cursor-pointer hover:bg-surface-2/40 transition-colors",
                idx < reviews.length - 1 && expanded !== r.id && "border-b border-border"
              )}
              onClick={() => setExpanded(expanded === r.id ? null : r.id as number)}
            >
              <div className={clsx("w-0.5 self-stretch rounded-full flex-shrink-0", {
                "bg-accent-green": r.verdict === "approved",
                "bg-accent-amber": r.verdict === "needs_discussion",
                "bg-accent-red": r.verdict === "request_changes",
              })} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-mono text-sm font-medium text-text-primary">{r.repo_full_name as string}</span>
                  <span className="font-mono text-xs text-text-secondary">PR #{r.pr_number as number}</span>
                  <VerdictBadge verdict={r.verdict as string} />
                  <Badge variant="default">{r.confidence as string} confidence</Badge>
                </div>
                <div className="flex items-center gap-3 mt-1 flex-wrap">
                  <span className="text-xs text-text-tertiary">{r.files_reviewed as number} files · +{r.lines_added as number} -{r.lines_removed as number}</span>
                  {(r.finding_count as number) > 0 && (
                    <span className="text-xs text-text-secondary">{r.finding_count as number} finding{(r.finding_count as number) !== 1 ? "s" : ""}</span>
                  )}
                  {r.tokens_used != null && <span className="font-mono text-[10px] text-text-tertiary">{r.tokens_used as number} tokens</span>}
                  <span className="text-[10px] text-text-tertiary">
                    {formatDistanceToNow(new Date(r.started_at as string), { addSuffix: true })}
                  </span>
                </div>
                {r.summary != null && <div className="text-xs text-text-secondary mt-1 line-clamp-1">{r.summary as string}</div>}
              </div>
              <span className="text-text-tertiary text-xs flex-shrink-0 mt-1">{expanded === r.id ? "▲" : "▼"}</span>
            </div>
            {expanded === r.id && (
              <ReviewFindings review={r} onTrigger={() => triggerReview(r.repo_full_name as string, r.pr_number as number)} />
            )}
          </div>
        ))}
        {meta.total_pages > 1 && (
          <div className="flex items-center justify-between px-4 py-3 border-t border-border">
            <span className="text-xs text-text-tertiary font-mono">{meta.total} reviews</span>
            <div className="flex gap-2">
              <button className="btn text-xs" disabled={page <= 1} onClick={() => setPage(p => p - 1)}>← prev</button>
              <button className="btn text-xs" disabled={page >= meta.total_pages} onClick={() => setPage(p => p + 1)}>next →</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function ReviewFindings({ review, onTrigger }: { review: Record<string, unknown>; onTrigger: () => void }) {
  const findings = Array.isArray(review.findings) ? review.findings : [];

  return (
    <div className="bg-surface-0/50 border-b border-border px-4 pb-3 pt-0">
      <div className="ml-4 space-y-2 pt-3">
        {!findings.length && (
          <div className="text-xs text-text-tertiary italic">No findings — all checks passed.</div>
        )}
        {findings.map((f: Record<string, unknown>, i: number) => (
          <div key={i} className="bg-surface-1 border border-border rounded p-3">
            <div className="flex items-center gap-2 mb-1">
              <SeverityChip severity={f.severity as string} />
              <span className="text-xs font-mono text-text-tertiary">{f.category as string}</span>
              <span className="text-sm font-medium text-text-primary">{f.title as string}</span>
              {f.file != null && <span className="font-mono text-[10px] text-text-tertiary">{f.file as string}{f.line != null ? `:${f.line}` : ""}</span>}
            </div>
            <p className="text-xs text-text-secondary leading-relaxed">{f.description as string}</p>
            {f.suggestion && (
              <p className="text-xs text-accent-green/80 mt-1 leading-relaxed">→ {f.suggestion as string}</p>
            )}
          </div>
        ))}
        <button onClick={onTrigger} className="btn text-xs mt-1">↻ re-run review</button>
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// Tab: Compliance & Audit Trail
// ════════════════════════════════════════════════════════════════════════════
function AuditTab() {
  const [category, setCategory] = useState("");
  const [framework, setFramework] = useState("");
  const [actor, setActor] = useState("");
  const [page, setPage] = useState(1);
  const [chainResult, setChainResult] = useState<Record<string, unknown> | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [generating, setGenerating] = useState(false);

  const { data: stats } = useSWR("/api/audit/stats", fetcher, { refreshInterval: 30000 });

  const qs = new URLSearchParams({ per_page: "30", page: String(page) });
  if (category) qs.set("category", category);
  if (framework) qs.set("framework", framework);
  if (actor) qs.set("actor", actor);

  const { data, isLoading } = useSWR(`/api/audit/entries?${qs}`, fetcher, { refreshInterval: 15000 });
  const { data: reports, mutate: mutateReports } = useSWR("/api/audit/reports?per_page=10", fetcher);

  const entries = data?.data ?? [];
  const meta = data?.meta ?? {};

  const volumeData = stats?.daily_volume?.map((d: { day: string; entries: number }) => ({
    day: format(parseISO(d.day), "MMM d"),
    entries: Number(d.entries),
  })) ?? [];

  const CATEGORIES = ["", "ai_decision", "auto_merge", "policy_bypass", "branch_rule", "heal", "rollback", "vulnerability_dismissed", "quarantine", "review_gate"];
  const FRAMEWORKS = ["", "soc2", "iso27001"];

  async function doVerifyChain() {
    setVerifying(true);
    try {
      const res = await fetch(`${BASE}/api/audit/verify`, { headers: authHeaders() });
      setChainResult(await res.json());
    } finally { setVerifying(false); }
  }

  async function doGenerateReport(type: string) {
    setGenerating(true);
    try {
      const from = subDays(new Date(), 30).toISOString();
      const to = new Date().toISOString();
      await fetch(`${BASE}/api/audit/reports`, {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ report_type: type, from, to, generated_by: "dashboard" }),
      });
      setTimeout(() => mutateReports(), 2000);
    } finally { setGenerating(false); }
  }

  return (
    <div className="px-6 py-4 space-y-4">
      {/* Stats */}
      <div className="grid grid-cols-5 gap-3">
        <StatCard label="Total entries" value={stats?.totals?.total_entries} loading={!stats} />
        <StatCard label="Unique actors" value={stats?.totals?.unique_actors} loading={!stats} />
        <StatCard label="Repos covered" value={stats?.totals?.repos_covered} loading={!stats} />
        <StatCard label="Latest seq" value={stats?.totals?.latest_seq} loading={!stats} accent="purple" />
        <div className="card p-3 flex flex-col gap-1">
          <div className="text-[10px] font-mono text-text-tertiary uppercase tracking-wider">Chain integrity</div>
          {chainResult ? (
            <div className={clsx("text-sm font-medium", chainResult.valid ? "text-accent-green" : "text-accent-red")}>
              {chainResult.valid ? `✓ Valid (${chainResult.entries_checked} entries)` : `✗ Broken at seq ${chainResult.broken_at}`}
            </div>
          ) : (
            <button onClick={doVerifyChain} disabled={verifying} className="btn text-xs mt-1 disabled:opacity-50">
              {verifying ? "verifying…" : "verify chain"}
            </button>
          )}
        </div>
      </div>

      {/* Volume chart + framework breakdown */}
      <div className="grid grid-cols-3 gap-4">
        <div className="card p-4 col-span-2">
          <div className="text-[10px] font-mono text-text-tertiary uppercase tracking-wider mb-3">Daily audit volume</div>
          {volumeData.length === 0 ? <EmptyState icon="◈" title="No entries yet" /> :
            <ResponsiveContainer width="100%" height={130}>
              <BarChart data={volumeData} margin={{ top: 4, right: 4, left: -24, bottom: 0 }} barSize={10}>
                <CartesianGrid strokeDasharray="3 3" stroke="#2e2e36" vertical={false} />
                <XAxis dataKey="day" tick={{ fontSize: 9, fontFamily: "JetBrains Mono", fill: "#5a5a6e" }} axisLine={false} tickLine={false} interval="preserveStartEnd" />
                <YAxis tick={{ fontSize: 9, fontFamily: "JetBrains Mono", fill: "#5a5a6e" }} axisLine={false} tickLine={false} />
                <Tooltip content={<ChartTip />} />
                <Bar dataKey="entries" fill="#a78bfa" fillOpacity={0.8} radius={[2, 2, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          }
        </div>
        <div className="card p-4">
          <div className="text-[10px] font-mono text-text-tertiary uppercase tracking-wider mb-3">Framework coverage</div>
          {(stats?.by_framework ?? []).map((f: { framework: string; count: number }) => (
            <div key={f.framework} className="flex items-center justify-between py-1.5 border-b border-border last:border-0">
              <span className="font-mono text-xs text-text-primary uppercase">{f.framework}</span>
              <div className="flex items-center gap-2">
                <div className="w-20 h-1 bg-surface-3 rounded-full overflow-hidden">
                  <div className="h-full bg-accent-purple rounded-full"
                    style={{ width: `${Math.min(100, (Number(f.count) / (stats?.totals?.total_entries || 1)) * 100)}%` }} />
                </div>
                <span className="font-mono text-xs text-text-secondary w-8 text-right">{f.count}</span>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Compliance reports */}
      <div className="card p-4">
        <div className="flex items-center justify-between mb-3">
          <div className="text-[10px] font-mono text-text-tertiary uppercase tracking-wider">Compliance reports</div>
          <div className="flex gap-2">
            {["soc2", "iso27001"].map(t => (
              <button key={t} onClick={() => doGenerateReport(t)} disabled={generating}
                className="btn text-xs disabled:opacity-50">
                {generating ? "generating…" : `+ ${t.toUpperCase()}`}
              </button>
            ))}
          </div>
        </div>
        {!reports?.data?.length ? (
          <div className="text-xs text-text-tertiary italic">No reports generated yet. Click above to generate a 30-day report.</div>
        ) : (
          <div className="space-y-1">
            {reports.data.map((r: Record<string, unknown>) => (
              <div key={r.id as number} className="flex items-center gap-3 py-2 border-b border-border last:border-0">
                <Badge variant={r.report_type === "soc2" ? "blue" : "purple"}>{(r.report_type as string).toUpperCase()}</Badge>
                <span className="text-xs text-text-secondary flex-1">
                  {format(new Date(r.period_start as string), "MMM d")} — {format(new Date(r.period_end as string), "MMM d, yyyy")}
                </span>
                <span className="font-mono text-xs text-text-tertiary">{r.entry_count as number} entries</span>
                <span className="font-mono text-[10px] text-text-tertiary">{(r.report_hash as string)?.slice(0, 8)}…</span>
                <span className="text-[10px] text-text-tertiary">
                  {formatDistanceToNow(new Date(r.created_at as string), { addSuffix: true })}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Filters */}
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-xs text-text-tertiary font-mono">category:</span>
        {CATEGORIES.map(c => (
          <FilterPill key={c || "all"} active={category === c} onClick={() => { setCategory(c); setPage(1); }}>
            {c ? c.replace(/_/g, " ") : "all"}
          </FilterPill>
        ))}
        <div className="w-px h-4 bg-border" />
        {FRAMEWORKS.map(f => (
          <FilterPill key={f || "any"} active={framework === f} onClick={() => { setFramework(f); setPage(1); }}>
            {f ? f.toUpperCase() : "any"}
          </FilterPill>
        ))}
        <input type="text" placeholder="Filter by actor…" value={actor}
          onChange={e => { setActor(e.target.value); setPage(1); }}
          className="bg-surface-2 border border-border rounded px-3 py-1.5 text-xs text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent-green/60 w-36 font-mono ml-auto" />
      </div>

      {/* Trail entries */}
      <div className="card overflow-hidden">
        {isLoading && <div className="p-4 space-y-2">{[...Array(10)].map((_, i) => <Skeleton key={i} className="h-8" />)}</div>}
        {!isLoading && !entries.length && (
          <EmptyState icon="◈" title="No audit entries"
            body="Entries are written automatically as events occur across the platform." />
        )}
        {entries.map((e: Record<string, unknown>, idx: number) => (
          <div key={e.id as number} className={clsx(
            "flex items-center gap-3 px-4 py-2.5 hover:bg-surface-2/40 transition-colors text-xs",
            idx < entries.length - 1 && "border-b border-border"
          )}>
            <span className="font-mono text-text-tertiary w-10 flex-shrink-0 tabular-nums text-[10px]">
              #{e.seq as number}
            </span>
            <CategoryBadge category={e.category as string} />
            <span className="font-mono text-[10px] text-text-secondary flex-shrink-0">{(e.event_type as string).replace(/_/g, " ")}</span>
            <span className="text-text-tertiary flex-1 font-mono text-[10px] truncate">{e.repo_full_name as string}</span>
            {e.pr_number != null && <span className="font-mono text-[10px] text-text-tertiary">#{e.pr_number as number}</span>}
            <span className="font-mono text-[10px] text-text-secondary">@{(e.actor as string)?.replace("[bot]", "")}</span>
            {Array.isArray(e.framework) && (e.framework as string[]).length > 0 && (
              <span className="font-mono text-[10px] text-accent-purple/80">{(e.framework as string[]).join(",")}</span>
            )}
            <span className="font-mono text-[10px] text-text-tertiary flex-shrink-0">
              {formatDistanceToNow(new Date(e.occurred_at as string), { addSuffix: true })}
            </span>
          </div>
        ))}
        {meta.total_pages > 1 && (
          <div className="flex items-center justify-between px-4 py-3 border-t border-border">
            <span className="text-xs text-text-tertiary font-mono">{meta.total} entries</span>
            <div className="flex gap-2">
              <button className="btn text-xs" disabled={page <= 1} onClick={() => setPage(p => p - 1)}>← prev</button>
              <button className="btn text-xs" disabled={page >= meta.total_pages} onClick={() => setPage(p => p + 1)}>next →</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// Main page
// ════════════════════════════════════════════════════════════════════════════
const TABS = ["AI Review Gate", "Compliance & Audit Trail"];

export default function IntelligencePage() {
  const [tab, setTab] = useState("AI Review Gate");

  return (
    <div className="animate-fade-in">
      <PageHeader
        title="Intelligence & compliance"
        subtitle="Phase 4 · Pre-merge AI review gate + immutable audit trail"
      />
      <div className="flex gap-1 px-6 py-3 border-b border-border">
        {TABS.map(t => (
          <FilterPill key={t} active={tab === t} onClick={() => setTab(t)}>{t}</FilterPill>
        ))}
      </div>
      {tab === "AI Review Gate" && <ReviewTab />}
      {tab === "Compliance & Audit Trail" && <AuditTab />}
    </div>
  );
}
