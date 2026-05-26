"use client";
import { PageHeader, EmptyState } from "@/components/ui";
import { ISSUES } from "@/lib/mock-data";

export default function DuplicatesPage() {
  const dupePairs = [
    { issue_a: "#412 Memory leak in WebSocket handler after reconnect", issue_b: "#389 WS connection leak under load", repo: "acme/api-gateway", similarity: 0.82, status: "pending" },
    { issue_a: "#89 Crash on launch when offline", issue_b: "#72 App crashes without network", repo: "acme/mobile-app", similarity: 0.91, status: "dismissed" },
  ];

  return (
    <div className="animate-fade-in">
      <PageHeader title="Duplicate Detection" subtitle={`${dupePairs.length} potential duplicates`} />
      <div className="px-6 py-4 space-y-3">
        {dupePairs.map((pair, i) => (
          <div key={i} className="card px-4 py-3">
            <div className="flex items-center justify-between mb-2">
              <span className="font-mono text-xs text-text-tertiary">{pair.repo}</span>
              <span className={`text-[10px] px-2 py-0.5 rounded font-mono ${pair.status === "pending" ? "bg-amber-500/20 text-amber-400" : "bg-surface-2 text-text-tertiary"}`}>{pair.status}</span>
            </div>
            <div className="text-sm text-text-primary">{pair.issue_a}</div>
            <div className="text-sm text-text-tertiary mt-0.5">{pair.issue_b}</div>
            <div className="text-xs text-text-tertiary mt-1">Similarity: <span className="text-accent-green font-mono">{(pair.similarity * 100).toFixed(0)}%</span></div>
          </div>
        ))}
        {dupePairs.length === 0 && <div className="card px-4 py-8"><EmptyState icon="⊗" title="No duplicates detected" body="Duplicate detection runs automatically when new issues are opened." /></div>}
      </div>
    </div>
  );
}
