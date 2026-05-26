"use client";
import { DELIVERIES } from "@/lib/mock-data";
import { PageHeader } from "@/components/ui";
import { formatDistanceToNow } from "date-fns";

const EVENT_ICONS: Record<string, string> = { push: "⟫", issues: "◎", pull_request: "⌥", issue_comment: "💬", installation: "⚡", check_suite: "✓" };

export default function DeliveriesPage() {
  return (
    <div className="animate-fade-in">
      <PageHeader title="Deliveries" subtitle={`${DELIVERIES.length} webhook deliveries`} />
      <div className="px-6 py-4">
        <div className="card overflow-hidden">
          <table className="w-full text-sm">
            <thead><tr className="border-b border-border text-[10px] font-mono text-text-tertiary uppercase tracking-wider">
              <th className="text-left px-4 py-2.5 font-medium">Event</th>
              <th className="text-left px-4 py-2.5 font-medium">Repo</th>
              <th className="text-left px-4 py-2.5 font-medium">Status</th>
              <th className="text-right px-4 py-2.5 font-medium">Latency</th>
              <th className="text-left px-4 py-2.5 font-medium">When</th>
            </tr></thead>
            <tbody>
              {DELIVERIES.map((d) => (
                <tr key={d.id} className="border-b border-border last:border-0 hover:bg-surface-2/40 transition-colors">
                  <td className="px-4 py-3"><span className="mr-1.5">{EVENT_ICONS[d.event] || "•"}</span><span className="font-mono text-xs text-text-primary">{d.event}</span></td>
                  <td className="px-4 py-3 font-mono text-xs text-text-secondary">{d.repo}</td>
                  <td className="px-4 py-3"><span className="text-[10px] px-2 py-0.5 rounded bg-green-500/20 text-green-400 font-mono">{d.status}</span></td>
                  <td className="px-4 py-3 text-right font-mono text-xs text-text-secondary">{d.duration_ms}ms</td>
                  <td className="px-4 py-3 font-mono text-xs text-text-tertiary whitespace-nowrap">{formatDistanceToNow(new Date(d.created_at), { addSuffix: true })}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
