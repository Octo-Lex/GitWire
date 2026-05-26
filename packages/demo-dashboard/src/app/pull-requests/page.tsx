"use client";
import { PULL_REQUESTS } from "@/lib/mock-data";
import { PageHeader } from "@/components/ui";
import { formatDistanceToNow } from "date-fns";

export default function PullRequestsPage() {
  return (
    <div className="animate-fade-in">
      <PageHeader title="Pull Requests" subtitle={`${PULL_REQUESTS.length} tracked PRs`} />
      <div className="px-6 py-4">
        <div className="card overflow-hidden">
          <table className="w-full text-sm">
            <thead><tr className="border-b border-border text-[10px] font-mono text-text-tertiary uppercase tracking-wider">
              <th className="text-left px-4 py-2.5 font-medium">Repo</th>
              <th className="text-left px-4 py-2.5 font-medium">PR</th>
              <th className="text-left px-4 py-2.5 font-medium">State</th>
              <th className="text-left px-4 py-2.5 font-medium">Author</th>
              <th className="text-right px-4 py-2.5 font-medium">+/−</th>
              <th className="text-left px-4 py-2.5 font-medium">Branch</th>
              <th className="text-left px-4 py-2.5 font-medium">Created</th>
            </tr></thead>
            <tbody>
              {PULL_REQUESTS.map((pr) => (
                <tr key={pr.id} className="border-b border-border last:border-0 hover:bg-surface-2/40 transition-colors">
                  <td className="px-4 py-3 font-mono text-xs text-text-tertiary">{pr.repo}</td>
                  <td className="px-4 py-3"><div className="text-sm text-text-primary">#{pr.number} {pr.title}</div></td>
                  <td className="px-4 py-3"><span className={`text-[10px] px-2 py-0.5 rounded font-mono ${pr.state === "merged" ? "bg-purple-500/20 text-purple-400" : pr.state === "open" ? "bg-green-500/20 text-green-400" : "bg-red-500/20 text-red-400"}`}>{pr.state}</span></td>
                  <td className="px-4 py-3 font-mono text-xs text-text-secondary">{pr.author}</td>
                  <td className="px-4 py-3 text-right"><span className="text-xs text-green-400">+{pr.additions}</span> <span className="text-xs text-red-400">−{pr.deletions}</span></td>
                  <td className="px-4 py-3 font-mono text-xs text-text-tertiary max-w-32 truncate">{pr.branch}</td>
                  <td className="px-4 py-3 font-mono text-xs text-text-tertiary whitespace-nowrap">{formatDistanceToNow(new Date(pr.created_at), { addSuffix: true })}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
