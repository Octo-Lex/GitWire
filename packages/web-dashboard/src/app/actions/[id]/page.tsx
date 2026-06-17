"use client";

import { useState } from "react";
import useSWR from "swr";
import { useParams, useRouter } from "next/navigation";
import { fetcher } from "@/lib/api";
import {
  Badge,
  EmptyState,
  PageHeader,
} from "@/components/ui";

const STATUS_COLORS: Record<string, string> = {
  proposed: "bg-yellow-900/50 text-yellow-300",
  approved: "bg-blue-900/50 text-blue-300",
  executing: "bg-purple-900/50 text-purple-300",
  succeeded: "bg-green-900/50 text-green-300",
  failed: "bg-red-900/50 text-red-300",
  retrying: "bg-orange-900/50 text-orange-300",
  cancelled: "bg-gray-700/50 text-gray-400",
  reconciled: "bg-emerald-900/50 text-emerald-300",
};

interface Action {
  id: number;
  repo_full_name: string;
  pillar: string;
  action_type: string;
  source: string;
  status: string;
  proposed_at: string;
  approved_at: string | null;
  executed_at: string | null;
  resolved_at: string | null;
  reconciled_at: string | null;
  reconciliation_status: string | null;
  retries: number;
  max_retries: number;
  error_message: string | null;
  evidence: Record<string, unknown>;
  parent_action_id: number | null;
  target_type: string | null;
  target_number: number | null;
  created_at: string;
}

function fmt(ts: string | null | undefined): string {
  if (!ts) return "—";
  return new Date(ts).toLocaleString();
}

function TimelineStep({ label, time, active }: { label: string; time: string; active: boolean }) {
  return (
    <div className="flex items-center gap-3 py-2">
      <div className={"w-3 h-3 rounded-full " + (active ? "bg-green-400" : "bg-gray-600")} />
      <div className="flex-1">
        <div className="text-xs font-medium text-text-secondary">{label}</div>
        <div className="text-[10px] font-mono text-text-tertiary">{time}</div>
      </div>
    </div>
  );
}

