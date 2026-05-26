"use client";
import { REPOS } from "@/lib/mock-data";
import { PageHeader, MiniBar, HealthBadge } from "@/components/ui";
import { formatDistanceToNow } from "date-fns";

export default function ReposPage() {
  return (
    <div className="animate-fade-in">
      <PageHeader title="Repositories" subtitle={`${REPOS.length} repositories`} />
      <div className="px-6 py-4">
        <div className="card overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-[10px] font-mono text-text-tertiary uppercase tracking-wider">
                <th className="text-left px-4 py-2.5 font-medium">Repository</th>
                <th className="text-left px-4 py-2.5 font-medium">Lang</th>
                <th className="text-right px-4 py-2.5 font-medium">★</th>
                <th className="text-right px-4 py-2.5 font-medium">Issues</th>
                <th className="text-right px-4 py-2.5 font-medium">PRs</th>
                <th className="text-left px-4 py-2.5 font-medium w-40">CI pass rate</th>
                <th className="text-left px-4 py-2.5 font-medium">Health</th>
                <th className="text-left px-4 py-2.5 font-medium">Last synced</th>
              </tr>
            </thead>
            <tbody>
              {REPOS.map((repo) => (
                <tr key={repo.github_id} className="border-b border-border last:border-0 hover:bg-surface-2/40 transition-colors">
                  <td className="px-4 py-3">
                    <div className="font-mono text-sm text-text-primary font-medium">{repo.full_name}</div>
                    <div className="text-xs text-text-tertiary mt-0.5 font-mono">{repo.default_branch}</div>
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-text-tertiary">{repo.language}</td>
                  <td className="px-4 py-3 text-right font-mono text-xs text-text-secondary">{repo.stars}</td>
                  <td className="px-4 py-3 text-right font-mono text-xs text-text-secondary">{repo.open_issues}</td>
                  <td className="px-4 py-3 text-right font-mono text-xs text-text-secondary">{repo.open_prs}</td>
                  <td className="px-4 py-3 w-40"><MiniBar value={repo.ci_pass_rate} /></td>
                  <td className="px-4 py-3"><HealthBadge status={repo.health_status} /></td>
                  <td className="px-4 py-3 font-mono text-xs text-text-tertiary whitespace-nowrap">
                    {formatDistanceToNow(new Date(repo.last_synced_at), { addSuffix: true })}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
