/** GitWire Dashboard — SWR fetcher + typed API hooks */

const BASE = process.env.NEXT_PUBLIC_API_URL || "";
const API_KEY = process.env.NEXT_PUBLIC_API_KEY || "";

async function fetcher(url: string) {
  const res = await fetch(`${BASE}${url}`, {
    headers: API_KEY ? { Authorization: `Bearer ${API_KEY}` } : {},
  });
  if (!res.ok) throw new Error(`API error ${res.status}: ${url}`);
  return res.json();
}

export { fetcher };

// ── API endpoint builders ──────────────────────────────────────────────────
// Each returns a URL string for use as SWR key. Pass null to skip fetch.

export const API = {
  // Overview
  insights:        () => `/api/insights/overview`,
  insightRepos:    () => `/api/insights/repos`,
  insightVelocity: () => `/api/insights/velocity`,
  insightCITrend:  () => `/api/insights/ci-trend`,

  // Repos
  repos: (q = "") => `/api/repos${q ? `?${q}` : ""}`,
  repo:  (owner: string, name: string) => `/api/repos/${owner}/${name}`,

  // Issues
  issueStats: () => `/api/issues/stats`,
  issues:     (q = "") => `/api/issues${q ? `?${q}` : ""}`,

  // PRs
  prStats: () => `/api/pull-requests/stats`,
  prs:     (q = "") => `/api/pull-requests${q ? `?${q}` : ""}`,

  // CI
  ciStats: () => `/api/ci/stats`,
  ciRuns:  (q = "") => `/api/ci/${q ? `?${q}` : ""}`,

  // Maintainer
  maintainerSettings: (owner: string, repo: string) => `/api/maintainer/${owner}/${repo}/settings`,
  maintainerActions:  (owner: string, repo: string, q = "") => `/api/maintainer/${owner}/${repo}/actions${q ? `?${q}` : ""}`,
  maintainerStats:    (owner: string, repo: string) => `/api/maintainer/${owner}/${repo}/stats`,

  // Fix attempts
  fixAttempts: (owner: string, repo: string, q = "") => `/api/fix/${owner}/${repo}/attempts${q ? `?${q}` : ""}`,
};

// ── Trigger helpers (non-GET) ─────────────────────────────────────────────
export async function triggerRepoSync(owner: string, repo: string) {
  const res = await fetch(`${BASE}/api/repos/${owner}/${repo}/sync`, {
    method: "POST",
    headers: API_KEY ? { Authorization: `Bearer ${API_KEY}` } : {},
  });
  return res.json();
}

export async function retryRun(runId: string) {
  const res = await fetch(`${BASE}/api/ci/${runId}/retry`, {
    method: "POST",
    headers: API_KEY ? { Authorization: `Bearer ${API_KEY}` } : {},
  });
  return res.json();
}

export async function triggerStaleScan(owner: string, repo: string) {
  const res = await fetch(`${BASE}/api/maintainer/${owner}/${repo}/stale-scan`, {
    method: "POST",
    headers: API_KEY ? { Authorization: `Bearer ${API_KEY}` } : {},
  });
  return res.json();
}

export async function triggerBranchCleanup(owner: string, repo: string) {
  const res = await fetch(`${BASE}/api/maintainer/${owner}/${repo}/branch-cleanup`, {
    method: "POST",
    headers: API_KEY ? { Authorization: `Bearer ${API_KEY}` } : {},
  });
  return res.json();
}

export async function updateSettings(owner: string, repo: string, settings: Record<string, unknown>) {
  const res = await fetch(`${BASE}/api/maintainer/${owner}/${repo}/settings`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      ...(API_KEY ? { Authorization: `Bearer ${API_KEY}` } : {}),
    },
    body: JSON.stringify(settings),
  });
  return res.json();
}

export async function triggerFix(owner: string, repo: string, issueNumber: number) {
  const res = await fetch(`${BASE}/api/fix/${owner}/${repo}/issues/${issueNumber}`, {
    method: "POST",
    headers: API_KEY ? { Authorization: `Bearer ${API_KEY}` } : {},
  });
  return res.json();
}
