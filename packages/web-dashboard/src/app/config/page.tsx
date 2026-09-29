"use client";

import { useCallback, useEffect, useState } from "react";
import useSWR from "swr";
import {
  API,
  fetcher,
  getConfigHistory,
  getRepoConfig,
} from "../../lib/api";

type RepoSummary = {
  full_name: string;
  owner: string;
  name: string;
};

type HistoryEntry = {
  id: number;
  action?: string;
  changed_at?: string;
  changed_by?: string;
  config_old?: unknown;
  config_new?: unknown;
};

export default function ConfigPage() {
  const { data: reposData } = useSWR(API.repos("per_page=100"), fetcher);
  const repos: RepoSummary[] = reposData?.data || [];

  const [selected, setSelected] = useState("");
  const [config, setConfig] = useState<any>(null);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");

  const loadConfig = useCallback(async (fullName: string) => {
    if (!fullName) return;
    setLoading(true);
    setMessage("");
    try {
      const [owner, name] = fullName.split("/");
      const [configData, historyData] = await Promise.all([
        getRepoConfig(owner, name),
        getConfigHistory(owner, name),
      ]);
      setConfig(configData);
      setHistory(historyData?.history || []);
    } catch (_e) {
      setConfig(null);
      setHistory([]);
      setMessage("Failed to load config");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (selected) {
      loadConfig(selected);
    } else {
      setConfig(null);
      setHistory([]);
      setMessage("");
    }
  }, [selected, loadConfig]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-display font-bold text-text-primary">
          Repo Config
        </h1>
        <p className="text-sm text-text-secondary mt-1">
          Governed live policy — read only. Create policy changes through the
          governed rollout workflow; direct dashboard overrides are disabled.
        </p>
        <a
          href="/rollouts"
          className="inline-flex mt-3 text-sm font-medium text-accent-green hover:underline"
        >
          Open governed rollout workflow →
        </a>
      </div>

      <div>
        <label className="block text-xs font-medium text-text-secondary mb-1">
          Repository
        </label>
        <select
          value={selected}
          onChange={(event) => setSelected(event.target.value)}
          className="w-full bg-surface-1 border border-border rounded-lg px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-accent-green/50"
        >
          <option value="">Select a repo…</option>
          {repos.map((repo) => (
            <option key={repo.full_name} value={repo.full_name}>
              {repo.full_name}
            </option>
          ))}
        </select>
      </div>

      {message && (
        <div className="text-sm text-red-400">{message}</div>
      )}

      {loading && (
        <div className="text-sm text-text-secondary animate-pulse">
          Loading config…
        </div>
      )}

      {config && !loading && (
        <>
          <div className="card p-4 space-y-3">
            <div className="flex flex-wrap items-center gap-2 text-xs text-text-tertiary">
              <span>Source:</span>
              <span className="px-2 py-0.5 rounded bg-surface-2 text-text-secondary">
                {config.source === "database" ? "Governed database policy" : "YAML / defaults"}
              </span>
              {config.updatedAt && (
                <span>
                  · Updated {new Date(config.updatedAt).toLocaleString()}
                  {config.updatedBy ? ` by ${config.updatedBy}` : ""}
                </span>
              )}
            </div>
            <div>
              <h2 className="text-sm font-medium text-text-primary mb-2">
                Resolved live policy
              </h2>
              <pre className="overflow-x-auto rounded-lg bg-surface-1 border border-border p-3 text-xs text-text-secondary">
                {JSON.stringify(config.config, null, 2)}
              </pre>
            </div>
          </div>

          <div className="card p-4">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-medium text-text-primary">
                Config history
              </h2>
              <span className="text-xs text-text-tertiary">
                Inspection only
              </span>
            </div>

            {history.length === 0 ? (
              <p className="text-sm text-text-secondary">No history recorded.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs text-text-tertiary border-b border-border">
                      <th className="py-2 pr-4">Version</th>
                      <th className="py-2 pr-4">Action</th>
                      <th className="py-2 pr-4">Actor</th>
                      <th className="py-2">Changed</th>
                    </tr>
                  </thead>
                  <tbody>
                    {history.map((entry) => (
                      <tr key={entry.id} className="border-b border-border/50 text-text-secondary">
                        <td className="py-2 pr-4 font-mono">{entry.id}</td>
                        <td className="py-2 pr-4">{entry.action || "—"}</td>
                        <td className="py-2 pr-4">{entry.changed_by || "—"}</td>
                        <td className="py-2">
                          {entry.changed_at
                            ? new Date(entry.changed_at).toLocaleString()
                            : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
