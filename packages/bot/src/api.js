// packages/bot/src/api.js
// GitWire REST API client — all calls go through the existing backend.

const API_BASE = process.env.GITWIRE_API_URL || "http://gitwire-app:3000";

/**
 * Call GitWire API with the user's stored API key.
 */
async function callApi(apiKey, path, options = {}) {
  const url = `${API_BASE}${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      ...(options.headers || {}),
      Authorization: `Bearer ${apiKey}`,
      ...(options.body ? { "Content-Type": "application/json" } : {}),
    },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "Unknown error");
    throw new Error(`API ${res.status}: ${text.slice(0, 200)}`);
  }

  return res.json();
}

// ── Convenience wrappers ────────────────────────────────────────────────────

export function getHealth(apiKey) {
  return callApi(apiKey, "/health");
}

export function getInsights(apiKey) {
  return callApi(apiKey, "/api/insights/overview");
}

export function getRepos(apiKey) {
  return callApi(apiKey, "/api/repos");
}

export function getRepo(apiKey, owner, repo) {
  return callApi(apiKey, `/api/repos/${owner}/${repo}`);
}

export function getReadiness(apiKey) {
  return callApi(apiKey, "/api/readiness");
}

export function getRepoReadiness(apiKey, owner, repo) {
  return callApi(apiKey, `/api/readiness/${owner}/${repo}`);
}

export function getGates(apiKey) {
  return callApi(apiKey, "/api/gates");
}

export function getGatesForRepo(apiKey, owner, repo) {
  return callApi(apiKey, `/api/gates/${owner}/${repo}`);
}

export function evaluateGates(apiKey, owner, repo) {
  return callApi(apiKey, `/api/gates/${owner}/${repo}/evaluate`, { method: "POST" });
}

export function getGateMetrics(apiKey, owner, repo) {
  return callApi(apiKey, `/api/gates/${owner}/${repo}/metrics`);
}

export function getDeliveryStats(apiKey) {
  return callApi(apiKey, "/api/webhooks/deliveries/stats");
}

export function getDeliveryEvents(apiKey) {
  return callApi(apiKey, "/api/webhooks/deliveries/events");
}

export function getDeliveries(apiKey, limit = 10) {
  return callApi(apiKey, `/api/webhooks/deliveries?limit=${limit}`);
}

export function getDecisions(apiKey, limit = 10) {
  return callApi(apiKey, `/api/decisions?limit=${limit}`);
}

export function getDecisionSummary(apiKey) {
  return callApi(apiKey, "/api/decisions/summary");
}

export function getRepoConfig(apiKey, owner, repo) {
  return callApi(apiKey, `/api/config/${owner}/${repo}`);
}

export function getIssues(apiKey, limit = 10) {
  return callApi(apiKey, `/api/issues?limit=${limit}`);
}

export function getActivity(apiKey, limit = 10) {
  return callApi(apiKey, `/api/activity?limit=${limit}`);
}

export function getActivitySummary(apiKey) {
  return callApi(apiKey, "/api/activity/summary");
}

export function getWaivers(apiKey) {
  return callApi(apiKey, "/api/waivers");
}

export function triggerSync(apiKey, owner, repo) {
  return callApi(apiKey, `/api/repos/${owner}/${repo}/sync`, { method: "POST" });
}

export function triggerFix(apiKey, owner, repo, issueNumber) {
  return callApi(apiKey, `/api/fix/${owner}/${repo}/issues/${issueNumber}`, { method: "POST" });
}
