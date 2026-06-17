"use client";

import { useState, useCallback } from "react";
import useSWR from "swr";
import { fetcher } from "@/lib/api";
import {
  PageHeader, Badge, Skeleton, EmptyState,
} from "@/components/ui";
import { formatDistanceToNow } from "date-fns";

const STATUS_OPTIONS = [
  "draft", "validated", "review_ready", "approved",
  "promoted", "rolled_back", "rejected", "cancelled",
];

const STATUS_STYLES: Record<string, string> = {
  draft:        "bg-gray-500/10 text-gray-400 border-gray-500/20",
  validated:    "bg-blue-500/10 text-blue-400 border-blue-500/20",
  review_ready: "bg-amber-500/10 text-amber-400 border-amber-500/20",
  approved:     "bg-green-500/10 text-green-400 border-green-500/20",
  promoted:     "bg-green-500/10 text-green-400 border-green-500/20",
  rolled_back:  "bg-gray-500/10 text-gray-400 border-gray-500/20",
  rejected:     "bg-red-500/10 text-red-400 border-red-500/20",
  cancelled:    "bg-gray-500/10 text-gray-400 border-gray-500/20",
};

const TERMINAL_STATES = new Set(["rolled_back", "rejected", "cancelled"]);

const LIFECYCLE_ORDER = [
  "draft", "validated", "review_ready", "approved", "promoted", "rolled_back",
];

interface RolloutActionParams {
  action: string;
  planId: number;
  actor?: string;
  reason?: string;
  acknowledged_recommendations?: string[];
}

