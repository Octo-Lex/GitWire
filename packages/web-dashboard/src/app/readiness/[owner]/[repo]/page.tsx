"use client";

import useSWR from "swr";
import { getRepoReadiness } from "@/lib/api";
import { PageHeader, Skeleton } from "@/components/ui";
import { useParams } from "next/navigation";
import clsx from "clsx";
import Link from "next/link";

function scoreRing(score: number) {
  const circumference = 2 * Math.PI * 40;
  const offset = circumference - (score / 100) * circumference;
  const color = score >= 80 ? "#22c55e" : score >= 50 ? "#f59e0b" : "#ef4444";
  return { circumference, offset, color };
}

export default function RepoReadinessPage() {
  const params = useParams();
  const owner = params?.owner as string;
  const repo = params?.repo as string;

  const { data, isLoading } = useSWR(
    owner && repo ? `/api/readiness/${owner}/${repo}` : null,
    () => getRepoReadiness(owner, repo),
    { refreshInterval: 30000 }
  );

  if (isLoading) {
    return (
      <div className="animate-fade-in">
        <PageHeader title="Readiness" subtitle="Loading..." />
        <div className="px-6 py-8"><Skeleton className="h-64" /></div>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="animate-fade-in">
        <PageHeader title="Readiness" subtitle="Repository not found" />
      </div>
    );
  }

  const ring = scoreRing(data.score);

  return (
    <div className="animate-fade-in">
      <div className="px-6 py-4 border-b border-border flex items-center gap-3">
        <Link href="/readiness" className="text-xs font-mono text-text-tertiary hover:text-text-secondary">
          ← Readiness
        </Link>
        <span className="text-xs font-mono text-text-tertiary">/</span>
        <span className="text-xs font-mono text-text-primary">{data.repo}</span>
      </div>

      <div className="px-6 py-6">
        {/* Score + summary */}
        <div className="flex items-start gap-8 mb-8">
          <div className="relative w-24 h-24 shrink-0">
            <svg className="w-24 h-24 -rotate-90" viewBox="0 0 100 100">
              <circle cx="50" cy="50" r="40" fill="none" stroke="currentColor" strokeWidth="6" className="text-bg-tertiary" />
              <circle
                cx="50" cy="50" r="40" fill="none"
                stroke={ring.color}
                strokeWidth="6"
                strokeDasharray={ring.circumference}
                strokeDashoffset={ring.offset}
                strokeLinecap="round"
              />
            </svg>
            <span className={clsx(
              "absolute inset-0 flex items-center justify-center text-2xl font-mono font-bold",
              data.score >= 80 ? "text-accent-green" : data.score >= 50 ? "text-amber-400" : "text-red-400"
            )}>
              {data.score}
            </span>
          </div>

          <div>
            <h2 className="text-lg font-semibold text-text-primary">{data.repo}</h2>
            <div className="flex items-center gap-3 mt-1">
              {data.language && <span className="text-xs font-mono text-text-tertiary">{data.language}</span>}
              {data.private && <span className="text-xs text-text-tertiary">Private</span>}
            </div>
            <div className="text-xs text-text-tertiary mt-2">
              {data.earned}/{data.possible} points earned
            </div>
          </div>
        </div>

        {/* Checklist */}
        <div className="text-[10px] font-mono text-text-tertiary uppercase tracking-wider mb-3">Configuration Checklist</div>
        <div className="space-y-2">
          {data.checks.map((check: any) => (
            <div
              key={check.id}
              className={clsx(
                "flex items-start gap-3 px-4 py-3 rounded-lg border",
                check.pass
                  ? "bg-accent-green/5 border-accent-green/20"
                  : "bg-red-400/5 border-red-400/20"
              )}
            >
              {/* Status icon */}
              <div className={clsx(
                "mt-0.5 w-5 h-5 rounded-full flex items-center justify-center text-xs shrink-0",
                check.pass
                  ? "bg-accent-green/20 text-accent-green"
                  : "bg-red-400/20 text-red-400"
              )}>
                {check.pass ? "✓" : "✗"}
              </div>

              {/* Content */}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-medium text-text-primary">{check.label}</span>
                  <span className="text-[9px] font-mono text-text-tertiary">({check.weight}pts)</span>
                </div>
                <div className="text-[10px] text-text-tertiary mt-0.5">{check.detail}</div>
              </div>

              {/* Score */}
              <div className={clsx(
                "text-xs font-mono font-bold shrink-0",
                check.pass ? "text-accent-green" : "text-red-400"
              )}>
                {check.pass ? `+${check.weight}` : "0"}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
