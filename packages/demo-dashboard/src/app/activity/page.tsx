"use client";
import { ACTIVITY_FEED } from "@/lib/mock-data";
import { PageHeader } from "@/components/ui";
import { formatDistanceToNow } from "date-fns";

const SOURCE_ICONS: Record<string, string> = { ci_healing: "⚕", triage: "◎", custom_rules: "⚡", quality_gates: "🛡", issue_fix: "🔧", maintainer: "⟳" };
const TYPE_COLORS: Record<string, string> = { success: "border-green-800/30", warning: "border-amber-800/30", info: "border-blue-800/30", muted: "border-gray-800/30" };

export default function ActivityPage() {
  return (
    <div className="animate-fade-in">
      <PageHeader title="Activity" subtitle={`${ACTIVITY_FEED.length} recent events`} />
      <div className="px-6 py-4 space-y-2">
        {ACTIVITY_FEED.map((item) => (
          <div key={item.id} className={`card border-l-2 ${TYPE_COLORS[item.type] || ""} px-4 py-3 flex items-start gap-3`}>
            <span className="text-sm mt-0.5">{SOURCE_ICONS[item.source] || "•"}</span>
            <div className="flex-1">
              <div className="text-sm text-text-primary">{item.message}</div>
              <div className="text-xs text-text-tertiary mt-0.5"><span className="font-mono">{item.repo}</span> · <span className="font-mono">{item.source}</span> · {formatDistanceToNow(new Date(item.ts), { addSuffix: true })}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
