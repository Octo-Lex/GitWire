"use client";
import { PageHeader, EmptyState } from "@/components/ui";

const RULES = [
  { name: "auto-approve-deps", trigger: "pull_request", condition: "author == 'dependabot' && files.allMatch('package.json', 'package-lock.json')", action: "approve", repos: 4, enabled: true },
  { name: "stale-after-30d", trigger: "schedule", condition: "age > 30d && comments == 0", action: "comment:stale", repos: 8, enabled: true },
  { name: "label-docs-prs", trigger: "pull_request", condition: "files.allMatch('docs/', '*.md')", action: "add-label:documentation", repos: 6, enabled: true },
  { name: "block-force-push", trigger: "push", condition: "forced == true && branch == 'main'", action: "notify:slack", repos: 3, enabled: false },
];

export default function CustomRulesPage() {
  return (
    <div className="animate-fade-in">
      <PageHeader title="Custom Rules" subtitle={`${RULES.length} rules configured`} />
      <div className="px-6 py-4">
        <div className="card overflow-hidden">
          <table className="w-full text-sm">
            <thead><tr className="border-b border-border text-[10px] font-mono text-text-tertiary uppercase tracking-wider">
              <th className="text-left px-4 py-2.5 font-medium">Rule</th>
              <th className="text-left px-4 py-2.5 font-medium">Trigger</th>
              <th className="text-left px-4 py-2.5 font-medium">Condition</th>
              <th className="text-left px-4 py-2.5 font-medium">Action</th>
              <th className="text-right px-4 py-2.5 font-medium">Repos</th>
              <th className="text-left px-4 py-2.5 font-medium">Enabled</th>
            </tr></thead>
            <tbody>
              {RULES.map((rule) => (
                <tr key={rule.name} className="border-b border-border last:border-0 hover:bg-surface-2/40 transition-colors">
                  <td className="px-4 py-3 font-mono text-sm text-text-primary">{rule.name}</td>
                  <td className="px-4 py-3 text-xs text-text-tertiary">{rule.trigger}</td>
                  <td className="px-4 py-3 font-mono text-xs text-text-secondary max-w-64 truncate">{rule.condition}</td>
                  <td className="px-4 py-3 font-mono text-xs text-accent-green">{rule.action}</td>
                  <td className="px-4 py-3 text-right font-mono text-xs text-text-secondary">{rule.repos}</td>
                  <td className="px-4 py-3"><span className={`text-[10px] px-2 py-0.5 rounded font-mono ${rule.enabled ? "bg-green-500/20 text-green-400" : "bg-surface-2 text-text-tertiary"}`}>{rule.enabled ? "on" : "off"}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
