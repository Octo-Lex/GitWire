"use client";

import useSWR from "swr";
import { fetcher, API, dequeuePR, updateQueueConfig, createFeedbackRule, updateFeedbackRule, deleteFeedbackRule } from "../../lib/api";
import { useState } from "react";

// ── Tab definition ──────────────────────────────────────────────────────────
const TABS = [
  { key: "queue", label: "Merge Queue" },
  { key: "feedback", label: "Feedback Rules" },
  { key: "telemetry", label: "Telemetry" },
  { key: "rollbacks", label: "Rollbacks" },
] as const;
type TabKey = (typeof TABS)[number]["key"];

export default function AutomationPage() {
  const [tab, setTab] = useState<TabKey>("queue");
  return (
    <div className="p-6 space-y-6">
      <h1 className="text-2xl font-bold text-text-primary">Automation</h1>

      {/* Tab bar */}
      <div className="flex gap-1 border-b border-border">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`px-4 py-2 text-sm font-medium transition-colors ${
              tab === t.key
                ? "border-b-2 border-accent-green text-accent-green"
                : "text-text-secondary hover:text-text-primary"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "queue" && <MergeQueueTab />}
      {tab === "feedback" && <FeedbackTab />}
      {tab === "telemetry" && <TelemetryTab />}
      {tab === "rollbacks" && <RollbacksTab />}
    </div>
  );
}

// ── Merge Queue Tab ─────────────────────────────────────────────────────────
function MergeQueueTab() {
  const { data, mutate } = useSWR(API.queue(), fetcher, { refreshInterval: 10000 });
  const entries = data?.rows ?? data ?? [];

  return (
    <div className="space-y-4">
      <p className="text-sm text-text-secondary">PRs waiting for auto-merge. Updates every 10s.</p>
      {entries.length === 0 ? (
        <p className="text-text-tertiary text-sm py-8 text-center">No entries in the merge queue.</p>
      ) : (
        <div className="space-y-2">
          {entries.map((e: any) => (
            <div key={e.id} className="bg-surface-1 border border-border rounded-lg p-4 flex items-center justify-between">
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-mono bg-accent-green/10 text-accent-green px-2 py-0.5 rounded">#{e.position}</span>
                  <span className="text-sm font-medium text-text-primary">{e.repo_full_name} #{e.pr_number}</span>
                  <span className={`text-xs px-2 py-0.5 rounded ${statusColor(e.status)}`}>{e.status}</span>
                </div>
                <p className="text-xs text-text-secondary">{e.pr_title}</p>
                <p className="text-xs text-text-tertiary">
                  by {e.author_login} · {e.merge_method} · {new Date(e.admitted_at).toLocaleString()}
                </p>
              </div>
              {e.status !== "merged" && e.status !== "removed" && (
                <button
                  onClick={() => { dequeuePR(e.owner, e.repo_name, e.pr_number).then(() => mutate()); }}
                  className="text-xs px-3 py-1.5 rounded border border-border hover:bg-surface-2 text-text-secondary"
                >
                  Dequeue
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Feedback Tab ────────────────────────────────────────────────────────────
function FeedbackTab() {
  const { data, mutate } = useSWR(API.feedbackRules(), fetcher, { refreshInterval: 30000 });
  const rules = Array.isArray(data) ? data : [];
  const [showCreate, setShowCreate] = useState(false);

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center">
        <p className="text-sm text-text-secondary">Notification rules for pipeline events.</p>
        <button onClick={() => setShowCreate(true)} className="text-xs px-3 py-1.5 bg-accent-green text-white rounded hover:opacity-90">
          + Add Rule
        </button>
      </div>

      {rules.length === 0 ? (
        <p className="text-text-tertiary text-sm py-8 text-center">No feedback rules configured.</p>
      ) : (
        <div className="space-y-2">
          {rules.map((r: any) => (
            <div key={r.id} className="bg-surface-1 border border-border rounded-lg p-4 flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-text-primary">{r.name}</p>
                <p className="text-xs text-text-secondary">{r.event_type} · {r.org} · {r.enabled ? "Enabled" : "Disabled"}</p>
                <div className="flex gap-2 mt-1">
                  {r.post_pr_comment && <span className="text-[10px] bg-blue-500/10 text-blue-400 px-1.5 py-0.5 rounded">PR Comment</span>}
                  {r.slack_webhook && <span className="text-[10px] bg-purple-500/10 text-purple-400 px-1.5 py-0.5 rounded">Slack</span>}
                  {r.teams_webhook && <span className="text-[10px] bg-indigo-500/10 text-indigo-400 px-1.5 py-0.5 rounded">Teams</span>}
                </div>
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => { updateFeedbackRule(r.id, { enabled: !r.enabled }).then(() => mutate()); }}
                  className={`text-xs px-3 py-1.5 rounded border ${r.enabled ? "border-red-400/30 text-red-400" : "border-green-400/30 text-green-400"}`}
                >
                  {r.enabled ? "Disable" : "Enable"}
                </button>
                <button
                  onClick={() => { deleteFeedbackRule(r.id).then(() => mutate()); }}
                  className="text-xs px-3 py-1.5 rounded border border-border text-text-secondary hover:text-red-400"
                >
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Telemetry Tab ───────────────────────────────────────────────────────────
function TelemetryTab() {
  const { data: summary } = useSWR(API.telemetrySummary(), fetcher, { refreshInterval: 15000 });
  const { data: events } = useSWR(API.telemetryEvents("perPage=20"), fetcher, { refreshInterval: 10000 });
  const evts = events?.rows ?? events ?? [];

  return (
    <div className="space-y-6">
      {/* Summary cards */}
      <div className="grid grid-cols-5 gap-4">
        {[
          { label: "Merges", value: summary?.merges?.total ?? 0, sub: (summary?.merges?.avg_duration_s ?? 0) + "s avg" },
          { label: "Blocks", value: summary?.blocks?.total ?? 0 },
          { label: "Heals", value: summary?.heals?.total ?? 0 },
          { label: "Feedbacks", value: summary?.feedbacks?.total ?? 0 },
          { label: "CI Pass Rate", value: (summary?.ci_pass_rate ?? 0) + "%" },
        ].map((c) => (
          <div key={c.label} className="bg-surface-1 border border-border rounded-lg p-4 text-center">
            <p className="text-2xl font-bold text-text-primary">{c.value}</p>
            <p className="text-xs text-text-secondary">{c.label}</p>
            {c.sub && <p className="text-[10px] text-text-tertiary mt-1">{c.sub}</p>}
          </div>
        ))}
      </div>

      {/* Event stream */}
      <div>
        <h3 className="text-sm font-medium text-text-primary mb-3">Recent Events</h3>
        <div className="space-y-1 max-h-80 overflow-y-auto">
          {evts.map((e: any) => (
            <div key={e.id} className="flex items-center gap-3 py-1.5 px-2 rounded hover:bg-surface-1">
              <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded ${eventTypeColor(e.event_type)}`}>{e.event_type}</span>
              <span className="text-xs text-text-primary">{e.repo_full_name ?? "—"}</span>
              {e.actor && <span className="text-[10px] text-text-tertiary">by {e.actor}</span>}
              <span className="text-[10px] text-text-tertiary ml-auto">{new Date(e.occurred_at).toLocaleString()}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── Rollbacks Tab ───────────────────────────────────────────────────────────
function RollbacksTab() {
  const { data } = useSWR(API.rollbacks("perPage=20"), fetcher, { refreshInterval: 15000 });
  const rollbacks = data?.rows ?? data ?? [];

  return (
    <div className="space-y-4">
      <p className="text-sm text-text-secondary">Automatic and manual rollback history.</p>
      {rollbacks.length === 0 ? (
        <p className="text-text-tertiary text-sm py-8 text-center">No rollbacks recorded.</p>
      ) : (
        <div className="space-y-2">
          {rollbacks.map((rb: any) => (
            <div key={rb.id} className="bg-surface-1 border border-border rounded-lg p-4">
              <div className="flex items-center gap-2">
                <span className={`text-xs px-2 py-0.5 rounded ${statusColor(rb.status)}`}>{rb.status}</span>
                <span className="text-sm font-medium text-text-primary">{rb.repo_full_name}</span>
              </div>
              <p className="text-xs text-text-secondary mt-1">{rb.trigger_reason}</p>
              <p className="text-[10px] text-text-tertiary mt-1">{new Date(rb.created_at).toLocaleString()}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function statusColor(status: string) {
  const map: Record<string, string> = {
    pending: "bg-yellow-500/10 text-yellow-400",
    ready: "bg-blue-500/10 text-blue-400",
    merging: "bg-purple-500/10 text-purple-400",
    merged: "bg-green-500/10 text-green-400",
    blocked: "bg-red-500/10 text-red-400",
    removed: "bg-gray-500/10 text-gray-400",
    reverted: "bg-green-500/10 text-green-400",
    failed: "bg-red-500/10 text-red-400",
  };
  return map[status] ?? "bg-gray-500/10 text-gray-400";
}

function eventTypeColor(type: string) {
  if (type.includes("merged"))   return "bg-green-500/10 text-green-400";
  if (type.includes("blocked"))  return "bg-red-500/10 text-red-400";
  if (type.includes("heal"))     return "bg-purple-500/10 text-purple-400";
  if (type.includes("feedback")) return "bg-blue-500/10 text-blue-400";
  if (type.includes("rollback")) return "bg-orange-500/10 text-orange-400";
  return "bg-gray-500/10 text-gray-400";
}
