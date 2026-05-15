import type { Issue } from "@/lib/api";

function PriorityBadge({ priority }: { priority: string | null }) {
  const colors: Record<string, string> = {
    critical: "var(--danger)",
    high: "var(--warning)",
    medium: "var(--info)",
    low: "var(--text-secondary)",
  };
  if (!priority) return null;
  return (
    <span className="text-xs px-1.5 py-0.5 rounded font-medium" style={{ background: colors[priority] || "var(--border)", color: priority === "low" ? "#000" : "#fff" }}>
      {priority}
    </span>
  );
}

function TypeBadge({ type }: { type: string | null }) {
  const colors: Record<string, string> = {
    bug: "var(--danger)",
    feature: "var(--success)",
    question: "var(--info)",
    other: "var(--text-secondary)",
  };
  if (!type) return <span className="text-xs" style={{ color: "var(--text-secondary)" }}>untriaged</span>;
  return (
    <span className="text-xs px-1.5 py-0.5 rounded" style={{ background: colors[type] || "var(--border)", color: "#fff" }}>
      {type}
    </span>
  );
}

export default function TriagePanel({ issues }: { issues: Issue[] }) {
  const triaged = issues.filter((i) => i.triage_type);
  const untriaged = issues.filter((i) => !i.triage_type);

  return (
    <div className="rounded-xl p-6" style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
      <h2 className="text-lg font-semibold mb-1 flex items-center gap-2">
        <span style={{ color: "var(--brand)" }}>🏷️</span> Issue & PR Triage
      </h2>
      <p className="text-xs mb-4" style={{ color: "var(--text-secondary)" }}>
        {triaged.length} triaged · {untriaged.length} pending
      </p>

      <div className="space-y-2 max-h-96 overflow-y-auto">
        {issues.map((issue) => (
          <div key={issue.github_id} className="p-3 rounded-lg flex items-start gap-3" style={{ background: "var(--bg)", border: "1px solid var(--border)" }}>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-1">
                <TypeBadge type={issue.triage_type} />
                <PriorityBadge priority={issue.triage_priority} />
                <span className="text-xs" style={{ color: "var(--text-secondary)" }}>
                  {issue.repo_full_name}#{issue.number}
                </span>
              </div>
              <div className="text-sm font-medium truncate">{issue.title}</div>
              {issue.triage_summary && (
                <div className="text-xs mt-1 line-clamp-2" style={{ color: "var(--text-secondary)" }}>
                  {issue.triage_summary}
                </div>
              )}
              {issue.labels.length > 0 && (
                <div className="flex gap-1 mt-1.5 flex-wrap">
                  {issue.labels.map((label) => (
                    <span key={label} className="text-xs px-1.5 py-0.5 rounded" style={{ background: "var(--border)", color: "var(--text-secondary)" }}>
                      {label}
                    </span>
                  ))}
                </div>
              )}
            </div>
            <span className="text-xs whitespace-nowrap" style={{ color: "var(--text-secondary)" }}>
              {new Date(issue.created_at).toLocaleDateString()}
            </span>
          </div>
        ))}

        {issues.length === 0 && (
          <div className="text-center py-8 text-sm" style={{ color: "var(--text-secondary)" }}>
            No issues yet. Issues will appear here when created on connected repos.
          </div>
        )}
      </div>
    </div>
  );
}
