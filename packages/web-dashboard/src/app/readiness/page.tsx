"use client";

import useSWR from "swr";
import { getReadiness } from "@/lib/api";
import { PageHeader, Skeleton } from "@/components/ui";
import { formatDistanceToNow } from "date-fns";
import clsx from "clsx";
import Link from "next/link";

function scoreColor(score: number) {
  if (score >= 80) return "text-accent-green";
  if (score >= 50) return "text-amber-400";
  return "text-red-400";
}

function scoreRing(score: number) {
  const circumference = 2 * Math.PI * 18;
  const offset = circumference - (score / 100) * circumference;
  const color = score >= 80 ? "#22c55e" : score >= 50 ? "#f59e0b" : "#ef4444";
  return { circumference, offset, color };
}

function CheckIcon({ pass }: { pass: boolean }) {
  return pass ? (
    <span className="text-accent-green text-xs">✓</span>
  ) : (
    <span className="text-text-tertiary text-xs">○</span>
  );
}

export default function ReadinessPage() {
  const { data, isLoading } = useSWR("/api/readiness", getReadiness, {
    refreshInterval: 60000,
  });

  const repos = data?.repos ?? [];
  const avgScore = data?.average_score ?? 0;
  const coverage = data?.check_coverage ?? {};
  const totalRepos = data?.total_repos ?? 0;

  return (
    <div className="animate-fade-in">
      <PageHeader
        title="Readiness"
        subtitle="How well each repo is configured for GitWire automation"
      />

      {/* Fleet overview */}
      <div className="grid grid-cols-4 gap-3 px-6 py-4 border-b border-border">
        <div className="flex flex-col items-center justify-center py-2">
          <div className="relative w-12 h-12">
            <svg className="w-12 h-12 -rotate-90" viewBox="0 0 40 40">
              <circle cx="20" cy="20" r="18" fill="none" stroke="currentColor" strokeWidth="3" className="text-bg-tertiary" />
              <circle
                cx="20" cy="20" r="18" fill="none"
                stroke={scoreRing(avgScore).color}
                strokeWidth="3"
                strokeDasharray={scoreRing(avgScore).circumference}
                strokeDashoffset={scoreRing(avgScore).offset}
                strokeLinecap="round"
              />
            </svg>
            <span className={clsx("absolute inset-0 flex items-center justify-center text-sm font-mono font-bold", scoreColor(avgScore))}>
              {avgScore}
            </span>
          </div>
          <span className="text-[9px] font-mono text-text-tertiary mt-1">FLEET AVG</span>
        </div>

        <div className="flex flex-col items-center justify-center py-2">
          <span className="text-2xl font-mono font-bold text-text-primary">{totalRepos}</span>
          <span className="text-[9px] font-mono text-text-tertiary mt-1">TOTAL REPOS</span>
        </div>

        <div className="flex flex-col items-center justify-center py-2">
          <span className="text-2xl font-mono font-bold text-accent-green">
            {repos.filter((r: any) => r.score >= 80).length}
          </span>
          <span className="text-[9px] font-mono text-text-tertiary mt-1">READY (≥80)</span>
        </div>

        <div className="flex flex-col items-center justify-center py-2">
          <span className="text-2xl font-mono font-bold text-red-400">
            {repos.filter((r: any) => r.score < 50).length}
          </span>
          <span className="text-[9px] font-mono text-text-tertiary mt-1">NEEDS WORK (&lt;50)</span>
        </div>
      </div>

      {/* Check coverage bar */}
      <div className="px-6 py-3 border-b border-border">
        <div className="text-[10px] font-mono text-text-tertiary uppercase tracking-wider mb-2">Check Coverage Across Fleet</div>
        <div className="space-y-1.5">
          {Object.entries(coverage).map(([id, info]: [string, any]) => {
            const pct = info.total > 0 ? Math.round((info.passed / info.total) * 100) : 0;
            return (
              <div key={id} className="flex items-center gap-2">
                <span className="text-[10px] font-mono text-text-secondary w-44 truncate">{info.label}</span>
                <div className="flex-1 h-1.5 bg-bg-tertiary rounded-full overflow-hidden">
                  <div
                    className={clsx("h-full rounded-full", pct >= 80 ? "bg-accent-green" : pct >= 50 ? "bg-amber-400" : "bg-red-400")}
                    style={{ width: `${pct}%` }}
                  />
                </div>
                <span className="text-[10px] font-mono text-text-tertiary w-16 text-right">{info.passed}/{info.total}</span>
              </div>
            );
          })}
        </div>
      </div>

      {/* Repo list with scores */}
      <div className="divide-y divide-border">
        {isLoading && [...Array(10)].map((_, i) => (
          <div key={i} className="px-6 py-3"><Skeleton className="h-12" /></div>
        ))}

        {repos.map((repo: any) => (
          <Link
            key={repo.repo}
            href={`/readiness/${repo.owner}/${repo.name}`}
            className="px-6 py-3 flex items-center gap-4 hover:bg-bg-secondary/50 transition-colors"
          >
            {/* Score ring */}
            <div className="relative w-9 h-9 shrink-0">
              <svg className="w-9 h-9 -rotate-90" viewBox="0 0 40 40">
                <circle cx="20" cy="20" r="18" fill="none" stroke="currentColor" strokeWidth="3" className="text-bg-tertiary" />
                <circle
                  cx="20" cy="20" r="18" fill="none"
                  stroke={scoreRing(repo.score).color}
                  strokeWidth="3"
                  strokeDasharray={scoreRing(repo.score).circumference}
                  strokeDashoffset={scoreRing(repo.score).offset}
                  strokeLinecap="round"
                />
              </svg>
              <span className={clsx("absolute inset-0 flex items-center justify-center text-[10px] font-mono font-bold", scoreColor(repo.score))}>
                {repo.score}
              </span>
            </div>

            {/* Repo info */}
            <div className="flex-1 min-w-0">
              <div className="text-xs font-medium text-text-primary truncate">{repo.repo}</div>
              <div className="flex items-center gap-2 mt-0.5">
                {repo.language && (
                  <span className="text-[10px] font-mono text-text-tertiary">{repo.language}</span>
                )}
                {repo.private && (
                  <span className="text-[10px] font-mono text-text-tertiary">🔒</span>
                )}
              </div>
            </div>

            {/* Mini check icons */}
            <div className="flex items-center gap-1 shrink-0">
              {repo.checks.slice(0, 6).map((check: any) => (
                <CheckIcon key={check.id} pass={check.pass} />
              ))}
            </div>

            {/* Synced time */}
            <div className="shrink-0 text-right">
              <span className="text-[9px] text-text-tertiary">
                {repo.last_synced_at
                  ? formatDistanceToNow(new Date(repo.last_synced_at), { addSuffix: true })
                  : "never synced"}
              </span>
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
