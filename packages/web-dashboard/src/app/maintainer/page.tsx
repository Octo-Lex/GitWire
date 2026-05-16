"use client";

import { ApiItem } from "@/lib/types";

import { useState } from "react";
import useSWR from "swr";

import { fetcher, API, triggerStaleScan, triggerBranchCleanup, updateSettings } from "@/lib/api";
import {
  PageHeader, StatCard, Badge, Skeleton, EmptyState,
} from "@/components/ui";
import { formatDistanceToNow } from "date-fns";
import clsx from "clsx";

const REPOS = [
  { owner: "xjeddah", name: "MyShell" },
  { owner: "xjeddah", name: "QwenPaw" },
];

const ACTION_ICONS: Record<string, string> = {
  stale_warn: "⏰",
  stale_close: "✕",
  branch_cleanup: "🧹",
  comment_command: "💬",
  fix_issue: "⚡",
};

export default function MaintainerPage() {
  const [selectedRepo, setSelectedRepo] = useState(REPOS[0]);
  const [triggering, setTriggering] = useState<Record<string, boolean>>({});
  const [editing, setEditing] = useState(false);
  const [settingsForm, setSettingsForm] = useState<ApiItem | null>(null);

  const { data: settings, isLoading: sl, mutate: mutateSettings } = useSWR(
    API.maintainerSettings(selectedRepo.owner, selectedRepo.name),
    fetcher,
    { refreshInterval: 30000, onSuccess: (d) => { if (!editing) setSettingsForm(d); } }
  );

  const { data: actions, isLoading: al } = useSWR(
    API.maintainerActions(selectedRepo.owner, selectedRepo.name, "per_page=20"),
    fetcher,
    { refreshInterval: 15000 }
  );

  const { data: stats, isLoading: stl } = useSWR(
    API.maintainerStats(selectedRepo.owner, selectedRepo.name),
    fetcher,
    { refreshInterval: 30000 }
  );

  const actionList = actions?.data ?? actions?.actions ?? actions ?? [];

  async function handleTrigger(action: string) {
    setTriggering((t) => ({ ...t, [action]: true }));
    try {
      if (action === "stale-scan") await triggerStaleScan(selectedRepo.owner, selectedRepo.name);
      if (action === "branch-cleanup") await triggerBranchCleanup(selectedRepo.owner, selectedRepo.name);
    } finally {
      setTriggering((t) => ({ ...t, [action]: false }));
    }
  }

  async function handleSaveSettings() {
    if (!settingsForm) return;
    await updateSettings(selectedRepo.owner, selectedRepo.name, settingsForm);
    setEditing(false);
    mutateSettings();
  }

  return (
    <div className="animate-fade-in">
      <PageHeader
        title="Maintainer"
        subtitle="Stale management, branch cleanup & repo automation"
        actions={
          <div className="flex gap-2">
            {REPOS.map((r) => (
              <button
                key={`${r.owner}/${r.name}`}
                onClick={() => { setSelectedRepo(r); setEditing(false); }}
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

      {/* Stats */}
      <div className="grid grid-cols-4 gap-3 px-6 py-4 border-b border-border">
        <StatCard label="Actions (7d)" value={stats?.last_7_days ?? stats?.actions_this_week ?? 0} loading={stl} accent="blue" />
        <StatCard label="Applied" value={stats?.applied ?? 0} loading={stl} accent="green" />
        <StatCard label="Skipped" value={stats?.skipped ?? 0} loading={stl} />
        <StatCard label="Failed" value={stats?.failed ?? 0} loading={stl} accent="red" />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-0">

        {/* Left: Settings */}
        <div className="border-b lg:border-b-0 lg:border-r border-border">
          <div className="px-6 py-4 border-b border-border">
            <div className="flex items-center justify-between">
              <div className="text-[10px] font-mono text-text-tertiary uppercase tracking-wider">Settings</div>
              {!editing ? (
                <button className="btn text-xs" onClick={() => { setSettingsForm(settings); setEditing(true); }}>edit</button>
              ) : (
                <div className="flex gap-2">
                  <button className="btn text-xs" onClick={() => setEditing(false)}>cancel</button>
                  <button className="btn-primary text-xs" onClick={handleSaveSettings}>save</button>
                </div>
              )}
            </div>
          </div>

          <div className="p-6">
            {sl ? (
              <div className="space-y-4">{[...Array(4)].map((_, i) => <Skeleton key={i} className="h-10" />)}</div>
            ) : editing && settingsForm ? (
              <div className="space-y-4">
                <label className="block">
                  <span className="text-xs text-text-tertiary font-mono">Stale issue days</span>
                  <input
                    type="number"
                    value={String(settingsForm.stale_issue_days ?? 60)}
                    onChange={(e) => setSettingsForm({ ...settingsForm, stale_issue_days: Number(e.target.value) })}
                    className="mt-1 w-full bg-surface-2 border border-border rounded px-3 py-1.5 text-sm text-text-primary font-mono focus:outline-none focus:border-accent-green/60"
                  />
                </label>
                <label className="block">
                  <span className="text-xs text-text-tertiary font-mono">Stale PR days</span>
                  <input
                    type="number"
                    value={String(settingsForm.stale_pr_days ?? 30)}
                    onChange={(e) => setSettingsForm({ ...settingsForm, stale_pr_days: Number(e.target.value) })}
                    className="mt-1 w-full bg-surface-2 border border-border rounded px-3 py-1.5 text-sm text-text-primary font-mono focus:outline-none focus:border-accent-green/60"
                  />
                </label>
                <label className="block">
                  <span className="text-xs text-text-tertiary font-mono">Warn days before close</span>
                  <input
                    type="number"
                    value={String(settingsForm.stale_warn_days ?? 7)}
                    onChange={(e) => setSettingsForm({ ...settingsForm, stale_warn_days: Number(e.target.value) })}
                    className="mt-1 w-full bg-surface-2 border border-border rounded px-3 py-1.5 text-sm text-text-primary font-mono focus:outline-none focus:border-accent-green/60"
                  />
                </label>
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={Boolean(settingsForm.cleanup_branches ?? true)}
                    onChange={(e) => setSettingsForm({ ...settingsForm, cleanup_branches: e.target.checked })}
                    className="accent-accent-green"
                  />
                  <span className="text-xs text-text-secondary font-mono">Auto branch cleanup</span>
                </label>
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={Boolean(settingsForm.enabled ?? true)}
                    onChange={(e) => setSettingsForm({ ...settingsForm, enabled: e.target.checked })}
                    className="accent-accent-green"
                  />
                  <span className="text-xs text-text-secondary font-mono">Maintainer enabled</span>
                </label>
              </div>
            ) : (
              <div className="space-y-3">
                <div className="flex justify-between text-xs">
                  <span className="text-text-tertiary font-mono">Stale issues</span>
                  <span className="text-text-primary font-mono">{String(settings?.stale_issue_days ?? 60)}d</span>
                </div>
                <div className="flex justify-between text-xs">
                  <span className="text-text-tertiary font-mono">Stale PRs</span>
                  <span className="text-text-primary font-mono">{String(settings?.stale_pr_days ?? 30)}d</span>
                </div>
                <div className="flex justify-between text-xs">
                  <span className="text-text-tertiary font-mono">Warn before close</span>
                  <span className="text-text-primary font-mono">{String(settings?.stale_warn_days ?? 7)}d</span>
                </div>
                <div className="flex justify-between text-xs">
                  <span className="text-text-tertiary font-mono">Branch cleanup</span>
                  <Badge variant={settings?.cleanup_branches ? "green" : "default"}>{settings?.cleanup_branches ? "on" : "off"}</Badge>
                </div>
                <div className="flex justify-between text-xs">
                  <span className="text-text-tertiary font-mono">Status</span>
                  <Badge variant={settings?.enabled ? "green" : "red"}>{settings?.enabled ? "active" : "disabled"}</Badge>
                </div>

                <div className="pt-4 space-y-2">
                  <button
                    onClick={() => handleTrigger("stale-scan")}
                    disabled={triggering["stale-scan"]}
                    className="btn w-full text-xs justify-center disabled:opacity-50"
                  >
                    {triggering["stale-scan"] ? "↻ scanning…" : "⏰ Trigger stale scan"}
                  </button>
                  <button
                    onClick={() => handleTrigger("branch-cleanup")}
                    disabled={triggering["branch-cleanup"]}
                    className="btn w-full text-xs justify-center disabled:opacity-50"
                  >
                    {triggering["branch-cleanup"] ? "↻ cleaning…" : "🧹 Trigger branch cleanup"}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Right: Action history */}
        <div className="lg:col-span-2">
          <div className="px-6 py-4 border-b border-border">
            <div className="text-[10px] font-mono text-text-tertiary uppercase tracking-wider">Action history</div>
          </div>

          <div className="divide-y divide-border">
            {al && [...Array(6)].map((_, i) => (
              <div key={i} className="px-6 py-3"><Skeleton className="h-10" /></div>
            ))}
            {!al && !actionList.length && (
              <EmptyState icon="⟳" title="No actions yet" body="Actions will appear as GitWire manages this repo." />
            )}
            {!al && actionList.map((action: ApiItem, idx: number) => (
              <div key={String(action.id ?? idx)} className="px-6 py-3 hover:bg-surface-2/50 transition-colors">
                <div className="flex items-center gap-2">
                  <span className="text-base">{ACTION_ICONS[String(action.action_type)] ?? "●"}</span>
                  <span className="font-mono text-xs text-text-primary font-medium">{String(action.action_type)}</span>
                  <Badge variant={String(action.status) === "applied" || String(action.status) === "success" ? "green" : String(action.status) === "failed" ? "red" : "default"}>
                    {String(action.status)}
                  </Badge>
                </div>
                {action.target_ref && (
                  <div className="mt-1 text-xs text-text-tertiary font-mono">{String(action.target_ref)}</div>
                )}
                {action.detail && (
                  <div className="mt-0.5 text-xs text-text-tertiary line-clamp-1">{String(action.detail)}</div>
                )}
                <div className="mt-1 text-[10px] text-text-tertiary font-mono">
                  {action.created_at ? formatDistanceToNow(new Date(String(action.created_at)), { addSuffix: true }) : ""}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
