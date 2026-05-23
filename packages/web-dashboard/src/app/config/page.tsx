"use client";

import { useState, useEffect, useCallback } from "react";
import useSWR from "swr";
import {
  fetcher,
  API,
  getRepoConfig,
  patchRepoConfig,
  resetRepoConfig,
  getConfigHistory,
  restoreConfigVersion,
} from "../../lib/api";

// ── Pillar definitions ──────────────────────────────────────────────────────

const PILLARS = [
  {
    key: "triage",
    label: "Issue & PR Triage",
    icon: "◎",
    desc: "AI classification, auto-labeling, duplicate detection",
    opts: [
      { key: "auto_label", label: "Auto-label", type: "toggle" },
      { key: "auto_comment", label: "Triage comments", type: "toggle" },
      { key: "duplicate_detection", label: "Duplicate detection", type: "toggle" },
    ],
  },
  {
    key: "ci_healing",
    label: "Self-Healing CI",
    icon: "⚙",
    desc: "Diagnose failures, auto-patch PRs",
    opts: [
      { key: "auto_patch", label: "Auto-patch PRs", type: "toggle" },
      {
        key: "max_fix_attempts",
        label: "Max fix attempts",
        type: "number",
        min: 1,
        max: 10,
      },
    ],
  },
  {
    key: "maintainer",
    label: "Maintainer",
    icon: "⟳",
    desc: "Stale management, branch cleanup",
    opts: [
      {
        key: "stale.issues.warn_days",
        label: "Stale issue days",
        type: "number",
        min: 7,
        max: 365,
      },
      {
        key: "stale.prs.warn_days",
        label: "Stale PR days",
        type: "number",
        min: 7,
        max: 365,
      },
      {
        key: "branch_cleanup.enabled",
        label: "Branch cleanup",
        type: "toggle",
      },
    ],
  },
  {
    key: "issue_fix",
    label: "Autonomous Contributor",
    icon: "⚡",
    desc: "AI-generated code fixes for labeled issues",
    defaultEnabled: false,
    warn: "Opt-in only — generates code and opens PRs",
    opts: [
      {
        key: "max_file_changes",
        label: "Max file changes",
        type: "number",
        min: 1,
        max: 10,
      },
      {
        key: "max_line_changes",
        label: "Max line changes",
        type: "number",
        min: 50,
        max: 1000,
      },
    ],
  },
  {
    key: "enforcement",
    label: "Enforcement",
    icon: "🛡",
    desc: "Branch protection, config validation",
    opts: [],
  },
  {
    key: "merge_queue",
    label: "Merge Queue",
    icon: "⌘",
    desc: "Auto-merge PRs with \"auto-merge\" label",
    defaultEnabled: false,
    opts: [],
  },
  {
    key: "settings",
    label: "Settings",
    icon: "⚙",
    desc: "Global behavior flags",
    opts: [
      { key: "dry_run", label: "Dry run mode", type: "toggle", warn: "No mutations will be executed" },
    ],
  },
  {
    key: "ai_review",
    label: "AI Review",
    icon: "🧠",
    desc: "Automated code review on PR open/sync",
    opts: [
      { key: "comment_findings", label: "Post review comments", type: "toggle" },
    ],
  },
];

// ── Page ────────────────────────────────────────────────────────────────────

