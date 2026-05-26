"use client";
import { ACTIONS } from "@/lib/mock-data";
import { PageHeader } from "@/components/ui";
import { formatDistanceToNow } from "date-fns";

const STATUS_COLORS: Record<string, string> = { succeeded: "bg-green-500/20 text-green-400", failed: "bg-red-500/20 text-red-400", executing: "bg-blue-500/20 text-blue-400", retrying: "bg-amber-500/20 text-amber-400", proposed: "bg-slate-500/20 text-slate-400", reconciled: "bg-cyan-500/20 text-cyan-400", cancelled: "bg-gray-500/20 text-gray-400" };

export default function ActionsPage() {
  const byStatus = ACTIONS.reduce((acc, a) => { acc[a.status] = (acc[a.status] || 0) + 1; return acc; }, {} as Record<string, number>);

  return (
    <div className="animate-fade-in">
      <PageHeader title="Actions" subtitle={`${ACTIONS.length} lifecycle actions`} />
      <div className="flex gap-3 px-6 py-3">
        {Object.entries(byStatus).map(([status, count]) => (
          <div key={status} className={`px-3 py-1.5 rounded text-xs font-mono ${STATUS_COLORS[status] || "bg-surface-2 text-text-tertiary"}`}>
            {status}: {count}
          </div>
        ))}
      </div>
      <div className="px-6 py-4">
        <div className="card overflow-hidden">
          <table className="w-full text-sm">
            <thead><tr className="border-b border-border text-[10px] font-mono text-text-tertiary uppercase tracking-wider">
              <th className="text-left px-4 py-2.5 font-medium">Repo</th>
              <th className="text-left px-4 py-2.5 font-medium">Pillar</th>
              <th className="text-left px-4 py-2.5 font-medium">Type</th>
              <th className="text-left px-4 py-2.5 font-medium">Status</th>
              <th className="text-left px-4 py-2.5 font-medium">Source</th>
              <th className="text-right px-4 py-2.5 font-medium">Retries</th>
              <th className="text-left px-4 py-2.5 font-medium">When</th>
            </tr></thead>
            <tbody>
              {ACTIONS.map((action) => (
                <tr key={action.id} className="border-b border-border last:border-0 hover:bg-surface-2/40 transition-colors">
                  <td className="px-4 py-3 font-mono text-xs text-text-secondary">{action.repo_full_name}</td>
                  <td className="px-4 py-3 text-xs text-text-tertiary">{action.pillar}</td>
                  <td className="px-4 py-3 font-mono text-xs text-text-primary">{action.action_type}</td>
                  <td className="px-4 py-3"><span className={`text-[10px] px-2 py-0.5 rounded font-mono ${STATUS_COLORS[action.status]}`}>{action.status}</span></td>
                  <td className="px-4 py-3 text-xs text-text-tertiary">{action.source}</td>
                  <td className="px-4 py-3 text-right font-mono text-xs text-text-secondary">{action.retries || 0}/{3}</td>
                  <td className="px-4 py-3 font-mono text-xs text-text-tertiary whitespace-nowrap">{formatDistanceToNow(new Date(action.proposed_at), { addSuffix: true })}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
