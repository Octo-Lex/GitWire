/** GitWire Dashboard API client */
const API_BASE = process.env.NEXT_PUBLIC_API_URL || "https://gitwire.erlab.uk";
const API_KEY = process.env.NEXT_PUBLIC_API_KEY || "";

async function fetchAPI(path: string) {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${API_KEY}` },
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
}

// Types
export interface Repo {
  github_id: string;
  full_name: string;
  owner: string;
  name: string;
  private: boolean;
  default_branch: string;
  language: string | null;
  stars: number;
  open_issues: number;
  open_prs: number;
  last_synced_at: string | null;
  ci_pass_rate: number | null;
  last_ci_conclusion: string | null;
  healed_runs: string;
  failed_heal_runs: string;
}

export interface Issue {
  github_id: string;
  number: number;
  title: string;
  state: string;
  labels: string[];
  assignees: string[];
  triage_type: string | null;
  triage_priority: string | null;
  triage_summary: string | null;
  triaged_at: string | null;
  created_at: string;
  repo_full_name: string;
  repo_owner: string;
  repo_name: string;
}

export interface CIStats {
  summary: {
    total_runs: string;
    passed: string;
    failed: string;
    cancelled: string;
    pass_rate: number | null;
    auto_healed: string;
    heal_attempted: string;
    heal_failed: string;
  };
  by_failure_type: { failure_type: string; count: string }[];
  trend: { date: string; passed: number; failed: number }[];
}

export interface InsightsOverview {
  repos: { total: string; synced: string };
  issues: { open: string; closed: string; unassigned: string; critical: string };
  prs: { open: string; merged: string; draft: string };
  ci: { pass_rate: number | null; auto_healed: string; total_failures: string };
}

// API functions
export const api = {
  repos: (page = 1) => fetchAPI(`/api/repos?page=${page}`),
  issues: (page = 1) => fetchAPI(`/api/issues?page=${page}`),
  pullRequests: (page = 1) => fetchAPI(`/api/pull-requests?page=${page}`),
  ciRuns: (page = 1) => fetchAPI(`/api/ci/?page=${page}`),
  ciStats: () => fetchAPI(`/api/ci/stats`),
  insightsOverview: () => fetchAPI(`/api/insights/overview`),
  insightsRepos: () => fetchAPI(`/api/insights/repos`),
  insightsVelocity: () => fetchAPI(`/api/insights/velocity`),
  insightsCITrend: () => fetchAPI(`/api/insights/ci-trend`),
};
