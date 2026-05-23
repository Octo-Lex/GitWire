/** GitWire Dashboard — SWR fetcher + typed API hooks */

import useSWR, { type SWRConfiguration } from "swr";

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

// ── useApi: unified data accessor ──────────────────────────────────────────
// Auto-unwraps {data, meta} response shape. Returns typed rows + metadata.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function useApi<T = any>(url: string | null, opts?: SWRConfiguration) {
  const { data, error, isLoading, mutate } = useSWR<any>(url, fetcher, opts);
  // Unwrap {data: [...], meta: {...}} or {data: [...], pagination: {...}} shapes
  const rows: T[] = data?.data ?? data?.rows ?? (Array.isArray(data) ? data : []);
  const meta = data?.meta ?? data?.pagination ?? null;
  const raw = data ?? null;
  return { data: rows, meta, raw, error, isLoading, mutate };
}

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

  // Duplicate detection
  dupStats:     () => `/api/duplicates/stats`,
  duplicates:   (q = "") => `/api/duplicates${q ? `?${q}` : ""}`,
  dupByRepo:    (owner: string, repo: string) => `/api/duplicates/${owner}/${repo}`,
  dupByIssue:   (issueId: string) => `/api/duplicates/issue/${issueId}`,

  // Enforcement (Phase 1)
  enforcementStats:   () => `/api/enforcement/stats`,
  enforcementPolicies: () => `/api/enforcement/policies`,
  enforcementViolations: (q = "") => `/api/enforcement/violations${q ? `?${q}` : ""}`,
  enforcementConfigResults: (q = "") => `/api/enforcement/config-results${q ? `?${q}` : ""}`,

  // Automation (Phase 2)
  queue:          (q = "") => `/api/phase2/queue${q ? `?${q}` : ""}`,
  queueRepo:      (owner: string, repo: string) => `/api/phase2/queue/${owner}/${repo}`,
  feedbackRules:  () => `/api/phase2/feedback`,
  telemetrySummary:  () => `/api/phase2/telemetry/summary`,
  telemetryEvents:   (q = "") => `/api/phase2/telemetry/events${q ? `?${q}` : ""}`,
  telemetryThroughput: () => `/api/phase2/telemetry/throughput`,
  telemetryCiHealth:  () => `/api/phase2/telemetry/ci-health`,
  rollbacks:      (q = "") => `/api/phase2/rollbacks${q ? `?${q}` : ""}`,

  // Trust (Phase 3)
  flakyStats:     () => `/api/phase3/flaky/stats`,
  flakyTests:     (q = "") => `/api/phase3/flaky${q ? `?${q}` : ""}`,
  flakyRepo:      (owner: string, repo: string) => `/api/phase3/flaky/${owner}/${repo}`,
  reconcilerRuns: () => `/api/phase3/reconciler/runs`,
  reconcilerRepos: (q = "") => `/api/phase3/reconciler/repos${q ? `?${q}` : ""}`,
  depStats:       () => `/api/phase3/dependencies/stats`,
  depVulns:       (q = "") => `/api/phase3/dependencies/vulnerabilities${q ? `?${q}` : ""}`,
  depRepo:        (owner: string, repo: string) => `/api/phase3/dependencies/${owner}/${repo}`,

  // Intelligence & Compliance (Phase 4)
  reviewStats:      () => `/api/review/stats`,
  reviewResults:    (q = "") => `/api/review/results${q ? `?${q}` : ""}`,
  reviewRepoResults: (owner: string, repo: string) => `/api/review/results/${owner}/${repo}`,
  reviewConfig:     (owner: string, repo: string) => `/api/review/config/${owner}/${repo}`,
  reviewTrigger:    (owner: string, repo: string, pr: number) => `/api/review/trigger/${owner}/${repo}/${pr}`,
  auditStats:       (days = 30) => `/api/audit/stats?days=${days}`,
  auditEntries:     (q = "") => `/api/audit/entries${q ? `?${q}` : ""}`,
  auditVerify:      () => `/api/audit/verify`,
  auditExport:      () => `/api/audit/export`,
  auditReports:     (q = "") => `/api/audit/reports${q ? `?${q}` : ""}`,
  auditReport:      (id: number) => `/api/audit/reports/${id}`,

  // Config (.gitwire.yml overrides)
  repoConfig:       (owner: string, repo: string) => `/api/config/${owner}/${repo}`,

  // Decisions
  decisions:        (q = "") => `/api/decisions${q ? `?${q}` : ""}`,
  decisionsSummary: () => `/api/decisions/summary`,

  // Waivers
  waivers:          (repo: string, q = "") => `/api/waivers?repo=${encodeURIComponent(repo)}${q ? `&${q}` : ""}`,
  waiverCheck:      (repo: string, pillar: string, scope = "", scopeValue = "") =>
    `/api/waivers/check?repo=${encodeURIComponent(repo)}&pillar=${pillar}${scope ? `&scope=${scope}` : ""}${scopeValue ? `&scopeValue=${scopeValue}` : ""}`,

  // Activity Feed
  activity:         (q = "") => `/api/activity${q ? `?${q}` : ""}`,
  activitySummary:  () => `/api/activity/summary`,

  // Readiness
  readiness:        () => `/api/readiness`,
  readinessRepo:    (owner: string, repo: string) => `/api/readiness/${owner}/${repo}`,

  // Quality Gates
  gates:             () => `/api/gates`,
  gatesRepo:         (owner: string, repo: string) => `/api/gates/${owner}/${repo}`,
  gatesEvaluate:     (owner: string, repo: string) => `/api/gates/${owner}/${repo}/evaluate`,
  gatesHistory:      (owner: string, repo: string, q = "") => `/api/gates/${owner}/${repo}/history${q ? `?${q}` : ""}`,
  gatesMetrics:      (owner: string, repo: string) => `/api/gates/${owner}/${repo}/metrics`,
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

