"use client";

import { ApiItem } from "@/lib/types";

import { useState } from "react";
import useSWR from "swr";

import { fetcher, API, triggerFix } from "@/lib/api";
import {
  PageHeader, StatCard, Badge, Skeleton, EmptyState,
} from "@/components/ui";
import { formatDistanceToNow } from "date-fns";
import clsx from "clsx";

const REPOS = [
  { owner: "xjeddah", name: "MyShell" },
  { owner: "xjeddah", name: "QwenPaw" },
];

const STATUS_VARIANT: Record<string, string> = {
  analyzing: "blue",
  generating: "amber",
  submitted: "green",
  merged: "purple",
  failed: "red",
  rejected: "red",
};

const COMPLEXITY_VARIANT: Record<string, string> = {
  trivial: "green",
  simple: "blue",
  moderate: "amber",
  complex: "red",
};

export default function FixAttemptsPage() {
  const [selectedRepo, setSelectedRepo] = useState(REPOS[0]);
  const [triggerIssueNumber, setTriggerIssueNumber] = useState("");
  const [triggering, setTriggering] = useState(false);
  const [triggerResult, setTriggerResult] = useState<string | null>(null);

  const { data: attemptsData, isLoading, mutate } = useSWR(
    API.fixAttempts(selectedRepo.owner, selectedRepo.name, "per_page=20"),
    fetcher,
    { refreshInterval: 10000 }
  );

  const attempts = attemptsData?.data ?? attemptsData ?? [];

  // Aggregate stats
  const stats = {
    total: attempts.length,
    submitted: attempts.filter((a: ApiItem) => a.status === "submitted").length,
    failed: attempts.filter((a: ApiItem) => a.status === "failed").length,
    rejected: attempts.filter((a: ApiItem) => a.status === "rejected").length,
  };

  async function handleTriggerFix() {
    if (!triggerIssueNumber) return;
    setTriggering(true);
    setTriggerResult(null);
    try {
      const result = await triggerFix(selectedRepo.owner, selectedRepo.name, Number(triggerIssueNumber));
      setTriggerResult(result.message || result.error || "Triggered");
      setTriggerIssueNumber("");
      setTimeout(() => mutate(), 3000);
    } catch (err) {
      setTriggerResult(`Error: ${err instanceof Error ? err.message : "unknown"}`);
    } finally {
      setTriggering(false);
    }
  }

  return (
    <div className="animate-fade-in">
      <PageHeader
        title="Autonomous Contributor"
        subtitle="AI-generated fix attempts across all repositories"
        actions={
          <div className="flex gap-2">
            {REPOS.map((r) => (
              <button
                key={`${r.owner}/${r.name}`}
                onClick={() => setSelectedRepo(r)}
                className={clsx(
                  "px-3 py-1.5 text-xs font-mono rounded border transition-all",
                  selectedRepo.owner === r.owner && selectedRepo.name === r.name
                    ? "bg-accent-green/15 border-accent-green/40 text-accent-green"
                    : "bg-surface-2 border-border text-text-secondary hover:text-text-primary"
                )}
              >
                {r.name}
              </button>
            ))}
          </div>
        }
      />

      {/* Stats + trigger */}
      <div className="grid grid-cols-4 gap-3 px-6 py-4 border-b border-border">
        <StatCard label="Total attempts" value={stats.total} />
        <StatCard label="Submitted" value={stats.submitted} accent="green" />
        <StatCard label="Failed" value={stats.failed} accent="red" />
        <div className="card p-4 animate-slide-up">
          <div className="text-xs text-text-tertiary font-mono uppercase tracking-wider mb-2">Trigger fix</div>
          <div className="flex gap-2">
            <input
              type="number"
              placeholder="Issue #"
              value={triggerIssueNumber}
              onChange={(e) => setTriggerIssueNumber(e.target.value)}
              className="flex-1 bg-surface-2 border border-border rounded px-3 py-1.5 text-sm text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent-green/60 font-mono w-20"
            />
            <button
              onClick={handleTriggerFix}
              disabled={triggering || !triggerIssueNumber}
              className="btn-primary text-xs disabled:opacity-50"
            >
              {triggering ? "↻" : "⚡ fix"}
            </button>
          </div>
          {triggerResult && (
            <div className={clsx("text-xs font-mono mt-1.5", triggerResult.startsWith("Error") ? "text-accent-red" : "text-accent-green")}>
              {triggerResult}
            </div>
          )}
        </div>
      </div>

      {/* Attempts table */}
      <div className="px-6 py-4">
        <div className="card overflow-hidden">
          {isLoading && (
            <div className="p-4 space-y-3">
              {[...Array(6)].map((_, i) => <Skeleton key={i} className="h-16" />)}
            </div>
          )}
          {!isLoading && !attempts.length && (
            <EmptyState icon="⚡" title="No fix attempts" body="Trigger a fix from an issue to get started." />
          )}

          {!isLoading && attempts.map((attempt: ApiItem, idx: number) => (
            <div
              key={String(attempt.id ?? idx)}
              className={clsx(
                "flex items-start gap-4 px-4 py-3 hover:bg-surface-2/50 transition-colors",
                idx < attempts.length - 1 && "border-b border-border"
              )}
            >
              {/* Status strip */}
              <div className={clsx("w-0.5 self-stretch rounded-full flex-shrink-0 mt-1", {
                "bg-accent-green":  attempt.status === "submitted",
                "bg-accent-blue":   attempt.status === "analyzing" || attempt.status === "generating",
                "bg-accent-red":    attempt.status === "failed" || attempt.status === "rejected",
                "bg-accent-purple": attempt.status === "merged",
                "bg-surface-4":     !attempt.status,
              })} />

              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-mono text-sm font-medium text-text-primary">
                    Issue #{String(attempt.issue_number)}
                  </span>
                  <Badge variant={STATUS_VARIANT[String(attempt.status)] ?? "default"}>
                    {String(attempt.status ?? "unknown")}
                  </Badge>
                  {attempt.complexity && (
                    <Badge variant={COMPLEXITY_VARIANT[String(attempt.complexity)] ?? "default"}>
                      {String(attempt.complexity)}
                    </Badge>
                  )}
                </div>

                {attempt.explanation && (
                  <p className="text-xs text-text-tertiary mt-1 leading-relaxed line-clamp-2">
                    {String(attempt.explanation)}
                  </p>
                )}

                <div className="flex items-center gap-3 mt-1.5 flex-wrap">
                  {attempt.pr_url && (
                    <a
                      href={String(attempt.pr_url)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs font-mono text-accent-green hover:underline"
                    >
                      PR #{String(attempt.pr_number ?? "")} →
                    </a>
                  )}
                  {attempt.error_message && (
                    <span className="text-xs font-mono text-accent-red line-clamp-1">{String(attempt.error_message)}</span>
                  )}
                  <span className="text-[10px] text-text-tertiary font-mono">
                    {attempt.created_at ? formatDistanceToNow(new Date(String(attempt.created_at)), { addSuffix: true }) : ""}
                  </span>
                </div>

                {attempt.files_patched && (
                  <div className="mt-1 flex gap-1 flex-wrap">
                    {(attempt.files_patched as string[]).map((f: string) => (
                      <span key={f} className="font-mono text-[10px] text-text-tertiary border border-border rounded px-1.5 py-0.5">
                        {f}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
