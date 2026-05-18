"use client";

import { useState } from "react";
import useSWR from "swr";
import {
  fetcher, API,
  updateCollaborator, removeCollaborator,
  updateBranchRule, syncMembers,
  triggerStaleScan, triggerBranchCleanup, updateSettings,
} from "@/lib/api";
import {
  PageHeader, StatCard, Badge, Skeleton, EmptyState, FilterPill,
} from "@/components/ui";
import { formatDistanceToNow } from "date-fns";
import clsx from "clsx";

// ── Permission helpers ────────────────────────────────────────────────────────
const PERMISSION_ORDER = ["pull", "triage", "push", "maintain", "admin"];
const PERMISSION_COLOR: Record<string, string> = {
  admin: "red",
  maintain: "amber",
  push: "blue",
  triage: "default",
  pull: "default",
};

function PermBadge({ permission }: { permission: string }) {
  return <Badge variant={PERMISSION_COLOR[permission] ?? "default"}>{permission}</Badge>;
}

function Avatar({ login, avatarUrl, size = 7 }: { login: string; avatarUrl?: string; size?: number }) {
  if (avatarUrl) {
    return (
      <img
        src={avatarUrl}
        alt={login}
        className={`w-${size} h-${size} rounded-full flex-shrink-0 border border-border`}
      />
    );
  }
  return (
    <div className={`w-${size} h-${size} rounded-full bg-surface-3 border border-border flex items-center justify-center text-[10px] font-mono text-text-secondary flex-shrink-0 uppercase`}>
      {login?.[0]}
    </div>
  );
}

// ── Tab bar ───────────────────────────────────────────────────────────────────
const TABS = ["Team members", "Permissions", "Branch rules", "Settings", "Audit log"];