export default function ConfigPage() {
  const { data: reposData } = useSWR(API.repos("per_page=100"), fetcher);
  const repos: { full_name: string; owner: string; name: string }[] =
    reposData?.data || [];

  const [selected, setSelected] = useState("");
  const [config, setConfig] = useState<any>(null);
  const [history, setHistory] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");

  const loadConfig = useCallback(async (fullName: string) => {
    if (!fullName) return;
    setLoading(true);
    setMessage("");
    try {
      const parts = fullName.split("/");
      const owner = parts[0];
      const name = parts[1];
      const data = await getRepoConfig(owner, name);
      setConfig(data);
      // Load history
      const histData = await getConfigHistory(owner, name);
      setHistory(histData?.history || []);
    } catch (_e) {
      setMessage("Failed to load config");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (selected) loadConfig(selected);
    else setConfig(null);
  }, [selected, loadConfig]);

  const togglePillar = async (pillarKey: string, enabled: boolean) => {
    if (!selected) return;
    setSaving(true);
    try {
      const parts = selected.split("/");
      await patchRepoConfig(parts[0], parts[1], {
        pillars: { [pillarKey]: { enabled } },
      });
      await loadConfig(selected);
      setMessage("✓ " + pillarKey + (enabled ? " enabled" : " disabled"));
    } catch (_e) {
      setMessage("Failed to update config");
    } finally {
      setSaving(false);
    }
  };

  const updateOption = async (
    pillarKey: string,
    optionKey: string,
    value: any
  ) => {
    if (!selected) return;
    setSaving(true);
    try {
      const parts = selected.split("/");
      if (pillarKey === "settings") {
        await patchRepoConfig(parts[0], parts[1], {
          settings: { [optionKey]: value },
        });
      } else {
        const parts2 = optionKey.split(".");
        let nested: any = value;
        for (let i = parts2.length - 1; i >= 0; i--) {
          nested = { [parts2[i]]: nested };
        }
        await patchRepoConfig(parts[0], parts[1], {
          pillars: { [pillarKey]: nested },
        });
      }
      await loadConfig(selected);
      setMessage("✓ " + optionKey + " updated");
    } catch (_e) {
      setMessage("Failed to update config");
    } finally {
      setSaving(false);
    }
  };

  const handleRestore = async (historyId: number) => {
    if (!selected) return;
    setSaving(true);
    try {
      const parts = selected.split("/");
      await restoreConfigVersion(parts[0], parts[1], historyId);
      await loadConfig(selected);
      setMessage("✓ Restored from history");
    } catch (_e) {
      setMessage("Failed to restore");
    } finally {
      setSaving(false);
    }
  };

  const handleReset = async () => {
    if (!selected) return;
    if (!confirm("Reset all overrides? Config will revert to YAML + defaults.")) return;
    setSaving(true);
    try {
      const parts = selected.split("/");
      await resetRepoConfig(parts[0], parts[1]);
      await loadConfig(selected);
      setMessage("✓ Config reset to defaults");
    } catch (_e) {
      setMessage("Failed to reset config");
    } finally {
      setSaving(false);
    }
  };

  const getPillarEnabled = (key: string) => {
    if (key === "settings") return true; // always show
    return config?.pillars?.[key]?.enabled !== false;
  };

  const getPillarOverridden = (key: string) => {
    return config?.pillars?.[key]?.hasOverride === true;
  };

  const getOptionValue = (pillarKey: string, optionKey: string) => {
    if (pillarKey === "settings") {
      return config?.config?.settings?.[optionKey];
    }
    const parts = optionKey.split(".");
    let val = config?.config?.pillars?.[pillarKey];
    for (const p of parts) {
      val = val?.[p];
    }
    return val;
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-display font-bold text-text-primary">
          Repo Config
        </h1>
        <p className="text-sm text-text-secondary mt-1">
          Per-repo pillar configuration. Overrides take precedence over{" "}
          <code className="text-accent-green">.gitwire.yml</code>.
        </p>
      </div>

      {/* Repo selector */}
      <div className="flex gap-3 items-end">
        <div className="flex-1">
          <label className="block text-xs font-medium text-text-secondary mb-1">
            Repository
          </label>
          <select
            value={selected}
            onChange={(e) => setSelected(e.target.value)}
            className="w-full bg-surface-1 border border-border rounded-lg px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-accent-green/50"
          >
            <option value="">Select a repo…</option>
            {repos.map((r: any) => (
              <option key={r.full_name} value={r.full_name}>
                {r.full_name}
              </option>
            ))}
          </select>
        </div>
        {config && (
          <button
            onClick={handleReset}
            className="px-4 py-2 text-sm font-medium text-red-400 border border-red-400/30 rounded-lg hover:bg-red-400/10 transition-colors"
          >
            Reset Overrides
          </button>
        )}
      </div>

      {/* Source indicator */}
      {config && (
        <div className="flex items-center gap-2 text-xs text-text-tertiary">
          <span>Source:</span>
          <span
            className={
              config.source === "database"
                ? "px-2 py-0.5 rounded bg-accent-green/10 text-accent-green"
                : "px-2 py-0.5 rounded bg-surface-2 text-text-secondary"
            }
          >
            {config.source === "database" ? "Dashboard overrides" : "YAML / defaults"}
          </span>
          {config.updatedAt && (
            <span>
              · Updated {new Date(config.updatedAt).toLocaleString()} by{" "}
              {config.updatedBy}
            </span>
          )}
        </div>
      )}

      {/* Loading */}
      {loading && (
        <div className="text-sm text-text-secondary animate-pulse">
          Loading config…
        </div>
      )}

      {/* Dry-run banner */}
      {config && config.config?.settings?.dry_run && (
        <div className="px-4 py-3 rounded-lg bg-yellow-500/10 border border-yellow-500/30 text-yellow-400 text-sm font-medium">
          ⚠ DRY RUN MODE ACTIVE — All mutations are logged but not executed. Workers will describe what they would do without making changes.
        </div>
      )}

      {/* Pillar cards */}
      {config && !loading && (
        <div className="space-y-3">
          {PILLARS.map((pillar) => {
            const enabled = getPillarEnabled(pillar.key);
            const overridden = getPillarOverridden(pillar.key);

            return (
              <div
                key={pillar.key}
                className={
                  "border rounded-lg p-4 transition-colors " +
                  (enabled
                    ? "border-border bg-surface-0"
                    : "border-border/50 bg-surface-0/50 opacity-60")
                }
              >
                {/* Header */}
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <span className="text-lg">{pillar.icon}</span>
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-text-primary text-sm">
                          {pillar.label}
                        </span>
                        {overridden && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-accent-green/10 text-accent-green font-mono">
                            OVERRIDE
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-text-secondary mt-0.5">
                        {pillar.desc}
                      </p>
                    </div>
                  </div>

                  <button
                    onClick={() => togglePillar(pillar.key, !enabled)}
                    disabled={saving}
                    className={
                      "relative w-11 h-6 rounded-full transition-colors " +
                      (enabled ? "bg-accent-green" : "bg-surface-2")
                    }
                  >
                    <span
                      className={
                        "absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform " +
                        (enabled ? "left-[22px]" : "left-0.5")
                      }
                    />
                  </button>
                </div>

                {/* Warn banner */}
                {pillar.warn && enabled && (
                  <div className="mt-3 px-3 py-2 rounded bg-yellow-500/10 text-yellow-400 text-xs">
                    ⚠ {pillar.warn}
                  </div>
                )}

                {/* Options */}
                {pillar.opts.length > 0 && enabled && (
                  <div className="mt-3 grid grid-cols-2 gap-3">
                    {pillar.opts.map((opt) => {
                      const val = getOptionValue(pillar.key, opt.key);
                      return (
                        <div key={opt.key} className="flex items-center gap-2">
                          {opt.type === "toggle" ? (
                            <>
                              <input
                                type="checkbox"
                                checked={val !== false}
                                onChange={(e) =>
                                  updateOption(
                                    pillar.key,
                                    opt.key,
                                    e.target.checked
                                  )
                                }
                                disabled={saving}
                                className="accent-accent-green"
                              />
                              <span className="text-xs text-text-secondary">
                                {opt.label}
                              </span>
                            </>
                          ) : (
                            <>
                              <label className="text-xs text-text-secondary w-32">
                                {opt.label}
                              </label>
                              <input
                                type="number"
                                value={val ?? ""}
                                min={(opt as any).min}
                                max={(opt as any).max}
                                onChange={(e) =>
                                  updateOption(
                                    pillar.key,
                                    opt.key,
                                    parseInt(e.target.value) || 0
                                  )
                                }
                                disabled={saving}
                                className="w-20 bg-surface-1 border border-border rounded px-2 py-1 text-xs text-text-primary focus:outline-none focus:ring-1 focus:ring-accent-green/50"
                              />
                            </>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Feedback */}
      {message && (
        <div className="text-sm text-accent-green animate-pulse">{message}</div>
      )}

      {/* History */}
      {config && history.length > 0 && (
        <div>
          <h2 className="text-lg font-display font-bold text-text-primary mb-3">
            Change History
          </h2>
          <div className="space-y-2">
            {history.map((entry: any) => {
              const changes = diffConfigs(entry.config_old, entry.config_new);
              const dateStr = new Date(entry.changed_at).toLocaleString();
              const actionClass =
                entry.action === "delete"
                  ? "bg-red-500/10 text-red-400"
                  : entry.action === "restore"
                  ? "bg-blue-500/10 text-blue-400"
                  : "bg-accent-green/10 text-accent-green";
              return (
                <div
                  key={entry.id}
                  className="border border-border rounded-lg p-3 flex items-center justify-between"
                >
                  <div className="flex-1">
                    <div className="flex items-center gap-2 text-xs">
                      <span className={"px-1.5 py-0.5 rounded font-mono " + actionClass}>
                        {entry.action}
                      </span>
                      <span className="text-text-tertiary">{dateStr}</span>
                      <span className="text-text-secondary">by {entry.changed_by}</span>
                    </div>
                    {changes.length > 0 && (
                      <div className="mt-1 text-xs text-text-secondary">
                        {changes.join(" · ")}
                      </div>
                    )}
                  </div>
                  {entry.action !== "delete" && (
                    <button
                      onClick={() => handleRestore(entry.id)}
                      disabled={saving}
                      className="ml-3 px-3 py-1 text-xs font-medium text-accent-green border border-accent-green/30 rounded hover:bg-accent-green/10 transition-colors disabled:opacity-50"
                    >
                      Restore
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Config diff helper ──────────────────────────────────────────────────────
function diffConfigs(
  oldConfig: Record<string, any> | null,
  newConfig: Record<string, any> | null
): string[] {
  const changes: string[] = [];
  if (!oldConfig && newConfig) {
    changes.push("Initial config set");
    return changes;
  }
  if (oldConfig && !newConfig) {
    changes.push("All overrides deleted");
    return changes;
  }
  if (!oldConfig || !newConfig) return changes;

  const oldPillars = oldConfig.pillars || {};
  const newPillars = newConfig.pillars || {};

  for (const key of Object.keys(newPillars)) {
    const oldVal = oldPillars[key]?.enabled;
    const newVal = newPillars[key]?.enabled;
    if (oldVal !== newVal) {
      changes.push(key + ": " + (oldVal ? "on" : "off") + " → " + (newVal ? "on" : "off"));
    }
  }

  return changes.length > 0 ? changes : ["No pillar changes (sub-option update)"];
}
