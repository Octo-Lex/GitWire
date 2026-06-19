"use client";

import useSWR from "swr";
import { useApi, fetcher, API } from "@/lib/api";
import { Skeleton } from "@/components/ui";
import Link from "next/link";
import { useState } from "react";

// ── Types ───────────────────────────────────────────────────────────────────

interface SetupCheck {
  id: string;
  label: string;
  category: string;
  status: "pass" | "warn" | "fail" | "error";
  blocking: boolean;
  detail: string;
}

interface SetupStatus {
  overall: "ready" | "not_configured" | "action_needed" | "degraded";
  completed: number;
  total: number;
  next_step: {
    id: string;
    label: string;
    detail: string;
    recommendation: string;
  } | null;
  checks: SetupCheck[];
}

interface TemplateMeta {
  id: string;
  name: string;
  description: string;
  difficulty: string;
  dry_run: boolean;
  safety: string;
  safety_label: string;
  pillars_active: string[];
}

// ── Visual config ───────────────────────────────────────────────────────────

const STATUS_META: Record<
  string,
  { icon: string; color: string; bg: string }
> = {
  pass: { icon: "✓", color: "text-accent-green", bg: "bg-accent-green/10" },
  warn: { icon: "⚠", color: "text-accent-amber", bg: "bg-accent-amber/10" },
  fail: { icon: "✗", color: "text-accent-red", bg: "bg-accent-red/10" },
  error: { icon: "✕", color: "text-accent-red", bg: "bg-accent-red/10" },
};

const OVERALL_META: Record<
  string,
  { label: string; bar: string; text: string }
> = {
  not_configured: {
    label: "Configuration Required",
    bar: "bg-accent-red",
    text: "text-accent-red",
  },
  action_needed: {
    label: "Action Needed",
    bar: "bg-accent-amber",
    text: "text-accent-amber",
  },
  degraded: {
    label: "System Degraded",
    bar: "bg-accent-red",
    text: "text-accent-red",
  },
  ready: {
    label: "All Systems Ready",
    bar: "bg-accent-green",
    text: "text-accent-green",
  },
};

const DIFFICULTY_META: Record<string, string> = {
  beginner: "bg-accent-green/10 text-accent-green border-accent-green/25",
  intermediate: "bg-accent-blue/10 text-accent-blue border-accent-blue/25",
  advanced: "bg-accent-purple/10 text-accent-purple border-accent-purple/25",
};

const SAFETY_META: Record<
  string,
  { label: string; variant: string }
> = {
  "dry-run-protected": { label: "Dry-run protected", variant: "green" },
  "low-risk-live": { label: "Low-risk live", variant: "green" },
  "safe-to-preview": { label: "Safe to preview", variant: "blue" },
  "review-before-rollout": { label: "Review before rollout", variant: "amber" },
};

// ── Component ───────────────────────────────────────────────────────────────