function TabBar({ active, onChange }: { active: string; onChange: (t: string) => void }) {
  return (
    <div className="flex gap-1 px-6 py-3 border-b border-border overflow-x-auto">
      {TABS.map((t) => (
        <FilterPill key={t} active={active === t} onClick={() => onChange(t)}>
          {t}
        </FilterPill>
      ))}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// Tab: Team members
// ═══════════════════════════════════════════════════════════════════════════════
function MembersTab() {
  const [role, setRole] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [syncing, setSyncing] = useState(false);

  const qs = new URLSearchParams({ per_page: "30", page: String(page) });
  if (role) qs.set("role", role);
  if (search) qs.set("search", search);

  const { data, isLoading, mutate } = useSWR(API.members(qs.toString()), fetcher, {
    refreshInterval: 60000,
  });

  const members = data?.data ?? [];
  const meta = data?.meta ?? {};

  async function handleSync() {
    setSyncing(true);
    try { await syncMembers(); setTimeout(() => mutate(), 2000); }
    finally { setSyncing(false); }
  }

  return (
    <div className="px-6 py-4 space-y-4">
      <div className="flex items-center gap-3">
        <input
          type="search"
          placeholder="Search members…"
          value={search}
          onChange={(e) => { setSearch(e.target.value); setPage(1); }}
          className="bg-surface-2 border border-border rounded px-3 py-1.5 text-sm text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent-green/60 w-56 font-mono"
        />
        <FilterPill active={role === "owner"} onClick={() => setRole(role === "owner" ? "" : "owner")}>owners</FilterPill>
        <FilterPill active={role === "member"} onClick={() => setRole(role === "member" ? "" : "member")}>members</FilterPill>
        <button onClick={handleSync} disabled={syncing} className="btn ml-auto text-xs disabled:opacity-50">
          {syncing ? "↻ syncing…" : "↻ sync from GitHub"}
        </button>
      </div>

      <div className="grid grid-cols-2 gap-3">
        {isLoading && [...Array(6)].map((_, i) => <Skeleton key={i} className="h-20" />)}
        {!isLoading && !members.length && (
          <div className="col-span-2">
            <EmptyState icon="◎" title="No members found" body="Try syncing from GitHub first." />
          </div>
        )}
        {members.map((m: Record<string, unknown>) => (
          <div key={String(m.github_login)} className="card p-3 flex items-center gap-3 hover:bg-surface-2 transition-colors">
            <Avatar login={String(m.github_login)} avatarUrl={m.avatar_url as string} size={10} />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="font-mono text-sm font-medium text-text-primary">{String(m.github_login)}</span>
                {Boolean(m.site_admin) && <Badge variant="purple">site admin</Badge>}
              </div>
              <div className="flex items-center gap-2 mt-1">
                <Badge variant={m.role === "owner" ? "amber" : "default"}>{String(m.role)}</Badge>
                <span className="text-xs text-text-tertiary">{String(m.repo_count ?? 0)} repos</span>
                <span className="text-xs text-text-tertiary">· {String(m.org)}</span>
              </div>
            </div>
          </div>
        ))}
      </div>

      {meta.total_pages > 1 && (
        <div className="flex items-center justify-between">
          <span className="text-xs text-text-tertiary font-mono">{String(meta.total)} members</span>
          <div className="flex gap-2">
            <button className="btn text-xs" disabled={page <= 1} onClick={() => setPage(p => p - 1)}>← prev</button>
            <button className="btn text-xs" disabled={page >= meta.total_pages} onClick={() => setPage(p => p + 1)}>next →</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// Tab: Permissions (repo collaborators)
// ═══════════════════════════════════════════════════════════════════════════════
function PermissionsTab() {
  const [permission, setPermission] = useState("");
  const [repoFilter, setRepoFilter] = useState("");
  const [page, setPage] = useState(1);
  const [editing, setEditing] = useState<Record<string, string> | null>(null);
  const [saving, setSaving] = useState(false);
  const [newPerm, setNewPerm] = useState("");

  const qs = new URLSearchParams({ per_page: "25", page: String(page) });
  if (permission) qs.set("permission", permission);
  if (repoFilter) qs.set("repo", repoFilter);

  const { data, isLoading, mutate } = useSWR(API.collabs(qs.toString()), fetcher, {
    refreshInterval: 30000,
  });

  const collabs = data?.data ?? [];
  const meta = data?.meta ?? {};

  async function handleSave() {
    if (!editing || !newPerm) return;
    setSaving(true);
    try {
      await updateCollaborator(editing.owner, editing.repo, editing.login, newPerm);
      mutate();
      setEditing(null);
    } finally { setSaving(false); }
  }

  async function handleRemove(owner: string, repo: string, login: string) {
    if (!confirm(`Remove ${login} from ${owner}/${repo}?`)) return;
    await removeCollaborator(owner, repo, login);
    mutate();
  }

  return (
    <div className="px-6 py-4 space-y-4">
      <div className="flex items-center gap-2 flex-wrap">
        <input
          type="text"
          placeholder="Filter by repo…"
          value={repoFilter}
          onChange={(e) => { setRepoFilter(e.target.value); setPage(1); }}
          className="bg-surface-2 border border-border rounded px-3 py-1.5 text-sm text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent-green/60 w-48 font-mono"
        />
        <span className="text-xs text-text-tertiary font-mono">permission:</span>
        {PERMISSION_ORDER.map((p) => (
          <FilterPill key={p} active={permission === p} onClick={() => { setPermission(permission === p ? "" : p); setPage(1); }}>
            {p}
          </FilterPill>
        ))}
      </div>

      {/* Edit modal */}
      {editing && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={() => setEditing(null)}>
          <div className="card p-5 w-80" onClick={(e) => e.stopPropagation()}>
            <div className="font-bold text-text-primary mb-1">Edit permission</div>
            <div className="text-sm text-text-secondary mb-4 font-mono">
              {editing.login} on {editing.owner}/{editing.repo}
            </div>
            <div className="flex flex-col gap-2 mb-4">
              {PERMISSION_ORDER.map((p) => (
                <label key={p} className={clsx(
                  "flex items-center gap-3 p-2.5 rounded border cursor-pointer transition-all",
                  newPerm === p ? "border-accent-green/40 bg-accent-green/10" : "border-border hover:border-border-bright"
                )}>
                  <input type="radio" name="perm" value={p} checked={newPerm === p} onChange={() => setNewPerm(p)} className="hidden" />
                  <span className="flex-1 font-mono text-sm text-text-primary">{p}</span>
                  <PermBadge permission={p} />
                </label>
              ))}
            </div>
            <div className="flex gap-2 justify-end">
              <button className="btn text-xs" onClick={() => setEditing(null)}>cancel</button>
              <button className="btn-primary text-xs" disabled={!newPerm || saving} onClick={handleSave}>
                {saving ? "saving…" : "save"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Table */}
      <div className="card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-[10px] font-mono text-text-tertiary uppercase tracking-wider">
                <th className="text-left px-4 py-2.5 font-medium">Collaborator</th>
                <th className="text-left px-4 py-2.5 font-medium">Repository</th>
                <th className="text-left px-4 py-2.5 font-medium">Permission</th>
                <th className="text-left px-4 py-2.5 font-medium">Updated</th>
                <th className="px-4 py-2.5" />
              </tr>
            </thead>
            <tbody>
              {isLoading && [...Array(6)].map((_, i) => (
                <tr key={i} className="border-b border-border">
                  {[...Array(5)].map((_, j) => <td key={j} className="px-4 py-3"><Skeleton className="h-4" /></td>)}
                </tr>
              ))}
              {!isLoading && !collabs.length && (
                <tr><td colSpan={5}><EmptyState icon="◎" title="No collaborators found" /></td></tr>
              )}
              {collabs.map((c: Record<string, unknown>, idx: number) => (
                <tr key={`${String(c.repo_full_name)}-${String(c.github_login)}`}
                  className={clsx("hover:bg-surface-2/40 transition-colors group", idx < collabs.length - 1 && "border-b border-border")}>
                  <td className="px-4 py-2.5">
                    <div className="flex items-center gap-2">
                      <Avatar login={String(c.github_login)} avatarUrl={c.avatar_url as string} size={6} />
                      <span className="font-mono text-sm text-text-primary">{String(c.github_login)}</span>
                    </div>
                  </td>
                  <td className="px-4 py-2.5 font-mono text-xs text-text-secondary">{String(c.repo_full_name)}</td>
                  <td className="px-4 py-2.5"><PermBadge permission={String(c.permission)} /></td>
                  <td className="px-4 py-2.5 font-mono text-xs text-text-tertiary">
                    {c.updated_at ? formatDistanceToNow(new Date(String(c.updated_at)), { addSuffix: true }) : "—"}
                  </td>
                  <td className="px-4 py-2.5">
                    <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity justify-end">
                      <button
                        className="btn text-xs"
                        onClick={() => { setEditing({ login: String(c.github_login), owner: String(c.repo_owner), repo: String(c.repo_name), current: String(c.permission) }); setNewPerm(String(c.permission)); }}
                      >
                        edit
                      </button>
                      <button
                        className="btn text-xs text-accent-red border-accent-red/30 hover:bg-accent-red/10"
                        onClick={() => handleRemove(String(c.repo_owner), String(c.repo_name), String(c.github_login))}
                      >
                        remove
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {meta.total_pages > 1 && (
          <div className="flex items-center justify-between px-4 py-3 border-t border-border">
            <span className="text-xs text-text-tertiary font-mono">{String(meta.total)} collaborators</span>
            <div className="flex gap-2">
              <button className="btn text-xs" disabled={page <= 1} onClick={() => setPage(p => p - 1)}>← prev</button>
              <button className="btn text-xs" disabled={page >= meta.total_pages} onClick={() => setPage(p => p + 1)}>next →</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// Tab: Branch rules
// ═══════════════════════════════════════════════════════════════════════════════
function BranchRulesTab() {
  const [repoFilter, setRepoFilter] = useState("");
  const [page, setPage] = useState(1);
  const [editing, setEditing] = useState<Record<string, unknown> | null>(null);
  const [saving, setSaving] = useState(false);

  const qs = new URLSearchParams({ per_page: "25", page: String(page) });
  if (repoFilter) qs.set("repo", repoFilter);

  const { data, isLoading, mutate } = useSWR(API.branchRules(qs.toString()), fetcher, {
    refreshInterval: 60000,
  });

  const rules = data?.data ?? [];
  const meta = data?.meta ?? {};

  async function handleSave() {
    if (!editing) return;
    setSaving(true);
    try {
      await updateBranchRule(String(editing.repo_owner), String(editing.repo_name), String(editing.pattern), editing);
      mutate();
      setEditing(null);
    } finally { setSaving(false); }
  }

  function Toggle({ label, value, field }: { label: string; value: boolean; field: string }) {
    return (
      <label className="flex items-center justify-between py-1.5 cursor-pointer group">
        <span className="text-sm text-text-secondary group-hover:text-text-primary transition-colors">{label}</span>
        <button
          onClick={() => setEditing(e => e ? { ...e, [field]: !e[field] } : e)}
          className={clsx(
            "w-9 h-5 rounded-full transition-all relative flex-shrink-0",
            value ? "bg-accent-green/80" : "bg-surface-4"
          )}
        >
          <span className={clsx(
            "absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all",
            value ? "left-4" : "left-0.5"
          )} />
        </button>
      </label>
    );
  }

  return (
    <div className="px-6 py-4 space-y-4">
      <div className="flex items-center gap-3">
        <input
          type="text"
          placeholder="Filter by repo…"
          value={repoFilter}
          onChange={(e) => { setRepoFilter(e.target.value); setPage(1); }}
          className="bg-surface-2 border border-border rounded px-3 py-1.5 text-sm text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent-green/60 w-56 font-mono"
        />
      </div>

      {/* Edit modal */}
      {editing && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={() => setEditing(null)}>
          <div className="card p-5 w-96 max-h-[80vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
            <div className="font-bold text-text-primary mb-0.5">Branch rule</div>
            <div className="font-mono text-sm text-accent-green mb-4">
              {String(editing.repo_full_name)} · <span className="text-text-secondary">{String(editing.pattern)}</span>
            </div>

            <div className="space-y-0.5 divide-y divide-border">
              <div className="py-2">
                <label className="text-sm text-text-secondary block mb-1.5">Required approving reviews</label>
                <div className="flex items-center gap-2">
                  {[0,1,2,3,4].map(n => (
                    <button key={n} onClick={() => setEditing(e => e ? { ...e, required_reviews: n } : e)}
                      className={clsx("w-8 h-8 rounded font-mono text-sm border transition-all",
                        Number(editing.required_reviews) === n
                          ? "bg-accent-green/15 border-accent-green/40 text-accent-green"
                          : "border-border text-text-secondary hover:border-border-bright"
                      )}>
                      {n}
                    </button>
                  ))}
                </div>
              </div>
              <Toggle label="Dismiss stale reviews on new push" value={Boolean(editing.dismiss_stale_reviews)} field="dismiss_stale_reviews" />
              <Toggle label="Require code owner review" value={Boolean(editing.require_code_owner_reviews)} field="require_code_owner_reviews" />
              <Toggle label="Require status checks to pass" value={Boolean(editing.require_status_checks)} field="require_status_checks" />
              <Toggle label="Require branch up to date" value={Boolean(editing.require_up_to_date_branch)} field="require_up_to_date_branch" />
              <Toggle label="Include administrators" value={Boolean(editing.enforce_admins)} field="enforce_admins" />
              <Toggle label="Allow force pushes" value={Boolean(editing.allow_force_pushes)} field="allow_force_pushes" />
              <Toggle label="Allow branch deletions" value={Boolean(editing.allow_deletions)} field="allow_deletions" />
            </div>

            <div className="flex gap-2 justify-end mt-4 pt-3 border-t border-border">
              <button className="btn text-xs" onClick={() => setEditing(null)}>cancel</button>
              <button className="btn-primary text-xs" disabled={saving} onClick={handleSave}>
                {saving ? "saving…" : "save to GitHub"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Rules table */}
      <div className="card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-[10px] font-mono text-text-tertiary uppercase tracking-wider">
                <th className="text-left px-4 py-2.5 font-medium">Repository · Branch</th>
                <th className="text-center px-3 py-2.5 font-medium">Reviews</th>
                <th className="text-center px-3 py-2.5 font-medium">Status checks</th>
                <th className="text-center px-3 py-2.5 font-medium">Admins</th>
                <th className="text-center px-3 py-2.5 font-medium">Force push</th>
                <th className="text-center px-3 py-2.5 font-medium">Deletions</th>
                <th className="px-4 py-2.5" />
              </tr>
            </thead>
            <tbody>
              {isLoading && [...Array(5)].map((_, i) => (
                <tr key={i} className="border-b border-border">
                  {[...Array(7)].map((_, j) => <td key={j} className="px-4 py-3"><Skeleton className="h-4" /></td>)}
                </tr>
              ))}
              {!isLoading && !rules.length && (
                <tr><td colSpan={7}><EmptyState icon="⌥" title="No branch rules found" body="Protected branches will appear here after sync." /></td></tr>
              )}
              {rules.map((rule: Record<string, unknown>, idx: number) => {
                const Check = ({ value }: { value: boolean }) => (
                  <span className={value ? "text-accent-green" : "text-text-tertiary"}>
                    {value ? "✓" : "—"}
                  </span>
                );
                return (
                  <tr key={String(rule.id)} className={clsx("hover:bg-surface-2/40 transition-colors group", idx < rules.length - 1 && "border-b border-border")}>
                    <td className="px-4 py-2.5">
                      <div className="font-mono text-xs text-text-secondary">{String(rule.repo_full_name)}</div>
                      <div className="font-mono text-sm font-medium text-accent-green">{String(rule.pattern)}</div>
                    </td>
                    <td className="px-3 py-2.5 text-center font-mono text-sm">
                      {Number(rule.required_reviews) > 0
                        ? <span className="text-accent-blue">{String(rule.required_reviews)}</span>
                        : <span className="text-text-tertiary">—</span>
                      }
                    </td>
                    <td className="px-3 py-2.5 text-center"><Check value={Boolean(rule.require_status_checks)} /></td>
                    <td className="px-3 py-2.5 text-center"><Check value={Boolean(rule.enforce_admins)} /></td>
                    <td className="px-3 py-2.5 text-center">
                      <span className={rule.allow_force_pushes ? "text-accent-amber" : "text-text-tertiary"}>
                        {rule.allow_force_pushes ? "allowed" : "—"}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 text-center">
                      <span className={rule.allow_deletions ? "text-accent-red" : "text-text-tertiary"}>
                        {rule.allow_deletions ? "allowed" : "—"}
                      </span>
                    </td>
                    <td className="px-4 py-2.5">
                      <button
                        className="btn text-xs opacity-0 group-hover:opacity-100 transition-opacity"
                        onClick={() => setEditing(rule)}
                      >
                        edit
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {meta.total_pages > 1 && (
          <div className="flex items-center justify-between px-4 py-3 border-t border-border">
            <span className="text-xs text-text-tertiary font-mono">{String(meta.total)} rules</span>
            <div className="flex gap-2">
              <button className="btn text-xs" disabled={page <= 1} onClick={() => setPage(p => p - 1)}>← prev</button>
              <button className="btn text-xs" disabled={page >= meta.total_pages} onClick={() => setPage(p => p + 1)}>next →</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// Tab: Settings (existing stale management, relocated into tab)
// ═══════════════════════════════════════════════════════════════════════════════
const REPOS = [
  { owner: "xjeddah", name: "MyShell" },
  { owner: "xjeddah", name: "QwenPaw" },
];

function SettingsTab() {
  const [selectedRepo, setSelectedRepo] = useState(REPOS[0]);
  const [triggering, setTriggering] = useState<Record<string, boolean>>({});
  const [editing, setEditing] = useState(false);
  const [settingsForm, setSettingsForm] = useState<Record<string, unknown> | null>(null);

  const { data: settings, isLoading: sl, mutate: mutateSettings } = useSWR(
    API.maintainerSettings(selectedRepo.owner, selectedRepo.name),
    fetcher,
    { refreshInterval: 30000, onSuccess: (d) => { if (!editing) setSettingsForm(d); } }
  );

  const { data: stats } = useSWR(
    API.maintainerStats(selectedRepo.owner, selectedRepo.name),
    fetcher,
    { refreshInterval: 30000 }
  );

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
    <div className="px-6 py-4 space-y-4">
      {/* Repo selector + stats */}
      <div className="flex items-center gap-2 flex-wrap">
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
        <div className="ml-auto flex gap-3">
          <span className="text-xs text-text-tertiary font-mono">{String(stats?.last_7_days ?? 0)} actions (7d)</span>
          <span className="text-xs text-text-tertiary font-mono">{String(stats?.applied ?? 0)} applied</span>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Settings */}
        <div className="card p-4">
          <div className="flex items-center justify-between mb-3">
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

          {sl ? (
            <div className="space-y-3">{[...Array(4)].map((_, i) => <Skeleton key={i} className="h-8" />)}</div>
          ) : editing && settingsForm ? (
            <div className="space-y-3">
              <label className="block">
                <span className="text-xs text-text-tertiary font-mono">Stale issue days</span>
                <input type="number" value={String(settingsForm.stale_issue_days ?? 60)}
                  onChange={(e) => setSettingsForm({ ...settingsForm, stale_issue_days: Number(e.target.value) })}
                  className="mt-1 w-full bg-surface-2 border border-border rounded px-3 py-1.5 text-sm text-text-primary font-mono focus:outline-none focus:border-accent-green/60" />
              </label>
              <label className="block">
                <span className="text-xs text-text-tertiary font-mono">Stale PR days</span>
                <input type="number" value={String(settingsForm.stale_pr_days ?? 30)}
                  onChange={(e) => setSettingsForm({ ...settingsForm, stale_pr_days: Number(e.target.value) })}
                  className="mt-1 w-full bg-surface-2 border border-border rounded px-3 py-1.5 text-sm text-text-primary font-mono focus:outline-none focus:border-accent-green/60" />
              </label>
              <label className="block">
                <span className="text-xs text-text-tertiary font-mono">Warn days before close</span>
                <input type="number" value={String(settingsForm.stale_warn_days ?? 7)}
                  onChange={(e) => setSettingsForm({ ...settingsForm, stale_warn_days: Number(e.target.value) })}
                  className="mt-1 w-full bg-surface-2 border border-border rounded px-3 py-1.5 text-sm text-text-primary font-mono focus:outline-none focus:border-accent-green/60" />
              </label>
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={Boolean(settingsForm.cleanup_branches ?? true)}
                  onChange={(e) => setSettingsForm({ ...settingsForm, cleanup_branches: e.target.checked })} className="accent-accent-green" />
                <span className="text-xs text-text-secondary font-mono">Auto branch cleanup</span>
              </label>
            </div>
          ) : (
            <div className="space-y-2">
              <div className="flex justify-between text-xs"><span className="text-text-tertiary font-mono">Stale issues</span><span className="text-text-primary font-mono">{String(settings?.stale_issue_days ?? 60)}d</span></div>
              <div className="flex justify-between text-xs"><span className="text-text-tertiary font-mono">Stale PRs</span><span className="text-text-primary font-mono">{String(settings?.stale_pr_days ?? 30)}d</span></div>
              <div className="flex justify-between text-xs"><span className="text-text-tertiary font-mono">Warn before close</span><span className="text-text-primary font-mono">{String(settings?.stale_warn_days ?? 7)}d</span></div>
              <div className="flex justify-between text-xs"><span className="text-text-tertiary font-mono">Branch cleanup</span><Badge variant={settings?.cleanup_branches ? "green" : "default"}>{settings?.cleanup_branches ? "on" : "off"}</Badge></div>
              <div className="flex justify-between text-xs"><span className="text-text-tertiary font-mono">Status</span><Badge variant={settings?.enabled ? "green" : "red"}>{settings?.enabled ? "active" : "disabled"}</Badge></div>
            </div>
          )}
        </div>

        {/* Triggers */}
        <div className="card p-4 lg:col-span-2">
          <div className="text-[10px] font-mono text-text-tertiary uppercase tracking-wider mb-3">Manual triggers</div>
          <div className="grid grid-cols-2 gap-3">
            <button onClick={() => handleTrigger("stale-scan")} disabled={triggering["stale-scan"]} className="btn w-full text-xs justify-center disabled:opacity-50 py-2">
              {triggering["stale-scan"] ? "↻ scanning…" : "⏰ Trigger stale scan"}
            </button>
            <button onClick={() => handleTrigger("branch-cleanup")} disabled={triggering["branch-cleanup"]} className="btn w-full text-xs justify-center disabled:opacity-50 py-2">
              {triggering["branch-cleanup"] ? "↻ cleaning…" : "🧹 Trigger branch cleanup"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// Tab: Audit log
// ═══════════════════════════════════════════════════════════════════════════════
function AuditTab() {
  const [page, setPage] = useState(1);
  const [actor, setActor] = useState("");

  const qs = new URLSearchParams({ per_page: "30", page: String(page) });
  if (actor) qs.set("actor", actor);

  const { data, isLoading } = useSWR(API.auditLog(qs.toString()), fetcher, {
    refreshInterval: 15000,
  });

  const entries = data?.data ?? [];
  const meta = data?.meta ?? {};

  const ACTION_COLOR: Record<string, string> = {
    "collaborator.add": "green",
    "collaborator.update": "blue",
    "collaborator.remove": "red",
    "branch_rule.update": "amber",
  };

  return (
    <div className="px-6 py-4 space-y-4">
      <div className="flex items-center gap-3">
        <input
          type="text"
          placeholder="Filter by actor…"
          value={actor}
          onChange={(e) => { setActor(e.target.value); setPage(1); }}
          className="bg-surface-2 border border-border rounded px-3 py-1.5 text-sm text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent-green/60 w-56 font-mono"
        />
        <span className="text-xs text-text-tertiary font-mono ml-auto">
          {meta.total != null ? `${meta.total} entries` : ""}
        </span>
      </div>

      <div className="card overflow-hidden">
        {isLoading && (
          <div className="p-4 space-y-2">
            {[...Array(8)].map((_, i) => <Skeleton key={i} className="h-10" />)}
          </div>
        )}
        {!isLoading && !entries.length && (
          <EmptyState icon="◎" title="No audit entries yet" body="Changes made through the maintainer API are recorded here." />
        )}
        {entries.map((e: Record<string, unknown>, idx: number) => (
          <div key={String(e.id)} className={clsx(
            "flex items-start gap-3 px-4 py-2.5 hover:bg-surface-2/40 transition-colors",
            idx < entries.length - 1 && "border-b border-border"
          )}>
            <Avatar login={String(e.actor)} size={7} />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-mono text-sm font-medium text-text-primary">{String(e.actor)}</span>
                <Badge variant={ACTION_COLOR[String(e.action)] ?? "default"}>{String(e.action)}</Badge>
                <span className="font-mono text-xs text-text-secondary">{String(e.target_id)}</span>
                {!Boolean(e.success) && <Badge variant="red">failed</Badge>}
              </div>
              {Boolean(e.payload) && (
                <div className="mt-0.5 font-mono text-[10px] text-text-tertiary line-clamp-1">
                  {JSON.stringify(e.payload)}
                </div>
              )}
            </div>
            <span className="text-[10px] font-mono text-text-tertiary whitespace-nowrap pt-0.5">
              {e.created_at ? formatDistanceToNow(new Date(String(e.created_at)), { addSuffix: true }) : ""}
            </span>
          </div>
        ))}
        {meta.total_pages > 1 && (
          <div className="flex items-center justify-between px-4 py-3 border-t border-border">
            <span className="text-xs text-text-tertiary font-mono">Page {meta.page}/{meta.total_pages}</span>
            <div className="flex gap-2">
              <button className="btn text-xs" disabled={page <= 1} onClick={() => setPage(p => p - 1)}>← prev</button>
              <button className="btn text-xs" disabled={page >= meta.total_pages} onClick={() => setPage(p => p + 1)}>next →</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// Main page
// ═══════════════════════════════════════════════════════════════════════════════
export default function MaintainerPage() {
  const [tab, setTab] = useState("Team members");

  return (
    <div className="animate-fade-in">
      <PageHeader
        title="Maintainer"
        subtitle="Team access, permissions, branch protection & stale management"
      />
      <TabBar active={tab} onChange={setTab} />

      {tab === "Team members" && <MembersTab />}
      {tab === "Permissions"  && <PermissionsTab />}
      {tab === "Branch rules" && <BranchRulesTab />}
      {tab === "Settings"     && <SettingsTab />}
      {tab === "Audit log"    && <AuditTab />}
    </div>
  );
}
