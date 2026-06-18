"use client";

import useSWR from "swr";
import { useApi, fetcher, API } from "@/lib/api";
import {
  PageHeader, StatCard, Badge, CIBadge, HealthBadge, MiniBar,
  Skeleton, EmptyState,
} from "@/components/ui";
import SetupChecklist from "@/components/SetupChecklist";
import { formatDistanceToNow } from "date-fns";
import Link from "next/link";

export default function DashboardPage() {
  // ── 5 data sources for the overview ──
  // Overview is a single object (not array), so use raw SWR
  const { data: overview, isLoading: ol } = useSWR(API.insights(), fetcher, { refreshInterval: 30000 });
  // Repos is an array
  const { data: reposData, isLoading: rl } = useApi<any>(API.insightRepos(), { refreshInterval: 60000 });
  // Issues and CI runs are arrays
  const { data: recentIssues, isLoading: issl } = useApi<any>(API.issues("state=open&per_page=5"), { refreshInterval: 20000 });
  const { data: recentRuns, isLoading: crl } = useApi<any>(API.ciRuns("per_page=5"), { refreshInterval: 10000 });

  // Activity summary (raw object shape)
  const { data: actSummary, isLoading: asl } = useSWR(API.activitySummary(), fetcher, { refreshInterval: 30000 });

  // Readiness scores (raw object shape)
  const { data: readinessData, isLoading: rdl } = useSWR(API.readiness(), fetcher, { refreshInterval: 120000 });

  // Decisions summary (raw object shape)
  const { data: decSummary, isLoading: dsl } = useSWR(API.decisionsSummary(), fetcher, { refreshInterval: 30000 });

  // ── Computed values ──
  const totalRepos = overview?.repos?.total ?? readinessData?.total_repos ?? null;
  const fleetScore = readinessData?.average_score ?? null;
  const last24h = actSummary?.recent?.last_24h ?? null;
  const totalActions = actSummary?.total ?? null;

  // Top / bottom repos by readiness
  const readinessRepos = readinessData?.repos ?? [];
  const topRepos = [...readinessRepos].sort((a: any, b: any) => b.score - a.score).slice(0, 5);
  const bottomRepos = [...readinessRepos].sort((a: any, b: any) => a.score - b.score).slice(0, 5);

  // Decision counts
  const decisionCounts = decSummary?.data ?? [];
  const totalActed = decisionCounts.reduce((sum: number, d: any) => sum + (d.acted ?? 0), 0);
  const totalSkipped = decisionCounts.reduce((sum: number, d: any) => sum + (d.skipped ?? 0), 0);
  const totalBlocked = decisionCounts.reduce((sum: number, d: any) => sum + (d.blocked ?? 0), 0);

  return (
    <div className="animate-fade-in">
      {/* ── First-run setup checklist (auto-hides when ready) ── */}
      <SetupChecklist />

      {/* ── Gradient accent bar ── */}
      <div className="h-0.5 bg-gradient-to-r from-accent-green via-accent-blue to-accent-purple" />

      <PageHeader
        title="Dashboard"
        subtitle="Real-time overview across all repositories"
        actions={
          <div className="flex items-center gap-3">
            {actSummary?.recent?.last_24h != null && (
              <div className="flex items-center gap-1.5 text-xs font-mono text-text-tertiary">
                <span className="w-1.5 h-1.5 rounded-full bg-accent-green animate-pulse-dot" />
                <span>{last24h ?? 0} events (24h)</span>
              </div>
            )}
            <Link href="/deliveries" className="btn text-xs">Deliveries</Link>
            <Link href="/gates" className="btn btn-primary text-xs">Gates</Link>
          </div>
        }
      />

      {/* ── Hero stats row ── */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 px-6 py-4 border-b border-border">
        <StatCard label="Repos" value={totalRepos} loading={ol && rdl} accent="blue" />
        <StatCard label="Open Issues" value={overview?.issues?.open} loading={ol} />
        <StatCard label="Open PRs" value={overview?.prs?.open} loading={ol} />
        <StatCard
          label="CI Pass Rate"
          value={overview?.ci?.pass_rate != null ? `${overview.ci.pass_rate}%` : null}
          loading={ol}
          accent={overview?.ci?.pass_rate >= 90 ? "green" : "amber"}
        />
        <StatCard label="Actions (24h)" value={last24h} loading={asl} accent="purple" />
        <StatCard
          label="Fleet Readiness"
          value={fleetScore != null ? `${fleetScore}/100` : null}
          loading={rdl}
          accent={fleetScore != null && fleetScore >= 70 ? "green" : fleetScore != null && fleetScore >= 40 ? "amber" : "red"}
        />
      </div>

      {/* ── Two-column layout ── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-0 lg:gap-0">

        {/* Left: Recent issues */}
        <div className="border-b lg:border-b-0 lg:border-r border-border">
          <div className="px-6 py-4 border-b border-border flex items-center justify-between">
            <div className="text-[10px] font-mono text-text-tertiary uppercase tracking-wider">Recent issues</div>
            <Link href="/issues" className="text-xs font-mono text-accent-green hover:underline">view all →</Link>
          </div>
          <div className="divide-y divide-border">
            {issl && [...Array(3)].map((_, i) => (
              <div key={i} className="px-6 py-3"><Skeleton className="h-12" /></div>
            ))}
            {!issl && !recentIssues.length && (
              <EmptyState icon="◎" title="No issues" body="Issues will appear here after sync." />
            )}
            {recentIssues.map((issue: any) => (
              <div key={String(issue.github_id)} className="px-6 py-3 hover:bg-surface-2/50 transition-colors">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-medium text-text-primary leading-snug line-clamp-1">{String(issue.title)}</span>
                  {issue.triage_type && <Badge variant={String(issue.triage_type) === "bug" ? "red" : "blue"}>{String(issue.triage_type)}</Badge>}
                  {issue.triage_priority && <Badge variant={String(issue.triage_priority) === "critical" ? "red" : String(issue.triage_priority) === "high" ? "amber" : "default"}>{String(issue.triage_priority)}</Badge>}
                </div>
                <div className="flex items-center gap-3 mt-1">
                  <span className="font-mono text-[11px] text-text-tertiary">
                    {String(issue.repo_full_name)}#{String(issue.number)}
                  </span>
                  <span className="text-[11px] text-text-tertiary">
                    {issue.created_at ? formatDistanceToNow(new Date(String(issue.created_at)), { addSuffix: true }) : ""}
                  </span>
                  {issue.triaged_at && <span className="text-[10px] text-accent-green/70 font-mono">✓ triaged</span>}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Right: Recent CI runs */}
        <div>
          <div className="px-6 py-4 border-b border-border flex items-center justify-between">
            <div className="text-[10px] font-mono text-text-tertiary uppercase tracking-wider">Recent CI runs</div>
            <Link href="/ci" className="text-xs font-mono text-accent-green hover:underline">view all →</Link>
          </div>
          <div className="divide-y divide-border">
            {crl && [...Array(3)].map((_, i) => (
              <div key={i} className="px-6 py-3"><Skeleton className="h-12" /></div>
            ))}
            {!crl && !recentRuns.length && (
              <EmptyState icon="⚙" title="No CI runs" body="Runs will appear after webhook events." />
            )}
            {recentRuns.map((run: any) => (
              <div key={String(run.id)} className="px-6 py-3 hover:bg-surface-2/50 transition-colors">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-mono text-sm font-medium text-text-primary">{String(run.repo_name ?? "")}</span>
                  <span className="text-text-tertiary font-mono text-xs">·</span>
                  <span className="font-mono text-xs text-text-secondary">{String(run.branch ?? "")}</span>
                  <CIBadge conclusion={String(run.conclusion ?? "")} healStatus={run.heal_status === "healed" ? "healed" : undefined} />
                </div>
                {run.heal_root_cause && (
                  <div className="mt-1 text-xs font-mono text-text-tertiary line-clamp-1">
                    {run.heal_status === "healed" && "⚡ "}
                    {String(run.heal_root_cause)}
                  </div>
                )}
                <div className="mt-1 text-[10px] text-text-tertiary font-mono">
                  {run.created_at ? formatDistanceToNow(new Date(String(run.created_at)), { addSuffix: true }) : ""}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* ── Decisions summary row ── */}
      <div className="px-6 py-4 border-b border-border">
        <div className="flex items-center justify-between mb-3">
          <div className="text-[10px] font-mono text-text-tertiary uppercase tracking-wider">Decision Summary</div>
          <Link href="/decisions" className="text-xs font-mono text-accent-green hover:underline">view all →</Link>
        </div>
        <div className="grid grid-cols-3 gap-3">
          <div className="card p-3 flex items-center gap-3">
            <div className="text-2xl font-display font-bold text-accent-green tabular-nums">{dsl ? "—" : totalActed}</div>
            <div>
              <div className="text-xs font-mono text-text-tertiary uppercase">Acted</div>
              <div className="text-[10px] text-text-tertiary">Actions taken</div>
            </div>
          </div>
          <div className="card p-3 flex items-center gap-3">
            <div className="text-2xl font-display font-bold text-accent-amber tabular-nums">{dsl ? "—" : totalSkipped}</div>
            <div>
              <div className="text-xs font-mono text-text-tertiary uppercase">Skipped</div>
              <div className="text-[10px] text-text-tertiary">Policy / filter</div>
            </div>
          </div>
          <div className="card p-3 flex items-center gap-3">
            <div className="text-2xl font-display font-bold text-accent-red tabular-nums">{dsl ? "—" : totalBlocked}</div>
            <div>
              <div className="text-xs font-mono text-text-tertiary uppercase">Blocked</div>
              <div className="text-[10px] text-text-tertiary">Dry run / policy</div>
            </div>
          </div>
        </div>
      </div>

      {/* ── Fleet readiness table ── */}
      {readinessRepos.length > 0 && (
        <div className="px-6 py-5">
          <div className="flex items-center justify-between mb-3">
            <div className="text-[10px] font-mono text-text-tertiary uppercase tracking-wider">Fleet Readiness</div>
            <Link href="/readiness" className="text-xs font-mono text-accent-green hover:underline">view all →</Link>
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {/* Top 5 */}
            <div className="card overflow-hidden">
              <div className="px-4 py-2 border-b border-border text-[10px] font-mono text-accent-green uppercase tracking-wider">Top Repos</div>
              <div className="divide-y divide-border">
                {topRepos.map((r: any) => (
                  <Link key={r.repo} href={`/readiness/${r.owner}/${r.name}`} className="flex items-center justify-between px-4 py-2.5 hover:bg-surface-2/40 transition-colors">
                    <span className="font-mono text-xs text-text-primary truncate">{r.repo}</span>
                    <div className="flex items-center gap-2">
                      <MiniBar value={r.score} />
                    </div>
                  </Link>
                ))}
              </div>
            </div>
            {/* Bottom 5 */}
            <div className="card overflow-hidden">
              <div className="px-4 py-2 border-b border-border text-[10px] font-mono text-accent-red uppercase tracking-wider">Needs Attention</div>
              <div className="divide-y divide-border">
                {bottomRepos.map((r: any) => (
                  <Link key={r.repo} href={`/readiness/${r.owner}/${r.name}`} className="flex items-center justify-between px-4 py-2.5 hover:bg-surface-2/40 transition-colors">
                    <span className="font-mono text-xs text-text-primary truncate">{r.repo}</span>
                    <div className="flex items-center gap-2">
                      <MiniBar value={r.score} />
                    </div>
                  </Link>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Repo health quick table (from insights/repos) ── */}
      {reposData?.length > 0 && (
        <div className="px-6 py-5 border-t border-border">
          <div className="text-[10px] font-mono text-text-tertiary uppercase tracking-wider mb-3">Repository health</div>
          <div className="card overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-[10px] font-mono text-text-tertiary uppercase tracking-wider">
                    <th className="text-left px-4 py-2.5 font-medium">Repository</th>
                    <th className="text-right px-4 py-2.5 font-medium">Issues</th>
                    <th className="text-right px-4 py-2.5 font-medium">PRs</th>
                    <th className="text-left px-4 py-2.5 font-medium w-40">CI pass rate</th>
                    <th className="text-left px-4 py-2.5 font-medium">Health</th>
                  </tr>
                </thead>
                <tbody>
                  {reposData.map((repo: any) => (
                    <tr key={String(repo.full_name)} className="border-b border-border last:border-0 hover:bg-surface-2/40 transition-colors">
                      <td className="px-4 py-2.5 font-mono text-xs text-text-primary font-medium">{String(repo.full_name)}</td>
                      <td className="px-4 py-2.5 text-right font-mono text-xs text-text-secondary">{String(repo.open_issues ?? 0)}</td>
                      <td className="px-4 py-2.5 text-right font-mono text-xs text-text-secondary">{String(repo.open_prs ?? 0)}</td>
                      <td className="px-4 py-2.5 w-40"><MiniBar value={Number(repo.ci_pass_rate)} /></td>
                      <td className="px-4 py-2.5"><HealthBadge status={String(repo.health_status ?? "active")} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
