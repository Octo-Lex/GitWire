"use client";

import { ApiItem } from "@/lib/types";

import useSWR from "swr";

import {
  AreaChart, Area, BarChart, Bar,
  XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, LineChart, Line, Legend,
} from "recharts";
import { fetcher, API } from "@/lib/api";
import {
  PageHeader, StatCard, HealthBadge, MiniBar,
  Skeleton, EmptyState,
} from "@/components/ui";
import { format, parseISO } from "date-fns";
import { ErrorBoundary } from '@/components/ErrorBoundary';

function ChartTooltip({ active, payload, label, unit = "" }: { active?: boolean; payload?: Array<{ name: string; value: number; color: string }>; label?: string; unit?: string }) {
  if (!active || !payload?.length) return null;
  return (
    <ErrorBoundary>
    <div className="bg-surface-2 border border-border rounded px-3 py-2 text-xs font-mono shadow-xl">
      <div className="text-text-tertiary mb-1">{label}</div>
      {payload.map((p) => (
        <div key={p.name} style={{ color: p.color }}>
          {p.name}: {p.value}{unit}
        </div>
      ))}
    </div>
  );
}

export default function InsightsPage() {
  const { data: repos, isLoading: rl } = useSWR(API.insightRepos(), fetcher, { refreshInterval: 60000 });
  const { data: velocity, isLoading: vl } = useSWR(API.insightVelocity(), fetcher, { refreshInterval: 60000 });
  const { data: ciTrend, isLoading: cl } = useSWR(API.insightCITrend(), fetcher, { refreshInterval: 60000 });

  const velocityData = velocity?.issue_velocity?.map((d: { day: string; opened: string | number }) => ({
    day: format(parseISO(d.day), "MMM d"),
    issues: Number(d.opened),
  })) ?? [];

  const ciRepos = Object.keys(ciTrend ?? {}).slice(0, 3);
  const ciChartData = (() => {
    if (!ciTrend || !ciRepos.length) return [];
    const days = ciTrend[ciRepos[0]].map((d: { day: string }) => format(parseISO(d.day), "MMM d"));
    return days.map((day: string, i: number) => ({
      day,
      ...Object.fromEntries(
        ciRepos.map((repo) => [repo.split("/")[1], Number(ciTrend[repo]?.[i]?.pass_rate ?? 0)])
      ),
    }));
  })();

  const REPO_COLORS = ["#00d97e", "#4d9fff", "#a78bfa"];

  return (
    <ErrorBoundary>
    <div className="animate-fade-in">
      <PageHeader
        title="Multi-repo insights"
        subtitle="Cross-repository health, velocity and CI analytics"
      />

      {/* Health table */}
      <div className="px-6 py-5">
        <div className="text-[10px] font-mono text-text-tertiary uppercase tracking-wider mb-3">Repository health</div>
        <div className="card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-[10px] font-mono text-text-tertiary uppercase tracking-wider">
                  <th className="text-left px-4 py-2.5 font-medium">Repository</th>
                  <th className="text-left px-4 py-2.5 font-medium">Lang</th>
                  <th className="text-right px-4 py-2.5 font-medium">★</th>
                  <th className="text-right px-4 py-2.5 font-medium">Open issues</th>
                  <th className="text-right px-4 py-2.5 font-medium">Stale</th>
                  <th className="text-right px-4 py-2.5 font-medium">Open PRs</th>
                  <th className="text-right px-4 py-2.5 font-medium">Healed</th>
                  <th className="text-left px-4 py-2.5 font-medium w-40">CI (30d)</th>
                  <th className="text-left px-4 py-2.5 font-medium">Health</th>
                </tr>
              </thead>
              <tbody>
                {rl && [...Array(5)].map((_, i) => (
                  <tr key={i} className="border-b border-border">
                    {[...Array(9)].map((_, j) => (
                      <td key={j} className="px-4 py-3"><Skeleton className="h-4" /></td>
                    ))}
                  </tr>
                ))}
                {!rl && !repos?.length && (
                  <tr><td colSpan={9}><EmptyState icon="◈" title="No repositories yet" /></td></tr>
                )}
                {repos?.map((repo: ApiItem) => (
                  <tr key={String(repo.full_name)} className="border-b border-border last:border-0 hover:bg-surface-2/40 transition-colors">
                    <td className="px-4 py-2.5 font-mono text-xs text-text-primary font-medium">{String(repo.full_name)}</td>
                    <td className="px-4 py-2.5 font-mono text-xs text-text-tertiary">{String(repo.language ?? "—")}</td>
                    <td className="px-4 py-2.5 text-right font-mono text-xs text-text-secondary">{String(repo.stars ?? 0)}</td>
                    <td className="px-4 py-2.5 text-right font-mono text-xs text-text-secondary">{String(repo.open_issues ?? 0)}</td>
                    <td className="px-4 py-2.5 text-right font-mono text-xs text-accent-amber">{String(repo.stale_issues ?? 0)}</td>
                    <td className="px-4 py-2.5 text-right font-mono text-xs text-text-secondary">{String(repo.open_prs ?? 0)}</td>
                    <td className="px-4 py-2.5 text-right font-mono text-xs text-accent-purple">{String(repo.healed_runs ?? 0)}</td>
                    <td className="px-4 py-2.5 w-40"><MiniBar value={Number(repo.ci_pass_rate)} /></td>
                    <td className="px-4 py-2.5"><HealthBadge status={String(repo.health_status ?? "active")} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* Charts */}
      <div className="grid grid-cols-2 gap-4 px-6 pb-6">

        {/* Issue velocity */}
        <div className="card p-4">
          <div className="text-[10px] font-mono text-text-tertiary uppercase tracking-wider mb-4">
            Issues opened — last 30 days
          </div>
          {vl ? (
            <Skeleton className="h-48" />
          ) : velocityData.length === 0 ? (
            <EmptyState icon="◈" title="No data yet" />
          ) : (
            <ResponsiveContainer width="100%" height={180}>
              <AreaChart data={velocityData} margin={{ top: 4, right: 4, left: -24, bottom: 0 }}>
                <defs>
                  <linearGradient id="issueGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#00d97e" stopOpacity={0.3} />
                    <stop offset="95%" stopColor="#00d97e" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#2e2e36" vertical={false} />
                <XAxis dataKey="day" tick={{ fontSize: 9, fontFamily: "JetBrains Mono", fill: "#5a5a6e" }} axisLine={false} tickLine={false} interval="preserveStartEnd" />
                <YAxis tick={{ fontSize: 9, fontFamily: "JetBrains Mono", fill: "#5a5a6e" }} axisLine={false} tickLine={false} />
                <Tooltip content={<ChartTooltip />} />
                <Area type="monotone" dataKey="issues" stroke="#00d97e" strokeWidth={1.5} fill="url(#issueGrad)" dot={false} />
              </AreaChart>
            </ResponsiveContainer>
          )}
          {velocity?.avg_hours_to_close_issue && (
            <div className="mt-2 text-xs font-mono text-text-tertiary">
              avg. close time: <span className="text-accent-green">{velocity.avg_hours_to_close_issue}h</span>
            </div>
          )}
        </div>

        {/* CI pass rate trend */}
        <div className="card p-4">
          <div className="text-[10px] font-mono text-text-tertiary uppercase tracking-wider mb-4">
            CI pass rate by repo — last 14 days
          </div>
          {cl ? (
            <Skeleton className="h-48" />
          ) : ciChartData.length === 0 ? (
            <EmptyState icon="⚙" title="No CI data yet" />
          ) : (
            <ResponsiveContainer width="100%" height={180}>
              <LineChart data={ciChartData} margin={{ top: 4, right: 4, left: -24, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#2e2e36" vertical={false} />
                <XAxis dataKey="day" tick={{ fontSize: 9, fontFamily: "JetBrains Mono", fill: "#5a5a6e" }} axisLine={false} tickLine={false} interval="preserveStartEnd" />
                <YAxis domain={[0, 100]} tick={{ fontSize: 9, fontFamily: "JetBrains Mono", fill: "#5a5a6e" }} axisLine={false} tickLine={false} unit="%" />
                <Tooltip content={<ChartTooltip unit="%" />} />
                <Legend wrapperStyle={{ fontSize: "10px", fontFamily: "JetBrains Mono", color: "#8e8ea0" }} />
                {ciRepos.map((repo, i) => (
                  <Line
                    key={repo}
                    type="monotone"
                    dataKey={repo.split("/")[1]}
                    stroke={REPO_COLORS[i]}
                    strokeWidth={1.5}
                    dot={false}
                    activeDot={{ r: 3 }}
                  />
                ))}
              </LineChart>
            </ResponsiveContainer>
          )}
        </div>

        {/* PR velocity */}
        <div className="card p-4 col-span-2">
          <div className="text-[10px] font-mono text-text-tertiary uppercase tracking-wider mb-4">
            Pull requests opened vs merged — last 30 days
          </div>
          {vl ? (
            <Skeleton className="h-48" />
          ) : !velocity?.pr_velocity?.length ? (
            <EmptyState icon="⌥" title="No PR data yet" />
          ) : (
            <ResponsiveContainer width="100%" height={160}>
              <BarChart
                data={velocity.pr_velocity.map((d: { day: string; opened: string | number; merged: string | number }) => ({
                  day: format(parseISO(d.day), "MMM d"),
                  opened: Number(d.opened),
                  merged: Number(d.merged),
                }))}
                margin={{ top: 4, right: 4, left: -24, bottom: 0 }}
                barSize={6}
                barGap={2}
              >
                <CartesianGrid strokeDasharray="3 3" stroke="#2e2e36" vertical={false} />
                <XAxis dataKey="day" tick={{ fontSize: 9, fontFamily: "JetBrains Mono", fill: "#5a5a6e" }} axisLine={false} tickLine={false} interval="preserveStartEnd" />
                <YAxis tick={{ fontSize: 9, fontFamily: "JetBrains Mono", fill: "#5a5a6e" }} axisLine={false} tickLine={false} />
                <Tooltip content={<ChartTooltip />} />
                <Legend wrapperStyle={{ fontSize: "10px", fontFamily: "JetBrains Mono", color: "#8e8ea0" }} />
                <Bar dataKey="opened" fill="#4d9fff" fillOpacity={0.8} radius={[2, 2, 0, 0]} />
                <Bar dataKey="merged" fill="#00d97e" fillOpacity={0.8} radius={[2, 2, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>
    </div>
    </ErrorBoundary>
  );
}
