"use client";

import { ApiItem } from "@/lib/types";

import useSWR from "swr";

import { fetcher, API } from "@/lib/api";
import {
  PageHeader, StatCard, Badge, CIBadge, HealthBadge, MiniBar,
  Skeleton, EmptyState,
} from "@/components/ui";
import { formatDistanceToNow } from "date-fns";
import Link from "next/link";
import clsx from "clsx";

export default function DashboardPage() {
  const { data: overview, isLoading: ol } = useSWR(API.insights(), fetcher, { refreshInterval: 30000 });
  const { data: repos, isLoading: rl } = useSWR(API.insightRepos(), fetcher, { refreshInterval: 60000 });
  const { data: issueStats, isLoading: il } = useSWR(API.issueStats(), fetcher, { refreshInterval: 30000 });
  const { data: ciStats, isLoading: cl } = useSWR(API.ciStats(), fetcher, { refreshInterval: 15000 });
  const { data: issuesData, isLoading: issl } = useSWR(API.issues("state=open&per_page=5"), fetcher, { refreshInterval: 20000 });
  const { data: ciRunsData, isLoading: crl } = useSWR(API.ciRuns("per_page=5"), fetcher, { refreshInterval: 10000 });

  const recentIssues = issuesData?.data ?? [];
  const recentRuns = ciRunsData?.data ?? [];

  return (
    <div className="animate-fade-in">
      <PageHeader
        title="Dashboard"
        subtitle="Real-time overview across all repositories"
      />

      {/* Stats row */}
      <div className="grid grid-cols-6 gap-3 px-6 py-4 border-b border-border">
        <StatCard label="Repos"       value={overview?.repos?.total}         loading={ol} accent="blue" />
        <StatCard label="Open issues"  value={overview?.issues?.open}         loading={ol} />
        <StatCard label="Critical"     value={overview?.issues?.critical}     loading={ol} accent="red" />
        <StatCard label="Open PRs"     value={overview?.prs?.open}            loading={ol} />
        <StatCard label="CI pass rate" value={overview?.ci?.pass_rate != null ? `${overview.ci.pass_rate}%` : null} loading={ol} accent={overview?.ci?.pass_rate >= 90 ? "green" : "amber"} />
        <StatCard label="Auto-healed"  value={overview?.ci?.auto_healed}      loading={ol} accent="purple" />
      </div>

      {/* Two-column layout */}
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
            {recentIssues.map((issue: ApiItem) => (
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
            {recentRuns.map((run: ApiItem) => (
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

      {/* Repo health quick table */}
      {repos?.length > 0 && (
        <div className="px-6 py-5">
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
                  {repos.map((repo: ApiItem) => (
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
