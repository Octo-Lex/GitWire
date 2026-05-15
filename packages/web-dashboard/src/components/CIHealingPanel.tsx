import type { CIStats } from "@/lib/api";

export default function CIHealingPanel({ ciStats }: { ciStats: CIStats | null }) {
  const summary = ciStats?.summary;

  return (
    <div className="rounded-xl p-6" style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
      <h2 className="text-lg font-semibold mb-1 flex items-center gap-2">
        <span style={{ color: "var(--brand)" }}>🔧</span> Self-Healing CI
      </h2>
      <p className="text-xs mb-4" style={{ color: "var(--text-secondary)" }}>
        Automated diagnosis and recovery
      </p>

      {/* Stats grid */}
      <div className="grid grid-cols-2 gap-3 mb-4">
        <div className="p-3 rounded-lg text-center" style={{ background: "var(--bg)", border: "1px solid var(--border)" }}>
          <div className="text-xl font-bold" style={{ color: "var(--text)" }}>{summary?.total_runs || 0}</div>
          <div className="text-xs" style={{ color: "var(--text-secondary)" }}>Total Runs</div>
        </div>
        <div className="p-3 rounded-lg text-center" style={{ background: "var(--bg)", border: "1px solid var(--border)" }}>
          <div className="text-xl font-bold" style={{ color: "var(--success)" }}>{summary?.passed || 0}</div>
          <div className="text-xs" style={{ color: "var(--text-secondary)" }}>Passed</div>
        </div>
        <div className="p-3 rounded-lg text-center" style={{ background: "var(--bg)", border: "1px solid var(--border)" }}>
          <div className="text-xl font-bold" style={{ color: "var(--danger)" }}>{summary?.failed || 0}</div>
          <div className="text-xs" style={{ color: "var(--text-secondary)" }}>Failed</div>
        </div>
        <div className="p-3 rounded-lg text-center" style={{ background: "var(--bg)", border: "1px solid var(--border)" }}>
          <div className="text-xl font-bold" style={{ color: "var(--brand)" }}>{summary?.auto_healed || 0}</div>
          <div className="text-xs" style={{ color: "var(--text-secondary)" }}>Auto-Healed</div>
        </div>
      </div>

      {/* Failure breakdown */}
      {ciStats?.by_failure_type && ciStats.by_failure_type.length > 0 && (
        <div className="space-y-2">
          <div className="text-xs font-medium uppercase tracking-wider" style={{ color: "var(--text-secondary)" }}>
            Failure Breakdown
          </div>
          {ciStats.by_failure_type.map((ft) => (
            <div key={ft.failure_type} className="flex items-center gap-2">
              <div className="flex-1 text-xs">{ft.failure_type.replace(/_/g, " ")}</div>
              <div className="text-xs font-medium" style={{ color: "var(--danger)" }}>{ft.count}</div>
            </div>
          ))}
        </div>
      )}

      {!ciStats && (
        <div className="text-center py-8 text-sm" style={{ color: "var(--text-secondary)" }}>
          No CI data yet. Connect a repo with GitHub Actions workflows to see healing in action.
        </div>
      )}
    </div>
  );
}
