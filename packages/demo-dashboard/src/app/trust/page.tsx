"use client";
import { PageHeader } from "@/components/ui";
import { REPOS } from "@/lib/mock-data";

const PILLARS = [
  { name: "CI Healing", key: "ci_healing", avg: 74, description: "Auto-patch failed CI runs, heal broken builds" },
  { name: "Triage", key: "triage", avg: 82, description: "AI-powered issue classification and labeling" },
  { name: "Branch Enforcement", key: "enforcement", avg: 76, description: "Policy-as-code branch protection rules" },
  { name: "Quality Gates", key: "quality_gates", avg: 71, description: "Automated quality thresholds per repo" },
  { name: "Maintainer Tools", key: "maintainer", avg: 78, description: "Stale management, branch cleanup, settings" },
];

export default function TrustPage() {
  return (
    <div className="animate-fade-in">
      <PageHeader title="Trust & Policy" subtitle={`${REPOS.length} repos · 5 governance pillars`} />
      <div className="px-6 py-4 space-y-3">
        {PILLARS.map((p) => (
          <div key={p.key} className="card px-4 py-4">
            <div className="flex items-center justify-between mb-2">
              <div>
                <div className="text-sm font-bold text-text-primary">{p.name}</div>
                <div className="text-xs text-text-tertiary mt-0.5">{p.description}</div>
              </div>
              <div className="text-2xl font-bold text-accent-green">{p.avg}%</div>
            </div>
            <div className="w-full bg-surface-2 rounded-full h-1.5">
              <div className="bg-accent-green h-1.5 rounded-full" style={{ width: `${p.avg}%` }} />
            </div>
            <div className="text-[10px] text-text-tertiary mt-1 font-mono">Average compliance across {REPOS.length} repositories</div>
          </div>
        ))}
      </div>
    </div>
  );
}
