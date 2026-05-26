"use client";
import { READINESS } from "@/lib/mock-data";
import { PageHeader } from "@/components/ui";

function scoreColor(s: number) { return s >= 80 ? "text-green-400" : s >= 60 ? "text-amber-400" : "text-red-400"; }
function scoreBg(s: number) { return s >= 80 ? "bg-green-500" : s >= 60 ? "bg-amber-500" : "bg-red-500"; }

export default function ReadinessPage() {
  return (
    <div className="animate-fade-in">
      <PageHeader title="Repo Readiness" subtitle="Aggregate scores across 5 trust pillars" />
      <div className="px-6 py-4 space-y-3">
        {READINESS.map((r) => (
          <div key={r.repo} className="card px-4 py-4">
            <div className="flex items-center justify-between mb-3">
              <span className="font-mono text-sm text-text-primary font-medium">{r.repo}</span>
              <span className={`text-2xl font-bold ${scoreColor(r.score)}`}>{r.score}</span>
            </div>
            <div className="w-full bg-surface-2 rounded-full h-2 mb-3">
              <div className={`h-2 rounded-full ${scoreBg(r.score)}`} style={{ width: `${r.score}%` }} />
            </div>
            <div className="grid grid-cols-5 gap-2">
              {Object.entries(r.pillars).map(([pillar, val]) => (
                <div key={pillar} className="text-center">
                  <div className={`text-sm font-mono font-bold ${scoreColor(val as number)}`}>{val as number}</div>
                  <div className="text-[10px] text-text-tertiary truncate">{pillar.replace(/_/g, " ")}</div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
