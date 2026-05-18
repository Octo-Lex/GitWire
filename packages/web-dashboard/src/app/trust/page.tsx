"use client";

import useSWR from "swr";
import { fetcher, API, graduateTest, dismissTest, triggerReconciliation, updateRepoReconcileConfig, triggerDepScan, dismissVuln } from "../../lib/api";
import { useState } from "react";

const TABS = [
  { key: "flaky", label: "Flaky Tests" },
  { key: "reconciler", label: "Policy Reconciler" },
  { key: "dependencies", label: "Dependencies" },
] as const;
type TabKey = (typeof TABS)[number]["key"];

export default function TrustPage() {
  const [tab, setTab] = useState<TabKey>("flaky");
  return (
    <div className="p-6 space-y-6">
      <h1 className="text-2xl font-bold text-text-primary">Trust & Policy</h1>

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

      {tab === "flaky" && <FlakyTab />}
      {tab === "reconciler" && <ReconcilerTab />}
      {tab === "dependencies" && <DependenciesTab />}
    </div>
  );
}

// ── Flaky Tests Tab ─────────────────────────────────────────────────────────
function FlakyTab() {
  const { data: stats } = useSWR(API.flakyStats(), fetcher, { refreshInterval: 20000 });
  const { data, mutate } = useSWR(API.flakyTests("perPage=30"), fetcher, { refreshInterval: 20000 });
  const tests = data?.rows ?? data ?? [];
  const s = stats?.summary ?? {};

  return (
    <div className="space-y-6">
      {/* Stat cards */}
      <div className="grid grid-cols-5 gap-4">
        {[
          { label: "Tracked", value: s.total_tracked ?? 0 },
          { label: "Quarantined", value: s.quarantined ?? 0 },
          { label: "High Flakiness", value: s.high_flakiness ?? 0 },
          { label: "Graduated", value: s.graduated ?? 0 },
          { label: "Repos Affected", value: s.repos_affected ?? 0 },
        ].map((c) => (
          <div key={c.label} className="bg-surface-1 border border-border rounded-lg p-4 text-center">
            <p className="text-2xl font-bold text-text-primary">{c.value}</p>
            <p className="text-xs text-text-secondary">{c.label}</p>
          </div>
        ))}
      </div>

      {/* Test list */}
      <div>
        <h3 className="text-sm font-medium text-text-primary mb-3">Flaky Tests</h3>
        {tests.length === 0 ? (
          <p className="text-text-tertiary text-sm py-8 text-center">No flaky tests detected yet.</p>
        ) : (
          <div className="space-y-2">
            {tests.map((t: any) => (
              <div key={t.id} className="bg-surface-1 border border-border rounded-lg p-4 flex items-center justify-between">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-text-primary">{t.test_suite} &gt; {t.test_name}</span>
                    {t.quarantined && <span className="text-[10px] bg-yellow-500/10 text-yellow-400 px-1.5 py-0.5 rounded">Quarantined</span>}
                  </div>
                  <div className="flex items-center gap-4 mt-1">
                    <span className="text-xs text-text-secondary">{t.repo_full_name}</span>
                    {/* Flakiness bar */}
                    <div className="flex items-center gap-1.5">
                      <div className="w-20 h-1.5 bg-surface-2 rounded-full overflow-hidden">
                        <div
                          className="h-full rounded-full"
                          style={{ width: Math.min(t.failure_pct, 100) + "%", backgroundColor: t.failure_pct > 50 ? "#ef4444" : t.failure_pct > 20 ? "#f59e0b" : "#22c55e" }}
                        />
                      </div>
                      <span className="text-[10px] text-text-tertiary">{t.failure_pct}% fail</span>
                    </div>
                    <span className="text-[10px] text-text-tertiary">{t.run_count} runs</span>
                  </div>
                </div>
                <div className="flex gap-2">
                  <button onClick={() => { graduateTest(t.id).then(() => mutate()); }} className="text-xs px-2 py-1 rounded border border-green-400/30 text-green-400 hover:bg-green-400/10">
                    Graduate
                  </button>
                  <button onClick={() => { dismissTest(t.id).then(() => mutate()); }} className="text-xs px-2 py-1 rounded border border-border text-text-secondary hover:text-red-400">
                    Dismiss
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Policy Reconciler Tab ───────────────────────────────────────────────────
function ReconcilerTab() {
  const { data: runs } = useSWR(API.reconcilerRuns(), fetcher, { refreshInterval: 30000 });
  const { data: repos, mutate } = useSWR(API.reconcilerRepos("perPage=50"), fetcher, { refreshInterval: 30000 });
  const runList = (runs?.rows ?? runs ?? []) as any[];
  const repoList = (repos?.rows ?? repos ?? []) as any[];
  const lastRun = runList[0];

  return (
    <div className="space-y-6">
      {/* Last run summary */}
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-medium text-text-primary">Last Reconciliation</h3>
          {lastRun ? (
            <div className="flex gap-4 mt-2">
              <span className="text-xs text-text-secondary">Checked: {lastRun.repos_checked}</span>
              <span className="text-xs text-green-400">Synced: {lastRun.repos_synced}</span>
              <span className="text-xs text-yellow-400">Drifted: {lastRun.repos_drifted}</span>
              <span className="text-xs text-blue-400">Corrected: {lastRun.repos_corrected}</span>
              {lastRun.repos_failed > 0 && <span className="text-xs text-red-400">Failed: {lastRun.repos_failed}</span>}
            </div>
          ) : (
            <p className="text-xs text-text-tertiary mt-1">No reconciliation runs yet.</p>
          )}
        </div>
        <button
          onClick={() => triggerReconciliation()}
          className="text-xs px-4 py-2 bg-accent-green text-white rounded hover:opacity-90"
        >
          Run Now
        </button>
      </div>

      {/* Repo table */}
      <div>
        <h3 className="text-sm font-medium text-text-primary mb-3">Repo Compliance</h3>
        {repoList.length === 0 ? (
          <p className="text-text-tertiary text-sm py-8 text-center">No repos tracked yet. Run a reconciliation first.</p>
        ) : (
          <div className="space-y-1">
            {repoList.map((r: any) => (
              <div key={r.repo_full_name} className="flex items-center justify-between py-2 px-3 rounded hover:bg-surface-1">
                <div className="flex items-center gap-3">
                  <span className={`text-[10px] px-1.5 py-0.5 rounded ${r.in_sync ? "bg-green-500/10 text-green-400" : "bg-red-500/10 text-red-400"}`}>
                    {r.in_sync ? "In Sync" : "Drift"}
                  </span>
                  <span className="text-sm text-text-primary">{r.repo_full_name}</span>
                  <span className="text-[10px] text-text-tertiary">{r.default_branch}</span>
                </div>
                <div className="flex items-center gap-2">
                  {r.drift_fields?.length > 0 && (
                    <div className="flex gap-1">
                      {r.drift_fields.slice(0, 3).map((f: string) => (
                        <span key={f} className="text-[10px] bg-orange-500/10 text-orange-400 px-1.5 py-0.5 rounded">{f.split(".").pop()}</span>
                      ))}
                      {r.drift_fields.length > 3 && <span className="text-[10px] text-text-tertiary">+{r.drift_fields.length - 3}</span>}
                    </div>
                  )}
                  <button
                    onClick={() => { updateRepoReconcileConfig(r.owner, r.repo_name, { reconcile_skip: !r.reconcile_skip }).then(() => mutate()); }}
                    className={`text-[10px] px-2 py-1 rounded border ${r.reconcile_skip ? "border-red-400/30 text-red-400" : "border-border text-text-secondary"}`}
                  >
                    {r.reconcile_skip ? "Skipped" : "Skip"}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Dependencies Tab ────────────────────────────────────────────────────────
function DependenciesTab() {
  const { data: stats } = useSWR(API.depStats(), fetcher, { refreshInterval: 20000 });
  const { data, mutate } = useSWR(API.depVulns("perPage=30"), fetcher, { refreshInterval: 20000 });
  const vulns = (data?.rows ?? data ?? []) as any[];
  const v = stats?.vulnerabilities ?? {};

  return (
    <div className="space-y-6">
      {/* Stat cards */}
      <div className="grid grid-cols-5 gap-4">
        {[
          { label: "Critical", value: v.critical ?? 0, color: "text-red-400" },
          { label: "High", value: v.high ?? 0, color: "text-orange-400" },
          { label: "Medium", value: v.medium ?? 0, color: "text-yellow-400" },
          { label: "PRs Opened", value: v.prs_opened ?? 0, color: "text-blue-400" },
          { label: "Repos Affected", value: v.repos_affected ?? 0, color: "text-text-primary" },
        ].map((c) => (
          <div key={c.label} className="bg-surface-1 border border-border rounded-lg p-4 text-center">
            <p className={`text-2xl font-bold ${c.color}`}>{c.value}</p>
            <p className="text-xs text-text-secondary">{c.label}</p>
          </div>
        ))}
      </div>

      {/* Vulnerability list */}
      <div>
        <h3 className="text-sm font-medium text-text-primary mb-3">Open Vulnerabilities</h3>
        {vulns.length === 0 ? (
          <p className="text-text-tertiary text-sm py-8 text-center">No open vulnerabilities found.</p>
        ) : (
          <div className="space-y-2">
            {vulns.map((v: any) => (
              <div key={v.id} className="bg-surface-1 border border-border rounded-lg p-4 flex items-center justify-between">
                <div>
                  <div className="flex items-center gap-2">
                    <span className={`text-xs px-2 py-0.5 rounded ${severityColor(v.severity)}`}>{v.severity}</span>
                    <span className="text-sm font-medium text-text-primary">{v.package_name}</span>
                    <span className="text-[10px] text-text-tertiary">{v.ecosystem}</span>
                  </div>
                  <div className="flex items-center gap-3 mt-1">
                    <span className="text-xs text-text-secondary">{v.repo_full_name}</span>
                    {v.cvss_score && <span className="text-xs text-text-tertiary">CVSS: {v.cvss_score}</span>}
                    {v.patched_version && <span className="text-[10px] text-green-400">Fix: {v.patched_version}</span>}
                    {v.ghsa_id && <span className="text-[10px] text-text-tertiary">{v.ghsa_id}</span>}
                  </div>
                </div>
                <button
                  onClick={() => { dismissVuln(v.id).then(() => mutate()); }}
                  className="text-xs px-2 py-1 rounded border border-border text-text-secondary hover:text-red-400"
                >
                  Dismiss
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function severityColor(severity: string) {
  const map: Record<string, string> = {
    critical: "bg-red-500/10 text-red-400",
    high: "bg-orange-500/10 text-orange-400",
    medium: "bg-yellow-500/10 text-yellow-400",
    low: "bg-blue-500/10 text-blue-400",
  };
  return map[severity] ?? "bg-gray-500/10 text-gray-400";
}
