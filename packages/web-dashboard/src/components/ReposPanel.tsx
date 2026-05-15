import type { Repo } from "@/lib/api";

export default function ReposPanel({ repos }: { repos: Repo[] }) {
  return (
    <div className="rounded-xl p-6" style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
      <h2 className="text-lg font-semibold mb-1 flex items-center gap-2">
        <span style={{ color: "var(--brand)" }}>🛡️</span> Maintainer
      </h2>
      <p className="text-xs mb-4" style={{ color: "var(--text-secondary)" }}>
        Team access, permissions & branch rules
      </p>

      <div className="space-y-3">
        {repos.map((repo) => (
          <div key={repo.github_id} className="p-4 rounded-lg" style={{ background: "var(--bg)", border: "1px solid var(--border)" }}>
            <div className="flex items-center justify-between mb-2">
              <div className="font-medium text-sm">{repo.full_name}</div>
              {repo.private && (
                <span className="text-xs px-1.5 py-0.5 rounded" style={{ background: "var(--warning)", color: "#000" }}>Private</span>
              )}
            </div>

            <div className="grid grid-cols-2 gap-2 text-xs" style={{ color: "var(--text-secondary)" }}>
              <div>🌿 Branch: <span style={{ color: "var(--text)" }}>{repo.default_branch}</span></div>
              <div>🔤 Language: <span style={{ color: "var(--text)" }}>{repo.language || "—"}</span></div>
              <div>🐛 Issues: <span style={{ color: "var(--text)" }}>{repo.open_issues}</span></div>
              <div>🔀 PRs: <span style={{ color: "var(--text)" }}>{repo.open_prs}</span></div>
            </div>

            {repo.last_synced_at && (
              <div className="text-xs mt-2" style={{ color: "var(--text-secondary)" }}>
                Last synced: {new Date(repo.last_synced_at).toLocaleString()}
              </div>
            )}
          </div>
        ))}

        {repos.length === 0 && (
          <div className="text-center py-8 text-sm" style={{ color: "var(--text-secondary)" }}>
            No repos connected. Install GitWire on a GitHub repository to begin.
          </div>
        )}
      </div>
    </div>
  );
}
