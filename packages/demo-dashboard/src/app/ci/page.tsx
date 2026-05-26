"use client";
import { CI_RUNS } from "@/lib/mock-data";
import { PageHeader, CIBadge, MiniBar } from "@/components/ui";
import { formatDistanceToNow } from "date-fns";

const HEAL_COLORS: Record<string, string> = { healed: "text-green-400", failed: "text-red-400", pending: "text-amber-400" };

export default function CIPage() {
  const passCount = CI_RUNS.filter((r) => r.conclusion === "success").length;
  const failCount = CI_RUNS.filter((r) => r.conclusion === "failure").length;
  const healedCount = CI_RUNS.filter((r) => r.heal_status === "healed").length;

  return (
    <div className="animate-fade-in">
      <PageHeader title="CI Healing" subtitle={`${CI_RUNS.length} runs · ${passCount} passed · ${failCount} failed · ${healedCount} healed`} />
      <div className="px-6 py-4">
        <div className="card overflow-hidden">
          <table className="w-full text-sm">
            <thead><tr className="border-b border-border text-[10px] font-mono text-text-tertiary uppercase tracking-wider">
              <th className="text-left px-4 py-2.5 font-medium">Repo</th>
              <th className="text-left px-4 py-2.5 font-medium">Branch</th>
              <th className="text-left px-4 py-2.5 font-medium">Result</th>
              <th className="text-right px-4 py-2.5 font-medium">Duration</th>
              <th className="text-left px-4 py-2.5 font-medium">Heal</th>
              <th className="text-left px-4 py-2.5 font-medium">Commit</th>
              <th className="text-left px-4 py-2.5 font-medium">When</th>
            </tr></thead>
            <tbody>
              {CI_RUNS.map((run) => (
                <tr key={run.id} className="border-b border-border last:border-0 hover:bg-surface-2/40 transition-colors">
                  <td className="px-4 py-3 font-mono text-xs text-text-secondary">{run.repo}</td>
                  <td className="px-4 py-3 font-mono text-xs text-text-tertiary">{run.branch}</td>
                  <td className="px-4 py-3"><CIBadge conclusion={run.conclusion} healStatus={run.heal_status || undefined} /></td>
                  <td className="px-4 py-3 text-right font-mono text-xs text-text-secondary">{run.duration}s</td>
                  <td className="px-4 py-3 font-mono text-xs">{run.heal_status ? <span className={HEAL_COLORS[run.heal_status] || "text-text-tertiary"}>{run.heal_status}</span> : <span className="text-text-tertiary">—</span>}</td>
                  <td className="px-4 py-3 text-xs text-text-tertiary max-w-48 truncate">{run.commit_message}</td>
                  <td className="px-4 py-3 font-mono text-xs text-text-tertiary whitespace-nowrap">{formatDistanceToNow(new Date(run.created_at), { addSuffix: true })}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
