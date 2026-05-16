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

  // Maintainer — governance (new)
  members:         (q = "") => `/api/maintainer/members${q ? `?${q}` : ""}`,
  member:          (login: string) => `/api/maintainer/members/${login}`,
  collabs:         (q = "") => `/api/maintainer/collaborators${q ? `?${q}` : ""}`,
  repoCollabs:     (owner: string, repo: string) => `/api/maintainer/collaborators/${owner}/${repo}`,
  branchRules:     (q = "") => `/api/maintainer/branch-rules${q ? `?${q}` : ""}`,
  repoBranchRules: (owner: string, repo: string) => `/api/maintainer/branch-rules/${owner}/${repo}`,
  auditLog:        (q = "") => `/api/maintainer/audit${q ? `?${q}` : ""}`,

  // Maintainer — stale management (existing)
  maintainerSettings: (owner: string, repo: string) => `/api/maintainer/${owner}/${repo}/settings`,
  maintainerActions:  (owner: string, repo: string, q = "") => `/api/maintainer/${owner}/${repo}/actions${q ? `?${q}` : ""}`,
  maintainerStats:    (owner: string, repo: string) => `/api/maintainer/${owner}/${repo}/stats`,

  // CI Healing
  healStats:     () => `/api/heal/stats`,
  healHistory:   (q = "") => `/api/heal${q ? `?${q}` : ""}`,
  healRepo:      (owner: string, repo: string) => `/api/heal/${owner}/${repo}`,
  healRunDetail: (runId: string) => `/api/heal/run/${runId}`,

  // Fix attempts
  fixAttempts: (owner: string, repo: string, q = "") => `/api/fix/${owner}/${repo}/attempts${q ? `?${q}` : ""}`,
};

// ── Trigger helpers (non-GET) ─────────────────────────────────────────────

function authHeaders(extra?: Record<string, string>): Record<string, string> {
  return {
    ...(API_KEY ? { Authorization: `Bearer ${API_KEY}` } : {}),
    ...extra,
  };
}

export async function triggerRepoSync(owner: string, repo: string) {
  const res = await fetch(`${BASE}/api/repos/${owner}/${repo}/sync`, {
    method: "POST",
    headers: authHeaders(),
  });
  return res.json();
}

export async function retryRun(runId: string) {
  const res = await fetch(`${BASE}/api/ci/${runId}/retry`, {
    method: "POST",
    headers: authHeaders(),
  });
  return res.json();
}

export async function triggerStaleScan(owner: string, repo: string) {
  const res = await fetch(`${BASE}/api/maintainer/${owner}/${repo}/stale-scan`, {
    method: "POST",
    headers: authHeaders(),
  });
  return res.json();
}

export async function triggerBranchCleanup(owner: string, repo: string) {
  const res = await fetch(`${BASE}/api/maintainer/${owner}/${repo}/branch-cleanup`, {
    method: "POST",
    headers: authHeaders(),
  });
  return res.json();
}

export async function updateSettings(owner: string, repo: string, settings: Record<string, unknown>) {
  const res = await fetch(`${BASE}/api/maintainer/${owner}/${repo}/settings`, {
    method: "PATCH",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(settings),
  });
  return res.json();
}

export async function triggerFix(owner: string, repo: string, issueNumber: number) {
  const res = await fetch(`${BASE}/api/fix/${owner}/${repo}/issues/${issueNumber}`, {
    method: "POST",
    headers: authHeaders(),
  });
  return res.json();
}

// ── Governance actions ─────────────────────────────────────────────────────

export async function syncMembers() {
  const res = await fetch(`${BASE}/api/maintainer/members/sync`, {
    method: "POST",
    headers: authHeaders(),
  });
  return res.json();
}

export async function updateCollaborator(owner: string, repo: string, login: string, permission: string, actor = "dashboard") {
  const res = await fetch(`${BASE}/api/maintainer/collaborators/${owner}/${repo}/${login}`, {
    method: "PUT",
    headers: authHeaders({ "Content-Type": "application/json", "x-actor-login": actor }),
    body: JSON.stringify({ permission }),
  });
  return res.json();
}

export async function removeCollaborator(owner: string, repo: string, login: string, actor = "dashboard") {
  const res = await fetch(`${BASE}/api/maintainer/collaborators/${owner}/${repo}/${login}`, {
    method: "DELETE",
    headers: authHeaders({ "x-actor-login": actor }),
  });
  return res.json();
}

export async function updateBranchRule(owner: string, repo: string, pattern: string, rule: Record<string, unknown>, actor = "dashboard") {
  const res = await fetch(
    `${BASE}/api/maintainer/branch-rules/${owner}/${repo}/${encodeURIComponent(pattern)}`,
    {
      method: "PUT",
      headers: authHeaders({ "Content-Type": "application/json", "x-actor-login": actor }),
      body: JSON.stringify(rule),
    }
  );
  return res.json();
}
