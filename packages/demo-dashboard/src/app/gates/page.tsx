"use client";
import { GATES } from "@/lib/mock-data";
import { PageHeader } from "@/components/ui";
import { formatDistanceToNow } from "date-fns";

export default function GatesPage() {
  const passing = GATES.filter((g) => g.passing).length;
  const failing = GATES.filter((g) => !g.passing).length;

  return (
    <div className="animate-fade-in">
      <PageHeader title="Quality Gates" subtitle={`${GATES.length} checks · ${passing} passing · ${failing} failing`} />
      <div className="px-6 py-4 space-y-2">
        {GATES.map((g, i) => (
          <div key={i} className="card px-4 py-3 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <span className={`text-sm ${g.passing ? "text-green-400" : "text-red-400"}`}>{g.passing ? "✓" : "✕"}</span>
              <div>
                <div className="text-sm text-text-primary font-medium">{g.name}</div>
                <div className="text-xs text-text-tertiary font-mono">{g.repo}</div>
              </div>
            </div>
            <div className="flex items-center gap-4">
              <div className="text-right">
                <div className={`text-sm font-mono ${g.passing ? "text-green-400" : "text-red-400"}`}>{g.value}</div>
                <div className="text-[10px] text-text-tertiary font-mono">threshold: {g.threshold}</div>
              </div>
              <div className="text-xs text-text-tertiary">{formatDistanceToNow(new Date(g.last_eval), { addSuffix: true })}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
