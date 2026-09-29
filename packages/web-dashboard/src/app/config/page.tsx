"use client";

import { useState, useEffect, useCallback } from "react";
import useSWR from "swr";
import {
  fetcher,
  API,
  getRepoConfig,
  getConfigHistory,
} from "../../lib/api";

export default function ConfigPage() {
  const { data: reposData } = useSWR(API.repos("per_page=100"), fetcher);
  const repos: { full_name: string; owner: string; name: string }[] =
    reposData?.data || [];

  const [selected, setSelected] = useState("");
  const [config, setConfig] = useState<any>(null);
  const [history, setHistory] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");

  const loadConfig = useCallback(async (fullName: string) => {
    if (!fullName) return;
    setLoading(true);
    setMessage("");
    try {
      const [owner, name] = fullName.split("/");
      const data = await getRepoConfig(owner, name);
      setConfig(data);
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
    else {
      setConfig(null);
      setHistory([]);
    }
  }, [selected, loadConfig]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-display font-bold text-text-primary">
          Repo Config
        </h1>
        <p className="text-sm text-text-secondary mt-1">
          Effective repository policy and committed compatibility history.
        </p>
      </div>

      <div className="rounded-lg border border-accent-green/30 bg-accent-green/5 px-4 py-3">
        <div className="text-sm font-medium text-text-primary">
          Governed policy — read only
        </div>
        <p className="mt-1 text-xs text-text-secondary">
          Live policy changes must go through rollout creation, immutable authority and evidence,
          separated approval, and governed promotion. Direct dashboard edits, reset, restore, and
          historical rollback no longer write live policy.
        </p>
      </div>

      <div>
        <label className="block text-xs font-medium text-text-secondary mb-1">
          Repository
        </label>
        <select
          value={selected}
          onChange={(e) => setSelected(e.target.value)}
          className="w-full bg-surface-1 border border-border rounded-lg px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-accent-green/50"
        >
          <option value="">Select a repo…</option>
          {repos.map((repo: any) => (
            <option key={repo.full_name} value={repo.full_name}>
              {repo.full_name}
            </option>
          ))}
        </select>
      </div>

      {loading && (
        <div className="text-sm text-text-secondary animate-pulse">
          Loading config…
        </div>
      )}

      {message && <div className="text-sm text-red-400">{message}</div>}

      {config && !loading && (
        <>
          <div className="border border-border rounded-lg p-4 bg-surface-0">
            <div className="flex flex-wrap items-center gap-2 text-xs text-text-tertiary mb-3">
              <span>Source:</span>
              <span
                className={
                  config.source === "database"
                    ? "px-2 py-0.5 rounded bg-accent-green/10 text-accent-green"
                    : "px-2 py-0.5 rounded bg-surface-2 text-text-secondary"
                }
              >
                {config.source === "database" ? "Governed materialization" : "YAML / defaults"}
              </span>
              {config.updatedAt && (
                <span>
                  · Updated {new Date(config.updatedAt).toLocaleString()} by {config.updatedBy}
                </span>
              )}
            </div>

            <h2 className="text-sm font-medium text-text-primary mb-2">
              Effective policy
            </h2>
            <pre className="overflow-x-auto rounded bg-surface-1 p-3 text-xs text-text-secondary">
              {JSON.stringify(config.config, null, 2)}
            </pre>
          </div>

          <div>
            <h2 className="text-lg font-display font-bold text-text-primary mb-3">
              Change History
            </h2>
            {history.length === 0 ? (
              <div className="text-sm text-text-secondary border border-border rounded-lg p-4">
                No committed config history.
              </div>
            ) : (
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
                      className="border border-border rounded-lg p-3"
                    >
                      <div className="flex flex-wrap items-center gap-2 text-xs">
                        <span className={`px-1.5 py-0.5 rounded font-mono ${actionClass}`}>
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
                  );
                })}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function diffConfigs(
  oldConfig: Record<string, any> | null,
  newConfig: Record<string, any> | null
): string[] {
  const changes: string[] = [];
  if (!oldConfig && newConfig) return ["Initial governed materialization"];
  if (oldConfig && !newConfig) return ["Materialization removed"];
  if (!oldConfig || !newConfig) return changes;

  const oldPillars = oldConfig.pillars || {};
  const newPillars = newConfig.pillars || {};
  const keys = new Set([...Object.keys(oldPillars), ...Object.keys(newPillars)]);
  for (const key of keys) {
    const oldVal = oldPillars[key]?.enabled;
    const newVal = newPillars[key]?.enabled;
    if (oldVal !== newVal) {
      changes.push(`${key}: ${oldVal ? "on" : "off"} → ${newVal ? "on" : "off"}`);
    }
  }

  return changes.length > 0 ? changes : ["Policy content updated"];
}
