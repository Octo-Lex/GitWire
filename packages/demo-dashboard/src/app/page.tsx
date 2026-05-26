"use client";

import Link from "next/link";
import { REPOS, LANDING_STATS, ACTIVITY_FEED, CI_RUNS, GATES } from "@/lib/mock-data";
import { StatCard, MiniBar, HealthBadge, Badge } from "@/components/ui";
import { formatDistanceToNow } from "date-fns";

export default function DashboardPage() {
  const failedRuns = CI_RUNS.filter((r) => r.conclusion === "failure").length;
  const openGates = GATES.filter((g) => !g.passing).length;
  const recentActivity = ACTIVITY_FEED.slice(0, 5);

  return (
    <div className="animate-fade-in">
      <div className="px-6 pt-6 pb-4 border-b border-border">
        <h1 className="text-2xl font-display font-bold text-text-primary">Dashboard</h1>
        <p className="text-sm text-text-secondary mt-1">Governance overview across 8 repositories</p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 px-6 py-5">
        <StatCard label="Repositories" value={LANDING_STATS.repos} />
        <StatCard label="Actions Taken" value={LANDING_STATS.actions_taken} accent="true" />
        <StatCard label="CI Healed" value={LANDING_STATS.ci_healed} />
        <StatCard label="Decisions" value={LANDING_STATS.decisions_made} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 px-6 pb-6">
        {/* Repo health */}
        <div className="card">
          <div className="px-4 py-3 border-b border-border">
            <h2 className="text-sm font-bold text-text-primary">Repository Health</h2>
          </div>
          {REPOS.map((repo) => (
            <Link key={repo.github_id} href={`/readiness`} className="flex items-center justify-between px-4 py-2.5 border-b border-border last:border-0 hover:bg-surface-2/40 transition-colors">
              <div className="flex items-center gap-3">
                <HealthBadge status={repo.health_status} />
                <div>
                  <div className="text-sm font-mono text-text-primary">{repo.full_name}</div>
                  <div className="text-xs text-text-tertiary">{repo.language}</div>
                </div>
              </div>
              <MiniBar value={repo.ci_pass_rate} />
            </Link>
          ))}
        </div>

        {/* Recent activity */}
        <div className="card">
          <div className="px-4 py-3 border-b border-border">
            <h2 className="text-sm font-bold text-text-primary">Recent Activity</h2>
          </div>
          {recentActivity.map((item) => (
            <div key={item.id} className="flex items-start gap-3 px-4 py-2.5 border-b border-border last:border-0">
              <span className="text-sm mt-0.5">
                {item.type === "success" ? "✅" : item.type === "warning" ? "⚠️" : item.type === "muted" ? "⊘" : "ℹ️"}
              </span>
              <div className="flex-1 min-w-0">
                <div className="text-sm text-text-primary">{item.message}</div>
                <div className="text-xs text-text-tertiary mt-0.5">
                  <span className="font-mono">{item.repo}</span> · {formatDistanceToNow(new Date(item.ts), { addSuffix: true })}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Quick stats row */}
      <div className="grid grid-cols-3 gap-4 px-6 pb-8">
        <Link href="/ci" className="card hover:border-accent-green/40 transition-colors">
          <div className="px-4 py-3 text-center">
            <div className="text-2xl font-bold text-red-400">{failedRuns}</div>
            <div className="text-xs text-text-tertiary mt-1">Failed CI Runs</div>
          </div>
        </Link>
        <Link href="/gates" className="card hover:border-accent-green/40 transition-colors">
          <div className="px-4 py-3 text-center">
            <div className="text-2xl font-bold text-amber-400">{openGates}</div>
            <div className="text-xs text-text-tertiary mt-1">Failing Quality Gates</div>
          </div>
        </Link>
        <Link href="/actions" className="card hover:border-accent-green/40 transition-colors">
          <div className="px-4 py-3 text-center">
            <div className="text-2xl font-bold text-accent-green">{LANDING_STATS.avg_confidence}</div>
            <div className="text-xs text-text-tertiary mt-1">Avg Decision Confidence</div>
          </div>
        </Link>
      </div>
    </div>
  );
}