export default function SetupChecklist() {
  const { data: setup, isLoading } = useSWR<SetupStatus>(
    API.setup(),
    fetcher,
    { refreshInterval: 60000 }
  );

  // Don't render while loading or when everything is ready
  if (isLoading) return null;
  if (!setup) return null;
  if (setup.overall === "ready") return null;

  const meta = OVERALL_META[setup.overall] ?? OVERALL_META.action_needed;

  // Check if .gitwire.yml is missing — if so, show template suggestions
  const ymlCheck = setup.checks.find((c) => c.id === "gitwire_yml_found");
  const needsTemplates = ymlCheck && ymlCheck.status !== "pass";

  return (
    <div className="border-b border-border animate-fade-in">
      {/* Status bar */}
      <div className={`h-1 ${meta.bar}`} />

      <div className="px-6 py-5">
        {/* Header */}
        <div className="flex items-center justify-between mb-1">
          <div className="flex items-center gap-3">
            <span className={`text-sm font-display font-bold ${meta.text}`}>
              {meta.label}
            </span>
            <span className="text-xs font-mono text-text-tertiary">
              {setup.completed}/{setup.total} checks passed
            </span>
          </div>
          <span className="text-[10px] font-mono text-text-tertiary uppercase tracking-wider">
            Setup Checklist
          </span>
        </div>

        {/* Progress bar */}
        <div className="h-1 bg-surface-3 rounded-full overflow-hidden mb-4">
          <div
            className={`h-full rounded-full transition-all ${meta.bar}`}
            style={{
              width: `${setup.total > 0 ? (setup.completed / setup.total) * 100 : 0}%`,
            }}
          />
        </div>

        {/* Next step CTA */}
        {setup.next_step && (
          <div className="card p-3 mb-4 border-l-2 border-l-accent-amber/50">
            <div className="flex items-start gap-3">
              <div className="flex-1">
                <div className="text-[10px] font-mono text-text-tertiary uppercase tracking-wider mb-1">
                  Next step
                </div>
                <div className="text-sm text-text-primary font-medium">
                  {setup.next_step.label}
                </div>
                <div className="text-xs text-text-secondary mt-0.5">
                  {setup.next_step.recommendation}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Template suggestions (when .gitwire.yml is missing) */}
        {needsTemplates && <TemplateSuggestions />}

        {/* Checklist grid */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {setup.checks.map((check) => {
            const sm = STATUS_META[check.status] ?? STATUS_META.warn;
            return (
              <div
                key={check.id}
                className="flex items-center gap-3 px-3 py-2 rounded bg-surface-2/50"
              >
                <div
                  className={`flex items-center justify-center w-6 h-6 rounded-full ${sm.bg} ${sm.color} text-xs font-bold shrink-0`}
                >
                  {sm.icon}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-medium text-text-primary truncate">
                      {check.label}
                    </span>
                    {!check.blocking && check.status !== "pass" && (
                      <span className="text-[9px] font-mono text-text-tertiary uppercase shrink-0">
                        optional
                      </span>
                    )}
                  </div>
                  <div className="text-[11px] text-text-tertiary truncate">
                    {check.detail}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ── Template Suggestions sub-component ──────────────────────────────────────

function TemplateSuggestions() {
  const { data: templates, isLoading } = useApi<TemplateMeta>(
    API.setupTemplates()
  );
  const [expanded, setExpanded] = useState(false);

  if (isLoading || !templates || templates.length === 0) return null;

  const visible = expanded ? templates : templates.slice(0, 3);

  return (
    <div className="mb-4">
      <div className="text-[10px] font-mono text-text-tertiary uppercase tracking-wider mb-2">
        Start from a template
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
        {visible.map((tpl) => (
          <div
            key={tpl.id}
            className="card p-3 hover:border-border-bright transition-colors"
          >
            <div className="flex items-center justify-between mb-1">
              <span className="text-xs font-medium text-text-primary">
                {tpl.name}
              </span>
              <span
                className={`text-[9px] font-mono px-1.5 py-0.5 rounded border ${
                  SAFETY_META[tpl.safety]?.variant === "green"
                    ? "bg-accent-green/10 text-accent-green border-accent-green/25"
                    : SAFETY_META[tpl.safety]?.variant === "blue"
                    ? "bg-accent-blue/10 text-accent-blue border-accent-blue/25"
                    : "bg-accent-amber/10 text-accent-amber border-accent-amber/25"
                }`}
              >
                {tpl.safety_label || SAFETY_META[tpl.safety]?.label || "Review required"}
              </span>
            </div>
            <p className="text-[11px] text-text-tertiary line-clamp-2 mb-2">
              {tpl.description}
            </p>
            <div className="flex items-center justify-between">
              <span
                className={`text-[9px] font-mono uppercase px-1.5 py-0.5 rounded border ${
                  DIFFICULTY_META[tpl.difficulty] ?? DIFFICULTY_META.beginner
                }`}
              >
                {tpl.difficulty}
              </span>
              <Link
                href={`/config/playground?template=${tpl.id}`}
                className="text-[10px] font-mono text-accent-green hover:underline"
              >
                use →
              </Link>
            </div>
          </div>
        ))}
      </div>
      {!expanded && templates.length > 3 && (
        <button
          onClick={() => setExpanded(true)}
          className="mt-2 text-[10px] font-mono text-text-tertiary hover:text-text-secondary"
        >
          show all {templates.length} templates →
        </button>
      )}
    </div>
  );
}