export default function RolloutsPage() {
  const [statusFilter, setStatusFilter] = useState("");
  const [repoFilter, setRepoFilter] = useState("");
  const [selectedPlan, setSelectedPlan] = useState<number | null>(null);
  const [actionModal, setActionModal] = useState<{ action: string; planId: number } | null>(null);
  const [actionReason, setActionReason] = useState("");
  const [actionActor, setActionActor] = useState("");
  const [actionLoading, setActionLoading] = useState(false);
  const [actionError, setActionError] = useState("");
  const [acknowledgedRecs, setAcknowledgedRecs] = useState<string[]>([]);

  const queryParts: string[] = [];
  if (statusFilter) queryParts.push("status=" + statusFilter);
  if (repoFilter) queryParts.push("repo=" + repoFilter);
  const queryString = queryParts.join("&");

  const { data: listData, error: listError, mutate: mutateList } = useSWR(
    "/api/rollouts" + (queryString ? "?" + queryString : ""),
    fetcher
  );

  const { data: planData, error: planError, mutate: mutatePlan } = useSWR(
    selectedPlan ? "/api/rollouts/" + selectedPlan : null,
    fetcher
  );

  const plans = listData?.data ?? [];
  const total = listData?.total ?? 0;

  const runAction = useCallback(async (params: RolloutActionParams) => {
    const { action, planId, actor, reason, acknowledged_recommendations } = params;
    setActionLoading(true);
    setActionError("");
    try {
      const BASE = process.env.NEXT_PUBLIC_API_URL || "";
      const API_KEY = process.env.NEXT_PUBLIC_API_KEY || "";
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (API_KEY) headers["Authorization"] = "Bearer " + API_KEY;

      const body: Record<string, unknown> = { actor: actor || actionActor };
      if (reason !== undefined) body.reason = reason;
      if (acknowledged_recommendations) body.acknowledged_recommendations = acknowledged_recommendations;

      const res = await fetch(
        BASE + "/api/rollouts/" + planId + "/" + action,
        { method: "POST", headers, body: JSON.stringify(body) }
      );
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "HTTP " + res.status);
      }
      await mutatePlan();
      await mutateList();
      setActionModal(null);
      setActionReason("");
      setActionError("");
      setAcknowledgedRecs([]);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Action failed";
      setActionError(msg);
    } finally {
      setActionLoading(false);
    }
  }, [actionActor, mutatePlan, mutateList]);

  return (
    <div>
      <PageHeader title="Policy Rollouts" subtitle="Controlled policy lifecycle: plan, validate, approve, promote, roll back" />

      {/* Filters */}
      <div className="flex flex-wrap gap-2 mb-4">
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="bg-surface-2 border border-border rounded px-2 py-1.5 text-xs text-text-primary"
        >
          <option value="">All statuses</option>
          {STATUS_OPTIONS.map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
        <input
          type="text"
          placeholder="Filter by repo (owner/repo)..."
          value={repoFilter}
          onChange={(e) => setRepoFilter(e.target.value)}
          className="bg-surface-2 border border-border rounded px-2 py-1.5 text-xs text-text-primary"
        />
        {(statusFilter || repoFilter) && (
          <button
            onClick={() => { setStatusFilter(""); setRepoFilter(""); }}
            className="text-xs text-text-tertiary hover:text-text-primary"
          >
            Clear filters
          </button>
        )}
      </div>

      {/* List error */}
      {listError && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/5 px-4 py-3 mb-4">
          <div className="text-red-400 text-sm font-mono mb-1">Failed to load rollouts</div>
          <div className="text-red-400/70 text-xs">{String(listError)}</div>
        </div>
      )}

      {/* Loading */}
      {!listData && !listError && (
        <div className="space-y-2">
          {[1, 2, 3, 4, 5].map((i) => (
            <Skeleton key={i} className="h-16 w-full" />
          ))}
        </div>
      )}

      {/* Empty state */}
      {listData && plans.length === 0 && (
        <EmptyState
          title="No rollout plans"
          subtitle="Create a rollout plan from the API to start a controlled policy lifecycle."
        />
      )}

      {/* List */}
      {listData && plans.length > 0 && (
        <div className="mb-6">
          <div className="text-xs text-text-tertiary mb-2">{total} plan(s) total</div>
          <div className="divide-y divide-border rounded-lg border border-border">
            {plans.map((p: any) => (
              <div
                key={p.id}
                className={"px-4 py-3 cursor-pointer hover:bg-surface-2/50 transition-colors " + (
                  selectedPlan === p.id ? "bg-surface-2" : ""
                )}
                onClick={() => setSelectedPlan(p.id)}
              >
                <div className="flex items-center gap-3">
                  <span className="text-xs font-mono text-text-tertiary">#{p.id}</span>
                  <span className={"text-[10px] font-mono px-1.5 py-0.5 rounded border " + (STATUS_STYLES[p.status] || "")}>
                    {p.status}
                  </span>
                  <span className="text-xs text-text-secondary">{p.repo_full_name || "repo " + p.repo_id}</span>
                  {p.proposed_config?.dry_run && (
                    <span className="text-[10px] font-mono text-amber-400">dry-run</span>
                  )}
                  {p.recommendations_summary?.summary && (
                    <span className="text-[10px] font-mono text-text-tertiary">
                      {p.recommendations_summary.summary.critical > 0 && (
                        <span className="text-red-400">{p.recommendations_summary.summary.critical} critical </span>
                      )}
                      {p.recommendations_summary.summary.warning > 0 && (
                        <span className="text-amber-400">{p.recommendations_summary.summary.warning} warning </span>
                      )}
                    </span>
                  )}
                  <span className="flex-1" />
                  <span className="text-[10px] text-text-tertiary">
                    {formatDistanceToNow(new Date(p.created_at), { addSuffix: true })}
                  </span>
                </div>
                <div className="text-[10px] text-text-tertiary mt-1">
                  by {p.created_by}
                  {p.approved_by && " · approved by " + p.approved_by}
                  {p.promoted_by && " · promoted by " + p.promoted_by}
                  {p.rolled_back_by && " · rolled back by " + p.rolled_back_by}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Detail panel */}
      {planData && (
        <div className="mt-6 space-y-6">
          {/* Lifecycle timeline */}
          <div>
            <div className="text-xs font-mono uppercase text-text-tertiary tracking-wider mb-2">Lifecycle</div>
            <div className="flex items-center gap-1 flex-wrap">
              {LIFECYCLE_ORDER.map((state, i) => {
                const isPassed = LIFECYCLE_ORDER.indexOf(planData.status) >= i;
                const isCurrent = planData.status === state;
                const isTerminal = TERMINAL_STATES.has(planData.status);
                return (
                  <span key={state}>
                    <span className={"text-[10px] font-mono px-1.5 py-0.5 rounded border " + (
                      isCurrent ? (STATUS_STYLES[state] || "") :
                      isPassed ? "bg-surface-2 text-text-secondary border-border" :
                      "bg-transparent text-text-tertiary border-border opacity-50"
                    )}>
                      {state}
                    </span>
                    {i < LIFECYCLE_ORDER.length - 1 && (
                      <span className="text-text-tertiary mx-0.5">{"->"}</span>
                    )}
                  </span>
                );
              })}
              {planData.status === "rejected" && (
                <span className="text-[10px] font-mono px-1.5 py-0.5 rounded border bg-red-500/10 text-red-400 border-red-500/20 ml-2">
                  rejected
                </span>
              )}
              {planData.status === "cancelled" && (
                <span className="text-[10px] font-mono px-1.5 py-0.5 rounded border bg-gray-500/10 text-gray-400 border-gray-500/20 ml-2">
                  cancelled
                </span>
              )}
            </div>
          </div>

          {/* Evidence summary */}
          <div>
            <div className="text-xs font-mono uppercase text-text-tertiary tracking-wider mb-2">Evidence</div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
              <EvidenceCard label="Validation" attached={!!planData.validation_result} detail={
                planData.validation_result?.valid === false ? "invalid" : "valid"
              } />
              <EvidenceCard label="Simulation" attached={!!planData.simulation_summary} detail={
                planData.simulation_summary
                  ? (planData.simulation_summary.would_act || 0) + " would act"
                  : null
              } />
              <EvidenceCard label="Diff Impact" attached={!!planData.diff_impact_summary} detail={
                planData.diff_impact_summary?.changes?.dry_run ? "dry-run change" : null
              } />
              <EvidenceCard label="Recommendations" attached={!!planData.recommendations_summary} detail={
                planData.recommendations_summary?.summary
                  ? (planData.recommendations_summary.summary.critical + " critical")
                  : null
              } />
            </div>
          </div>

          {/* Actor metadata */}
          <div>
            <div className="text-xs font-mono uppercase text-text-tertiary tracking-wider mb-2">Audit Trail</div>
            <div className="bg-surface-2 rounded-lg border border-border p-3 space-y-1">
              <AuditRow label="Created by" value={planData.created_by} at={planData.created_at} />
              {planData.approved_by && (
                <AuditRow label="Approved by" value={planData.approved_by} at={planData.approved_at} reason={planData.approval_reason} />
              )}
              {planData.promoted_by && (
                <AuditRow label="Promoted by" value={planData.promoted_by} at={planData.promoted_at} reason={planData.promotion_reason} />
              )}
              {planData.rejected_by && (
                <AuditRow label="Rejected by" value={planData.rejected_by} at={planData.rejected_at} reason={planData.rejection_reason} />
              )}
              {planData.rolled_back_by && (
                <AuditRow label="Rolled back by" value={planData.rolled_back_by} at={planData.rolled_back_at} reason={planData.rollback_reason} />
              )}
              {planData.cancelled_by && (
                <AuditRow label="Cancelled by" value={planData.cancelled_by} at={planData.cancelled_at} />
              )}
            </div>
          </div>

          {/* Config snapshots */}
          <div>
            <div className="text-xs font-mono uppercase text-text-tertiary tracking-wider mb-2">Policy Snapshots (Redacted)</div>
            <div className="space-y-2">
              <ConfigBlock label="Proposed Config" config={planData.proposed_config} />
              {planData.previous_config && (
                <ConfigBlock label="Previous Config (for rollback)" config={planData.previous_config} />
              )}
              {planData.replaced_config_snapshot && (
                <ConfigBlock label="Replaced Config (captured at rollback)" config={planData.replaced_config_snapshot} />
              )}
            </div>
          </div>

          {/* Rollback evidence */}
          {planData.rollback_evidence && (
            <div>
              <div className="text-xs font-mono uppercase text-text-tertiary tracking-wider mb-2">Rollback Evidence</div>
              <div className="bg-surface-2 rounded-lg border border-border p-3">
                <div className="text-[10px] font-mono text-text-tertiary">
                  restored: {String(planData.rollback_evidence.restored_previous_config)}
                  {" | "}replaced captured: {String(planData.rollback_evidence.replaced_config_captured)}
                </div>
                {planData.rollback_evidence.previous_config_hash && (
                  <div className="text-[10px] font-mono text-text-tertiary mt-1">
                    previous_hash: {planData.rollback_evidence.previous_config_hash}
                  </div>
                )}
                {planData.rollback_evidence.replaced_config_hash && (
                  <div className="text-[10px] font-mono text-text-tertiary">
                    replaced_hash: {planData.rollback_evidence.replaced_config_hash}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Actions panel */}
          {!TERMINAL_STATES.has(planData.status) && (
            <div>
              <div className="text-xs font-mono uppercase text-text-tertiary tracking-wider mb-2">Actions</div>
              <div className="flex flex-wrap gap-2">
                {getAllowedActions(planData.status).map((action) => (
                  <button
                    key={action}
                    onClick={() => {
                      setActionModal({ action, planId: planData.id });
                      setActionReason("");
                      setActionError("");
                      setAcknowledgedRecs([]);
                    }}
                    className={"px-3 py-1.5 text-xs font-mono font-bold rounded transition-colors " + getActionStyle(action)}
                  >
                    {action}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Action modal */}
      {actionModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-surface-1 border border-border rounded-lg p-6 max-w-md w-full mx-4">
            <div className="text-sm font-mono font-bold text-text-primary mb-3 capitalize">
              {actionModal.action} rollout #{actionModal.planId}
            </div>

            {/* Consequence warning */}
            <div className={"rounded p-2 mb-3 text-xs " + getConsequenceStyle(actionModal.action)}>
              {getConsequenceText(actionModal.action)}
            </div>

            {/* Critical recs acknowledgement */}
            {actionModal.action === "approve" &&
              planData?.recommendations_summary?.recommendations
                ?.filter((r: any) => r.severity === "critical")
                ?.map((r: any) => (
                  <label key={r.id} className="flex items-center gap-2 mb-1 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={acknowledgedRecs.includes(r.id)}
                      onChange={(e) => {
                        if (e.target.checked) {
                          setAcknowledgedRecs([...acknowledgedRecs, r.id]);
                        } else {
                          setAcknowledgedRecs(acknowledgedRecs.filter(x => x !== r.id));
                        }
                      }}
                      className="accent-amber-500"
                    />
                    <span className="text-xs text-text-secondary">{r.title}</span>
                  </label>
                ))
            }

            <input
              type="text"
              placeholder="Your GitHub username"
              value={actionActor}
              onChange={(e) => setActionActor(e.target.value)}
              className="w-full bg-surface-2 border border-border rounded px-3 py-2 text-xs text-text-primary mb-2"
            />
            <textarea
              placeholder={"Reason for " + actionModal.action + "..."}
              value={actionReason}
              onChange={(e) => setActionReason(e.target.value)}
              className="w-full bg-surface-2 border border-border rounded px-3 py-2 text-xs text-text-primary mb-2"
              rows={3}
            />

            {actionError && (
              <div className="text-xs text-red-400 mb-2">{actionError}</div>
            )}

            <div className="flex gap-2 justify-end">
              <button
                onClick={() => { setActionModal(null); setActionError(""); }}
                className="px-3 py-1.5 text-xs text-text-tertiary hover:text-text-primary"
              >
                Cancel
              </button>
              <button
                onClick={() => runAction({
                  action: actionModal.action,
                  planId: actionModal.planId,
                  actor: actionActor,
                  reason: actionReason,
                  acknowledged_recommendations: actionModal.action === "approve" ? acknowledgedRecs : undefined,
                })}
                disabled={actionLoading || !actionActor.trim() || (requiresReason(actionModal.action) && !actionReason.trim())}
                className="px-4 py-1.5 text-xs font-mono font-bold rounded bg-accent-green text-surface-0 disabled:opacity-50"
              >
                {actionLoading ? "Working..." : "Confirm " + actionModal.action}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function getAllowedActions(status: string): string[] {
  switch (status) {
    case "draft":        return ["cancel"];
    case "validated":    return ["cancel"];
    case "review_ready": return ["approve", "reject", "cancel"];
    case "approved":     return ["promote", "cancel"];
    case "promoted":     return ["rollback"];
    default:             return [];
  }
}

function getActionStyle(action: string): string {
  switch (action) {
    case "approve":  return "bg-green-500/10 text-green-400 border border-green-500/20 hover:bg-green-500/20";
    case "reject":   return "bg-red-500/10 text-red-400 border border-red-500/20 hover:bg-red-500/20";
    case "promote":  return "bg-green-500/10 text-green-400 border border-green-500/20 hover:bg-green-500/20";
    case "rollback": return "bg-amber-500/10 text-amber-400 border border-amber-500/20 hover:bg-amber-500/20";
    case "cancel":   return "bg-gray-500/10 text-gray-400 border border-gray-500/20 hover:bg-gray-500/20";
    default:         return "bg-surface-2 text-text-secondary border border-border";
  }
}

function getConsequenceText(action: string): string {
  switch (action) {
    case "promote":
      return "Promoting this rollout will replace the active repository policy with the approved proposed policy. The previous policy snapshot will be retained for rollback evidence.";
    case "rollback":
      return "Rolling back will restore the previous policy snapshot captured before promotion. The current active policy will be captured as replaced-config evidence.";
    case "reject":
      return "Rejecting this rollout is terminal. It cannot be approved or promoted later.";
    case "approve":
      return "Approving this rollout allows it to be promoted to live policy. No policy is written yet.";
    case "cancel":
      return "Cancelling this rollout is terminal. It cannot be resumed.";
    default:
      return "";
  }
}

function getConsequenceStyle(action: string): string {
  if (action === "promote" || action === "rollback") {
    return "bg-amber-500/10 text-amber-400 border border-amber-500/20";
  }
  if (action === "reject" || action === "cancel") {
    return "bg-red-500/10 text-red-400 border border-red-500/20";
  }
  return "bg-surface-2 text-text-secondary border border-border";
}

function requiresReason(action: string): boolean {
  return action === "rollback" || action === "approve" || action === "reject" || action === "promote";
}

function EvidenceCard({ label, attached, detail }: { label: string; attached: boolean; detail?: string | null }) {
  return (
    <div className={"rounded-lg border p-2 " + (
      attached ? "border-green-500/20 bg-green-500/5" : "border-border bg-surface-2 opacity-60"
    )}>
      <div className="text-[10px] font-mono uppercase text-text-tertiary">{label}</div>
      <div className={"text-xs font-mono " + (attached ? "text-green-400" : "text-text-tertiary")}>
        {attached ? (detail || "attached") : "not attached"}
      </div>
    </div>
  );
}

function AuditRow({ label, value, at, reason }: { label: string; value: string; at?: string; reason?: string }) {
  return (
    <div className="flex items-start gap-2 text-xs">
      <span className="text-text-tertiary font-mono min-w-[100px]">{label}</span>
      <span className="text-text-secondary">{value}</span>
      {at && (
        <span className="text-text-tertiary text-[10px]">
          {formatDistanceToNow(new Date(at), { addSuffix: true })}
        </span>
      )}
      {reason && (
        <span className="text-text-tertiary text-[10px] truncate">— {reason}</span>
      )}
    </div>
  );
}

function ConfigBlock({ label, config }: { label: string; config: any }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="bg-surface-2 rounded-lg border border-border">
      <div
        className="px-3 py-2 cursor-pointer flex items-center gap-2"
        onClick={() => setExpanded(!expanded)}
      >
        <span className="text-[10px] font-mono uppercase text-text-tertiary">{label}</span>
        <span className="text-[10px] text-text-tertiary">(redacted)</span>
        <span className="flex-1" />
        <span className="text-[10px] text-text-tertiary">{expanded ? "[hide]" : "[show]"}</span>
      </div>
      {expanded && (
        <pre className="px-3 pb-3 text-[10px] font-mono text-text-secondary overflow-x-auto">
          {JSON.stringify(config, null, 2)}
        </pre>
      )}
    </div>
  );
}
