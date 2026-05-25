"use client";

import { useState } from "react";

interface Orphan {
  orphan: { github_id: string; full_name: string; delivery_count: number };
  live: { github_id: string; full_name: string; delivery_count: number };
  data: {
    fk_tables: Record<string, number>;
    fk_total: number;
    denorm_tables: Record<string, number>;
    denorm_total: number;
    grand_total: number;
  };
}

export default function ReconcilePanel({ orphans, onDone }: { orphans: Orphan[]; onDone: () => void }) {
  const [loading, setLoading] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [results, setResults] = useState<Record<string, any>>({});

  async function handleMerge(orphan: string, live: string) {
    setLoading(orphan);
    setError("");
    try {
      const res = await fetch("/api/repos/reconcile/merge", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orphan, live }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Merge failed");
      setResults((r) => ({ ...r, [orphan]: data }));
    } catch (err: any) {
      setError(err.message);
      setLoading(null);
    }
  }

  async function handleDiscard(orphan: string) {
    setLoading(orphan);
    setError("");
    try {
      const res = await fetch("/api/repos/reconcile/discard", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orphan }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Discard failed");
      setResults((r) => ({ ...r, [orphan]: data }));
    } catch (err: any) {
      setError(err.message);
      setLoading(null);
    }
  }

  if (!orphans.length) return null;

  return (
    <div className="px-6 py-4">
      <div className="card border-amber-700/40 bg-amber-900/10">
        {/* Header */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-amber-700/30">
          <span className="text-lg">⚠️</span>
          <div>
            <h3 className="text-sm font-bold text-amber-200">
              {orphans.length} Orphaned Repo{orphans.length > 1 ? "s" : ""} Detected
            </h3>
            <p className="text-xs text-amber-300/70">
              These repos share a name with an active repo but have different GitHub IDs.
              Data from the old repo can be merged or discarded.
            </p>
          </div>
        </div>

        {/* Orphan entries */}
        {orphans.map((o) => {
          const done = results[o.orphan.full_name];
          return (
            <div
              key={o.orphan.github_id}
              className="px-4 py-3 border-b border-border last:border-0"
            >
              {done ? (
                /* ── Resolved state ── */
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="text-accent-green">✓</span>
                    <span className="font-mono text-sm text-text-secondary line-through">
                      {o.orphan.full_name}
                    </span>
                    <span className="text-xs text-text-tertiary">
                      {done.status === "merged"
                        ? `merged ${done.total_affected} rows into ${o.live.full_name}`
                        : "discarded"}
                    </span>
                  </div>
                </div>
              ) : (
                /* ── Actionable state ── */
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="font-mono text-sm text-text-secondary">
                        {o.orphan.full_name}
                      </span>
                      <span className="text-xs text-text-tertiary">→</span>
                      <span className="font-mono text-sm text-accent-green">
                        {o.live.full_name}
                      </span>
                    </div>
                    <div className="text-xs text-text-tertiary">
                      {o.orphan.delivery_count} deliveries · {o.data.grand_total} total rows
                      {o.data.fk_total > 0 && (
                        <> ({o.data.fk_total} FK-linked across {Object.keys(o.data.fk_tables).length} tables)</>
                      )}
                    </div>
                    {Object.keys(o.data.fk_tables).length > 0 && (
                      <div className="flex flex-wrap gap-2 mt-1">
                        {Object.entries(o.data.fk_tables).map(([table, count]) => (
                          <span key={table} className="text-[10px] font-mono bg-surface-2 px-1.5 py-0.5 rounded text-text-tertiary">
                            {table} {count}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>

                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      onClick={() => handleMerge(o.orphan.full_name, o.live.full_name)}
                      disabled={loading === o.orphan.full_name}
                      className="px-3 py-1 rounded text-xs font-medium bg-accent-green/20 text-accent-green hover:bg-accent-green/30 disabled:opacity-50"
                    >
                      {loading === o.orphan.full_name ? "Merging…" : "Merge into live"}
                    </button>
                    <button
                      onClick={() => handleDiscard(o.orphan.full_name)}
                      disabled={loading === o.orphan.full_name}
                      className="px-3 py-1 rounded text-xs font-medium bg-red-600/20 text-red-400 hover:bg-red-600/30 disabled:opacity-50"
                    >
                      Discard
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        })}

        {error && (
          <div className="px-4 py-2 text-xs text-red-400 border-t border-border">{error}</div>
        )}

        {/* All resolved? Show refresh button */}
        {Object.keys(results).length === orphans.length && (
          <div className="px-4 py-2 border-t border-border">
            <button onClick={onDone} className="text-xs text-accent-green hover:underline">
              ↻ Refresh repos
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
