"use client";
import { DECISIONS } from "@/lib/mock-data";
import { PageHeader } from "@/components/ui";
import { formatDistanceToNow } from "date-fns";

const TYPE_COLORS: Record<string, string> = { approved: "bg-green-500/20 text-green-400", rejected: "bg-red-500/20 text-red-400", auto_labeled: "bg-blue-500/20 text-blue-400", auto_approved: "bg-green-500/20 text-green-400", auto_comment: "bg-cyan-500/20 text-cyan-400", gate_passed: "bg-green-500/20 text-green-400", retrying: "bg-amber-500/20 text-amber-400" };

export default function DecisionsPage() {
  return (
    <div className="animate-fade-in">
      <PageHeader title="Decisions" subtitle={`${DECISIONS.length} governance decisions`} />
      <div className="px-6 py-4 space-y-3">
        {DECISIONS.map((d) => (
          <div key={d.id} className="card px-4 py-3">
            <div className="flex items-center justify-between mb-1">
              <div className="flex items-center gap-2">
                <span className="font-mono text-xs text-text-tertiary">{d.repo}</span>
                <span className="text-text-tertiary">·</span>
                <span className={`text-[10px] px-2 py-0.5 rounded font-mono ${TYPE_COLORS[d.decision] || "bg-surface-2 text-text-tertiary"}`}>{d.decision}</span>
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-surface-2 text-text-tertiary font-mono">{d.pillar}</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="font-mono text-xs text-accent-green">{(d.confidence * 100).toFixed(0)}%</span>
                <span className="text-xs text-text-tertiary">{formatDistanceToNow(new Date(d.created_at), { addSuffix: true })}</span>
              </div>
            </div>
            <p className="text-sm text-text-secondary">{d.reason}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
