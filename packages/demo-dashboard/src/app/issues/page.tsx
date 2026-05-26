"use client";
import { ISSUES } from "@/lib/mock-data";
import { PageHeader } from "@/components/ui";
import { formatDistanceToNow } from "date-fns";

const STATUS_COLORS: Record<string, string> = { bug: "bg-red-500/20 text-red-400", enhancement: "bg-blue-500/20 text-blue-400", dependencies: "bg-purple-500/20 text-purple-400", documentation: "bg-cyan-500/20 text-cyan-400", performance: "bg-amber-500/20 text-amber-400", "priority:high": "bg-red-500/20 text-red-400", "priority:critical": "bg-red-600/30 text-red-300", "priority:medium": "bg-amber-500/20 text-amber-400", "good first issue": "bg-green-500/20 text-green-400", infrastructure: "bg-slate-500/20 text-slate-400" };

export default function IssuesPage() {
  return (
    <div className="animate-fade-in">
      <PageHeader title="Issues" subtitle={`${ISSUES.length} tracked issues`} />
      <div className="px-6 py-4">
        <div className="card overflow-hidden">
          <table className="w-full text-sm">
            <thead><tr className="border-b border-border text-[10px] font-mono text-text-tertiary uppercase tracking-wider">
              <th className="text-left px-4 py-2.5 font-medium">Repo</th>
              <th className="text-left px-4 py-2.5 font-medium">Issue</th>
              <th className="text-left px-4 py-2.5 font-medium">Labels</th>
              <th className="text-left px-4 py-2.5 font-medium">Triage</th>
              <th className="text-right px-4 py-2.5 font-medium">Confidence</th>
              <th className="text-left px-4 py-2.5 font-medium">Author</th>
              <th className="text-left px-4 py-2.5 font-medium">Created</th>
            </tr></thead>
            <tbody>
              {ISSUES.filter((i) => i.state === "open").map((issue) => (
                <tr key={issue.id} className="border-b border-border last:border-0 hover:bg-surface-2/40 transition-colors">
                  <td className="px-4 py-3 font-mono text-xs text-text-tertiary">{issue.repo}</td>
                  <td className="px-4 py-3">
                    <div className="text-sm text-text-primary">#{issue.number} {issue.title}</div>
                  </td>
                  <td className="px-4 py-3"><div className="flex flex-wrap gap-1">{issue.labels.map((l) => <span key={l} className={`text-[10px] px-1.5 py-0.5 rounded font-mono ${STATUS_COLORS[l] || "bg-surface-2 text-text-tertiary"}`}>{l}</span>)}</div></td>
                  <td className="px-4 py-3"><span className="text-[10px] px-2 py-0.5 rounded bg-blue-500/20 text-blue-400 font-mono">{issue.triage_label}</span></td>
                  <td className="px-4 py-3 text-right font-mono text-xs text-accent-green">{(issue.confidence * 100).toFixed(0)}%</td>
                  <td className="px-4 py-3 font-mono text-xs text-text-secondary">{issue.author}</td>
                  <td className="px-4 py-3 font-mono text-xs text-text-tertiary whitespace-nowrap">{formatDistanceToNow(new Date(issue.created_at), { addSuffix: true })}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