// ── Duplicate detection actions ────────────────────────────────────────────

export async function confirmDuplicate(signalId: number) {
  const res = await fetch(`${BASE}/api/duplicates/${signalId}/confirm`, {
    method: "POST",
    headers: authHeaders(),
  });
  return res.json();
}

export async function dismissDuplicate(signalId: number) {
  const res = await fetch(`${BASE}/api/duplicates/${signalId}/dismiss`, {
    method: "POST",
    headers: authHeaders(),
  });
  return res.json();
}

export async function triggerEmbeddingBackfill(owner: string, repo: string) {
  const res = await fetch(`${BASE}/api/duplicates/backfill/${owner}/${repo}`, {
    method: "POST",
    headers: authHeaders(),
  });
  return res.json();
}

// ── Enforcement actions (Phase 1) ──────────────────────────────────────────

export async function createPolicy(policy: Record<string, unknown>) {
  const res = await fetch(`${BASE}/api/enforcement/policies`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(policy),
  });
  return res.json();
}

export async function updatePolicy(id: number, updates: Record<string, unknown>) {
  const res = await fetch(`${BASE}/api/enforcement/policies/${id}`, {
    method: "PUT",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(updates),
  });
  return res.json();
}

export async function deletePolicy(id: number) {
  const res = await fetch(`${BASE}/api/enforcement/policies/${id}`, {
    method: "DELETE",
    headers: authHeaders(),
  });
  return res.json();
}

export async function suppressViolation(id: number) {
  const res = await fetch(`${BASE}/api/enforcement/violations/${id}/suppress`, {
    method: "POST",
    headers: authHeaders(),
  });
  return res.json();
}

export async function triggerEnforcementRun(repo?: string) {
  const res = await fetch(`${BASE}/api/enforcement/run`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ repo }),
  });
  return res.json();
}

// ── Automation actions (Phase 2) ──────────────────────────────────────────

export async function updateQueueConfig(owner: string, repo: string, config: Record<string, unknown>) {
  const res = await fetch(`${BASE}/api/phase2/queue/${owner}/${repo}/config`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(config),
  });
  return res.json();
}

export async function dequeuePR(owner: string, repo: string, pr: number) {
  const res = await fetch(`${BASE}/api/phase2/queue/${owner}/${repo}/${pr}/remove`, {
    method: "POST",
    headers: authHeaders(),
  });
  return res.json();
}

export async function createFeedbackRule(rule: Record<string, unknown>) {
  const res = await fetch(`${BASE}/api/phase2/feedback`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(rule),
  });
  return res.json();
}

export async function updateFeedbackRule(id: number, updates: Record<string, unknown>) {
  const res = await fetch(`${BASE}/api/phase2/feedback/${id}`, {
    method: "PUT",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(updates),
  });
  return res.json();
}

export async function deleteFeedbackRule(id: number) {
  const res = await fetch(`${BASE}/api/phase2/feedback/${id}`, {
    method: "DELETE",
    headers: authHeaders(),
  });
  return res.json();
}

// ── Trust actions (Phase 3) ──────────────────────────────────────────────

export async function graduateTest(id: number) {
  const res = await fetch(`${BASE}/api/phase3/flaky/${id}/graduate`, {
    method: "POST",
    headers: authHeaders(),
  });
  return res.json();
}

export async function dismissTest(id: number) {
  const res = await fetch(`${BASE}/api/phase3/flaky/${id}/dismiss`, {
    method: "POST",
    headers: authHeaders(),
  });
  return res.json();
}

export async function triggerReconciliation(repo?: string) {
  const res = await fetch(`${BASE}/api/phase3/reconciler/run`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ repo }),
  });
  return res.json();
}

export async function updateRepoReconcileConfig(owner: string, repo: string, updates: Record<string, unknown>) {
  const res = await fetch(`${BASE}/api/phase3/reconciler/repos/${owner}/${repo}`, {
    method: "PUT",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(updates),
  });
  return res.json();
}

export async function triggerDepScan(owner: string, repo: string) {
  const res = await fetch(`${BASE}/api/phase3/dependencies/${owner}/${repo}/scan`, {
    method: "POST",
    headers: authHeaders(),
  });
  return res.json();
}

export async function openBatchDepPR(owner: string, repo: string, ecosystem = "npm") {
  const res = await fetch(`${BASE}/api/phase3/dependencies/${owner}/${repo}/batch-pr`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ ecosystem }),
  });
  return res.json();
}

