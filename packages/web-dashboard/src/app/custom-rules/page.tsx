"use client";

import { useState } from "react";
import useSWR from "swr";
import { fetcher, API } from "@/lib/api";
import {
  Badge,
  StatCard,
  EmptyState,
  PageHeader,
} from "@/components/ui";

interface RepoInfo {
  github_id: number;
  full_name: string;
  owner: string;
  name: string;
  language: string;
  private: boolean;
  last_synced_at: string;
}

interface CustomRule {
  name: string;
  condition: string;
  actions: string[];
}

interface RepoCustomRules {
  rules: CustomRule[];
  expressions: Record<string, Record<string, string>>;
  total: number;
}

interface Decision {
  id: number;
  source: string;
  trigger_event: string;
  target_type: string;
  target_number: number;
  pillar: string;
  decision: string;
  reason: string;
  conditions: Array<{ check: string; result: boolean }>;
  created_at: string;
}

export default function CustomRulesPage() {
  const [selectedRepo, setSelectedRepo] = useState<string | null>(null);

  const { data: repos } = useSWR<RepoInfo[]>(
    API.repos("limit=100"),
    fetcher
  );

  const repoList: RepoInfo[] = (repos as any)?.data ?? (Array.isArray(repos) ? repos : (repos ? [repos] : []));

  const { data: rules } = useSWR<RepoCustomRules>(
    selectedRepo
      ? API.repoConfig(
          selectedRepo.split("/")[0],
          selectedRepo.split("/")[1]
        ).replace("/api/config/", "/api/config/") + "/custom-rules"
      : null,
    fetcher
  );

  // Fetch recent custom_rules decisions for selected repo
  const { data: decisions } = useSWR<{ data: Decision[] }>(
    selectedRepo
      ? API.decisions(
          "source=custom_rules&repo=" +
            encodeURIComponent(selectedRepo) +
            "&limit=20"
        )
      : null,
    fetcher
  );

  const decisionRows = decisions?.data ?? [];

  // Count repos with custom rules
  const reposWithRules = repoList.length;

  return (
    <div>
      <PageHeader
        title="Custom Rules"
        subtitle="Automation rules defined in .gitwire.yml across your repos"
      />

      <div className="grid grid-cols-2 md:grid-cols-3 gap-4 mb-6">
        <StatCard label="Connected Repos" value={repoList.length} />
        <StatCard label="Selected Repo Rules" value={rules?.total ?? 0} accent="green" />
        <StatCard
          label="Recent Matches"
          value={decisionRows.length}
        />
      </div>

      <div className="card">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold">
            {selectedRepo ? selectedRepo : "Select a Repository"}
          </h2>
          {selectedRepo && (
            <button
              className="text-sm text-text-secondary hover:text-text-primary"
              onClick={() => setSelectedRepo(null)}
            >
              &larr; Back
            </button>
          )}
        </div>

        {!selectedRepo ? (
          <div>
            {repoList.length === 0 ? (
              <EmptyState title="No repos connected" body="Connect a repo via GitHub App installation to see custom rules" />
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-[10px] font-mono text-text-tertiary uppercase tracking-wider">
                    <th className="text-left px-4 py-2.5">Repository</th>
                    <th className="text-left px-4 py-2.5">Language</th>
                    <th className="text-left px-4 py-2.5">Last Synced</th>
                  </tr>
                </thead>
                <tbody>
                  {repoList.map((r) => (
                    <tr
                      key={r.github_id}
                      className="border-b border-border hover:bg-surface-2/40 cursor-pointer transition-colors"
                      onClick={() => setSelectedRepo(r.full_name)}
                    >
                      <td className="px-4 py-3 font-medium">{r.full_name}</td>
                      <td className="px-4 py-3 font-mono text-xs text-text-tertiary">
                        {r.language || "\u2014"}
                      </td>
                      <td className="px-4 py-3 text-text-tertiary text-xs">
                        {r.last_synced_at
                          ? new Date(r.last_synced_at).toLocaleDateString()
                          : "Never"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        ) : (
          <div>
            {/* Rules list */}
            {!rules || rules.total === 0 ? (
              <EmptyState
                title="No custom rules defined"
                body="Add custom_rules: section to .gitwire.yml in this repo"
              />
            ) : (
              <div className="space-y-3 mb-6">
                <h3 className="text-sm font-semibold text-text-secondary">
                  Rules ({rules.total})
                </h3>
                {rules.rules.map((rule) => (
                  <div
                    key={rule.name}
                    className="bg-gray-800/50 rounded-lg p-4"
                  >
                    <div className="flex items-center gap-2 mb-2">
                      <h4 className="font-semibold">{rule.name}</h4>
                      {rule.actions.map((a) => (
                        <Badge
                          key={a}
                          className="bg-blue-900/50 text-blue-300"
                        >
                          {a}
                        </Badge>
                      ))}
                    </div>
                    <div className="font-mono text-xs text-text-tertiary bg-gray-900/50 rounded px-3 py-2">
                      if: {rule.condition}
                    </div>
                  </div>
                ))}

                {/* Named expressions */}
                {Object.keys(rules.expressions || {}).length > 0 && (
                  <div className="mt-4">
                    <h3 className="text-sm font-semibold text-text-secondary mb-2">
                      Named Expressions
                    </h3>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                      {Object.entries(rules.expressions || {}).map(
                        ([group, exprs]) =>
                          Object.entries(exprs).map(([name, expr]) => (
                            <div
                              key={group + "." + name}
                              className="bg-gray-800/30 rounded p-2 text-xs font-mono"
                            >
                              <span className="text-text-tertiary">
                                {group}.{name}:
                              </span>{" "}
                              <span className="text-accent-green">{expr}</span>
                            </div>
                          ))
                      )}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Recent rule matches */}
            <div className="mt-6">
              <h3 className="text-sm font-semibold text-text-secondary mb-2">
                Recent Matches
              </h3>
              {decisionRows.length === 0 ? (
                <p className="text-sm text-text-tertiary">
                  No custom rule matches recorded yet for this repo.
                </p>
              ) : (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border text-[10px] font-mono text-text-tertiary uppercase tracking-wider">
                      <th className="text-left px-3 py-2">Time</th>
                      <th className="text-left px-3 py-2">Event</th>
                      <th className="text-left px-3 py-2">Target</th>
                      <th className="text-left px-3 py-2">Decision</th>
                      <th className="text-left px-3 py-2">Reason</th>
                    </tr>
                  </thead>
                  <tbody>
                    {decisionRows.map((d) => (
                      <tr key={d.id} className="border-b border-border/50">
                        <td className="px-3 py-2 text-xs text-text-tertiary">
                          {new Date(d.created_at).toLocaleString()}
                        </td>
                        <td className="px-3 py-2 font-mono text-xs">
                          {d.trigger_event}
                        </td>
                        <td className="px-3 py-2">
                          {d.target_type} #{d.target_number}
                        </td>
                        <td className="px-3 py-2">
                          <Badge
                            className={
                              d.decision === "acted"
                                ? "bg-green-900/50 text-green-300"
                                : "bg-gray-700 text-gray-400"
                            }
                          >
                            {d.decision}
                          </Badge>
                        </td>
                        <td className="px-3 py-2 text-xs text-text-tertiary max-w-xs truncate">
                          {d.reason}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