export default function ActionDetailPage() {
  const params = useParams();
  const router = useRouter();
  const actionId = params.id as string;
  const [retrying, setRetrying] = useState(false);

  const { data: action, error: actionError, mutate } = useSWR<Action>(
    "/api/actions/" + actionId,
    fetcher
  );

  const { data: children } = useSWR<{ data: Action[] }>(
    "/api/actions?limit=50",
    fetcher
  );

  if (actionError) {
    return (
      <div className="p-6">
        <div className="text-red-400 text-sm mb-2">Failed to load action #{actionId}</div>
        <button
          className="text-xs text-accent-green hover:underline"
          onClick={() => mutate()}
        >
          Retry
        </button>
      </div>
    );
  }

  if (!action) {
    return (
      <div className="p-6 space-y-3">
        <div className="rounded shimmer h-8 w-48" />
        <div className="rounded shimmer h-32" />
        <div className="rounded shimmer h-32" />
      </div>
    );
  }

  const retryCount = children?.data?.filter(
    (c) => c.parent_action_id === action.id
  ).length || 0;

  async function handleRetry() {
    setRetrying(true);
    try {
      const res = await fetch("/api/actions/" + actionId + "/retry", {
        method: "POST",
        credentials: "include",
      });
      if (res.ok) {
        const child = await res.json();
        router.push("/actions/" + child.id);
      }
    } finally {
      setRetrying(false);
    }
  }

  async function handleCancel() {
    await fetch("/api/actions/" + actionId + "/cancel", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: "Cancelled from dashboard" }),
    });
    mutate();
  }

  return (
    <div>
      <PageHeader
        title={"Action #" + action.id}
        subtitle={action.repo_full_name + " — " + action.pillar + " / " + action.action_type}
      />

      {/* Status + controls */}
      <div className="px-6 py-4 border-b border-border flex items-center gap-3">
        <Badge className={STATUS_COLORS[action.status] || "bg-gray-700 text-gray-400"}>
          {action.status}
        </Badge>
        <span className="text-xs text-text-tertiary font-mono">{action.source}</span>
        <div className="flex-1" />
        {action.status === "failed" && (
          <button
            onClick={handleRetry}
            disabled={retrying}
            className="px-3 py-1 text-xs bg-orange-900/50 text-orange-300 rounded hover:bg-orange-800/50 disabled:opacity-50"
          >
            {retrying ? "Retrying..." : "🔄 Retry"}
          </button>
        )}
        {["proposed", "approved", "executing"].includes(action.status) && (
          <button
            onClick={handleCancel}
            className="px-3 py-1 text-xs bg-red-900/50 text-red-300 rounded hover:bg-red-800/50"
          >
            🚫 Cancel
          </button>
        )}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 p-6">
        {/* Timeline */}
        <div>
          <h3 className="text-xs font-mono uppercase text-text-tertiary tracking-wider mb-3">Timeline</h3>
          <div className="bg-surface-2 rounded-lg p-4">
            <TimelineStep label="Proposed" time={fmt(action.proposed_at)} active={!!action.proposed_at} />
            <TimelineStep label="Approved" time={fmt(action.approved_at)} active={!!action.approved_at} />
            <TimelineStep label="Executing" time={fmt(action.executed_at)} active={!!action.executed_at} />
            <TimelineStep label="Resolved" time={fmt(action.resolved_at)} active={!!action.resolved_at} />
            <TimelineStep label="Reconciled" time={fmt(action.reconciled_at)} active={!!action.reconciled_at} />
          </div>
        </div>

        {/* Evidence */}
        <div>
          <h3 className="text-xs font-mono uppercase text-text-tertiary tracking-wider mb-3">Evidence</h3>
          <div className="bg-surface-2 rounded-lg p-4 font-mono text-xs max-h-64 overflow-auto">
            <pre className="text-text-secondary whitespace-pre-wrap">
              {JSON.stringify(action.evidence, null, 2)}
            </pre>
          </div>
        </div>
      </div>

      {/* Error message */}
      {action.error_message && (
        <div className="mx-6 mb-4 p-3 bg-red-900/20 border border-red-800/30 rounded-lg">
          <div className="text-xs font-mono text-red-300">{action.error_message}</div>
        </div>
      )}

      {/* Metadata row */}
      <div className="px-6 pb-4 grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
        <div className="bg-surface-2 rounded-lg p-3">
          <div className="text-text-tertiary mb-1">Pillar</div>
          <div className="font-mono text-text-secondary">{action.pillar}</div>
        </div>
        <div className="bg-surface-2 rounded-lg p-3">
          <div className="text-text-tertiary mb-1">Action Type</div>
          <div className="font-mono text-text-secondary">{action.action_type}</div>
        </div>
        <div className="bg-surface-2 rounded-lg p-3">
          <div className="text-text-tertiary mb-1">Retries</div>
          <div className="font-mono text-text-secondary">{action.retries} / {action.max_retries}</div>
        </div>
        <div className="bg-surface-2 rounded-lg p-3">
          <div className="text-text-tertiary mb-1">Target</div>
          <div className="font-mono text-text-secondary">
            {action.target_type || "—"} {action.target_number ? "#" + action.target_number : ""}
          </div>
        </div>
      </div>

      {/* Parent / retry chain */}
      {action.parent_action_id && (
        <div className="px-6 pb-4 text-xs">
          <span className="text-text-tertiary">Retry of </span>
          <a href={"/actions/" + action.parent_action_id} className="text-accent-green hover:underline">
            #{action.parent_action_id}
          </a>
        </div>
      )}
      {retryCount > 0 && (
        <div className="px-6 pb-4 text-xs">
          <span className="text-text-tertiary">{retryCount} retr{retryCount === 1 ? "y" : "ies"}</span>
        </div>
      )}

      {/* Reconciliation status */}
      {action.reconciliation_status && (
        <div className="px-6 pb-4">
          <Badge className={action.reconciliation_status === "confirmed"
            ? "bg-emerald-900/50 text-emerald-300"
            : "bg-yellow-900/50 text-yellow-300"}>
            Reconciliation: {action.reconciliation_status}
          </Badge>
        </div>
      )}
    </div>
  );
}