export async function dismissVuln(id: number, reason?: string) {
  const res = await fetch(`${BASE}/api/phase3/dependencies/vuln/${id}/dismiss`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ reason }),
  });
  return res.json();
}

// ── Intelligence & Compliance actions (Phase 4) ──────────────────────────

export async function updateReviewConfig(owner: string, repo: string, config: Record<string, unknown>) {
  const res = await fetch(`${BASE}/api/review/config/${owner}/${repo}`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(config),
  });
  return res.json();
}

export async function triggerReview(owner: string, repo: string, pr: number) {
  const res = await fetch(`${BASE}/api/review/trigger/${owner}/${repo}/${pr}`, {
    method: "POST",
    headers: authHeaders(),
  });
  return res.json();
}

export async function verifyAuditChain() {
  const res = await fetch(`${BASE}/api/audit/verify`, {
    headers: authHeaders(),
  });
  return res.json();
}

export async function generateComplianceReport(reportType: string, from: string, to: string) {
  const res = await fetch(`${BASE}/api/audit/reports`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ report_type: reportType, from, to, generated_by: "dashboard" }),
  });
  return res.json();
}

// ── Config actions (.gitwire.yml overrides) ────────────────────────────────

export async function getRepoConfig(owner: string, repo: string) {
  const res = await fetch(`${BASE}/api/config/${owner}/${repo}`, {
    headers: authHeaders(),
  });
  return res.json();
}

export async function updateRepoConfig(owner: string, repo: string, overrides: Record<string, unknown>) {
  const res = await fetch(`${BASE}/api/config/${owner}/${repo}`, {
    method: "PUT",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(overrides),
  });
  return res.json();
}

export async function patchRepoConfig(owner: string, repo: string, patch: Record<string, unknown>) {
  const res = await fetch(`${BASE}/api/config/${owner}/${repo}`, {
    method: "PATCH",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(patch),
  });
  return res.json();
}

export async function resetRepoConfig(owner: string, repo: string) {
  const res = await fetch(`${BASE}/api/config/${owner}/${repo}`, {
    method: "DELETE",
    headers: authHeaders(),
  });
  return res.json();
}

export async function getConfigHistory(owner: string, repo: string, limit = 20) {
  const res = await fetch(`${BASE}/api/config/${owner}/${repo}/history?limit=${limit}`, {
    headers: authHeaders(),
  });
  return res.json();
}

export async function restoreConfigVersion(owner: string, repo: string, historyId: number) {
  const res = await fetch(`${BASE}/api/config/${owner}/${repo}/restore/${historyId}`, {
    method: "POST",
    headers: authHeaders(),
  });
  return res.json();
}

// ── Waiver actions ────────────────────────────────────────────────────────

export async function grantWaiver(repo: string, pillar: string, scope: string, scopeValue: string, reason: string, grantedBy: string, expiresAt?: string) {
  const res = await fetch(`${BASE}/api/waivers`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ repo, pillar, scope, scopeValue, reason, grantedBy, expiresAt }),
  });
  return res.json();
}

export async function revokeWaiver(id: number, revokedBy = "dashboard") {
  const res = await fetch(`${BASE}/api/waivers/${id}`, {
    method: "DELETE",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ revokedBy }),
  });
  return res.json();
}

// ── Activity Feed ──────────────────────────────────────────────────────────

export async function getActivity(params = "") {
  const res = await fetch(`${BASE}/api/activity${params ? "?" + params : ""}`, {
    headers: authHeaders(),
  });
  return res.json();
}

export async function getActivitySummary(since?: string) {
  const params = since ? `?since=${since}` : "";
  const res = await fetch(`${BASE}/api/activity/summary${params}`, {
    headers: authHeaders(),
  });
  return res.json();
}

// ── Readiness Scores ───────────────────────────────────────────────────────

export async function getReadiness() {
  const res = await fetch(`${BASE}/api/readiness`, {
    headers: authHeaders(),
  });
  return res.json();
}

export async function getRepoReadiness(owner: string, repo: string) {
  const res = await fetch(`${BASE}/api/readiness/${owner}/${repo}`, {
    headers: authHeaders(),
  });
  return res.json();
}

// ── Quality Gates ────────────────────────────────────────────────────────

export async function evaluateGates(owner: string, repo: string, headSha?: string, prNumber?: number) {
  const res = await fetch(`${BASE}/api/gates/${owner}/${repo}/evaluate`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ head_sha: headSha, pr_number: prNumber }),
  });
  return res.json();
}

export async function createGate(owner: string, repo: string, name: string, conditions: Array<{metric: string, operator: string, threshold: number}>, blockOnFail = true) {
  const res = await fetch(`${BASE}/api/gates/${owner}/${repo}`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ name, conditions, block_on_fail: blockOnFail }),
  });
  return res.json();
}

export async function deleteGate(owner: string, repo: string, name: string) {
  const res = await fetch(`${BASE}/api/gates/${owner}/${repo}/${encodeURIComponent(name)}`, {
    method: "DELETE",
    headers: authHeaders(),
  });
  return res.json();
}
