import type { InsightsOverview, Repo } from "@/lib/api";

function StatCard({ label, value, sub, color }: { label: string; value: string | number; sub?: string; color?: string }) {
  return (
    <div className="p-4 rounded-lg" style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
      <div className="text-xs uppercase tracking-wider mb-1" style={{ color: "var(--text-secondary)" }}>{label}</div>
      <div className="text-2xl font-bold" style={{ color: color || "var(--text)" }}>{value}</div>
      {sub && <div className="text-xs mt-1" style={{ color: "var(--text-secondary)" }}>{sub}</div>}
    </div>
  );
}

export default function InsightsPanel({ overview, repos }: { overview: InsightsOverview; repos: Repo[] }) {
  const passRate = overview.ci.pass_rate ? `${Math.round(overview.ci.pass_rate)}%` : "—";

  return (
    <div className="rounded-xl p-6" style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
      <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
        <span style={{ color: "var(--brand)" }}>📊</span> Multi-Repo Insights
      </h2>

      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-4 mb-6">
        <StatCard label="Repos" value={overview.repos.total} sub={`${overview.repos.synced} synced`} color="var(--brand)" />
        <StatCard label="Open Issues" value={overview.issues.open} sub={`${overview.issues.unassigned} unassigned`} />
        <StatCard label="Open PRs" value={overview.prs.open} sub={`${overview.prs.draft} drafts`} />
        <StatCard label="Merged" value={overview.prs.merged} color="var(--success)" />
        <StatCard label="CI Pass Rate" value={passRate} color={overview.ci.pass_rate && overview.ci.pass_rate > 80 ? "var(--success)" : "var(--warning)"} />
        <StatCard label="Auto-Healed" value={overview.ci.auto_healed} sub={`${overview.ci.total_failures} failures`} color="var(--brand)" />
      </div>

      {/* Repo cards */}
      {repos.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
          {repos.map((repo) => (
            <div key={repo.github_id} className="p-3 rounded-lg" style={{ background: "var(--bg)", border: "1px solid var(--border)" }}>
              <div className="flex items-center gap-2 mb-2">
                <span className="text-sm font-medium">{repo.full_name}</span>
                {repo.private && (
                  <span className="text-xs px-1.5 py-0.5 rounded" style={{ background: "var(--warning)", color: "#000" }}>Private</span>
                )}
              </div>
              <div className="flex gap-3 text-xs" style={{ color: "var(--text-secondary)" }}>
                {repo.language && <span>🔤 {repo.language}</span>}
                <span>⭐ {repo.stars}</span>
                <span>🐛 {repo.open_issues}</span>
                <span>🔀 {repo.open_prs}</span>
              </div>
            </div>
          ))}
        </div>
      )}

      {repos.length === 0 && (
        <div className="text-center py-8" style={{ color: "var(--text-secondary)" }}>
          No repositories synced yet. Install GitWire on a GitHub repo to get started.
        </div>
      )}
    </div>
  );
}
