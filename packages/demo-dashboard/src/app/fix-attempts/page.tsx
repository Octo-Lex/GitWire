"use client";
import { PageHeader, EmptyState } from "@/components/ui";
import { CI_RUNS, ACTIONS } from "@/lib/mock-data";

export default function FixAttemptsPage() {
  const fixes = ACTIONS.filter((a) => a.pillar === "issue_fix" || a.action_type === "create-patch-pr");

  return (
    <div className="animate-fade-in">
      <PageHeader title="Fix Attempts" subtitle={`${fixes.length} automated fixes`} />
      <div className="px-6 py-4">
        <div className="card overflow-hidden">
          <table className="w-full text-sm">
            <thead><tr className="border-b border-border text-[10px] font-mono text-text-tertiary uppercase tracking-wider">
              <th className="text-left px-4 py-2.5 font-medium">Repo</th>
              <th className="text-left px-4 py-2.5 font-medium">Type</th>
              <th className="text-left px-4 py-2.5 font-medium">Status</th>
              <th className="text-left px-4 py-2.5 font-medium">Source</th>
              <th className="text-right px-4 py-2.5 font-medium">Retries</th>
            </tr></thead>
            <tbody>
              {fixes.map((fix) => (
                <tr key={fix.id} className="border-b border-border last:border-0 hover:bg-surface-2/40 transition-colors">
                  <td className="px-4 py-3 font-mono text-xs text-text-secondary">{fix.repo_full_name}</td>
                  <td className="px-4 py-3 font-mono text-xs text-text-primary">{fix.action_type}</td>
                  <td className="px-4 py-3 font-mono text-xs text-text-secondary">{fix.status}</td>
                  <td className="px-4 py-3 text-xs text-text-tertiary">{fix.source}</td>
                  <td className="px-4 py-3 text-right font-mono text-xs text-text-secondary">{fix.retries || 0}</td>
                </tr>
              ))}
              {fixes.length === 0 && <tr><td colSpan={5} className="px-4 py-8"><EmptyState icon="🔧" title="No fix attempts yet" body="Fix attempts appear when GitWire generates patches for issues or CI failures." /></td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
