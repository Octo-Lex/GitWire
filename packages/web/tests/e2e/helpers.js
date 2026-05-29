// tests/e2e/helpers.js
// Shared utilities for E2E tests.

import { execSync } from "child_process";

export const API_BASE = process.env.GITWIRE_API_URL || "https://gitwire.erlab.uk";
export const API_KEY = process.env.GITWIRE_API_KEY || "5339e850a33c40f292e9e7ef6a70240fa566b21f38544b6d";

export async function apiFetch(path, opts = {}) {
  const res = await fetch(API_BASE + path, {
    ...opts,
    headers: {
      Authorization: "Bearer " + API_KEY,
      Accept: "application/json",
      "Content-Type": "application/json",
      ...(opts.headers || {}),
    },
  });
  const body = await res.text();
  if (!res.ok) {
    throw new Error("API " + res.status + ": " + body.slice(0, 300));
  }
  try { return JSON.parse(body); } catch (_e) { return body; }
}

export function exec(cmd) {
  return execSync(cmd, { encoding: "utf8", timeout: 30000 }).trim();
}

export async function poll(fn, { timeout = 60000, interval = 3000, label = "poll" } = {}) {
  const start = Date.now();
  let lastErr;
  while (Date.now() - start < timeout) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (Date.now() - start + interval > timeout) break;
      await new Promise((r) => setTimeout(r, interval));
    }
  }
  throw new Error(label + ": timed out after " + timeout + "ms — " + (lastErr ? lastErr.message : ""));
}

export async function createPR({ owner, repo, branch, base, title, body }) {
  const output = exec(
    `gh pr create --repo ${owner}/${repo} --head ${branch} --base ${base} --title "${title}" --body "${body || title}" 2>&1`
  );
  const match = output.match(/\/pull\/(\d+)/);
  if (!match) throw new Error("PR creation failed: " + output);
  const number = match[1];
  const sha = exec(`gh api repos/${owner}/${repo}/pulls/${number} --jq ".head.sha" 2>&1`);
  return { number, sha };
}

export async function closePR({ owner, repo, number }) {
  try {
    exec(`gh pr close ${number} --repo ${owner}/${repo} --delete-branch --yes 2>&1`);
  } catch (_e) { /* already closed */ }
}

export async function createBranch({ owner, repo, base, branch, changeFile, changeContent, commitMsg }) {
  const tmp = "/tmp/e2e-" + branch;
  try { exec(`rm -rf ${tmp}`); } catch (_e) {}
  exec(`git clone https://github.com/${owner}/${repo}.git ${tmp} 2>&1`);
  exec(`cd ${tmp} && git checkout -b ${branch} 2>&1`);
  if (changeFile && changeContent) {
    exec(`cd ${tmp} && echo '${changeContent}' > ${changeFile} 2>&1`);
    exec(`cd ${tmp} && git add -A && git commit -m "${commitMsg || 'e2e test'}" 2>&1`);
  } else {
    // Trivial change
    exec(`cd ${tmp} && echo "" >> README.md && git add -A && git commit -m "${commitMsg || 'e2e test'}" 2>&1`);
  }
  exec(`cd ${tmp} && git push origin HEAD 2>&1`);
  return tmp;
}

export async function waitForAction(repoFullName, pillar, status, { timeout = 60000 } = {}) {
  return poll(async () => {
    const res = await apiFetch("/api/actions?limit=30");
    const actions = res.data || res;
    const found = actions.find((a) =>
      a.repo_full_name === repoFullName &&
      a.pillar === pillar &&
      a.status === status
    );
    if (!found) throw new Error(`${pillar} action with status ${status} not found`);
    return found;
  }, { timeout, interval: 2000, label: `${pillar} action ${status}` });
}

export async function waitForWebhook(repo, eventName, action, { timeout = 30000 } = {}) {
  return poll(async () => {
    const res = await apiFetch("/api/webhooks/deliveries?limit=20");
    const deliveries = res.data || res;
    const found = deliveries.find((d) =>
      d.repo === repo && d.event_name === eventName && d.action === action
    );
    if (!found) throw new Error(`${eventName} ${action} webhook not found`);
    return found;
  }, { timeout, interval: 2000, label: `webhook ${eventName} ${action}` });
}

export async function getCheckRuns(owner, repo, sha) {
  const raw = exec(`gh api repos/${owner}/${repo}/commits/${sha}/check-runs --jq ".check_runs" 2>&1`);
  return JSON.parse(raw);
}
