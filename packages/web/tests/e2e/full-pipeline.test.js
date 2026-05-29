// tests/e2e/full-pipeline.test.js
// Full end-to-end test: creates real PRs on GitHub, validates the entire
// GitWire pipeline from webhook delivery through check run finalization.
//
// Track 1 — Unconfigured repo (Elephant-Rock-Lab/Super-Browser):
//   - No .gitwire.yml, no DB gates
//   - GitWire check → completed/neutral
//   - No quality-gate check run
//   - Triage action lifecycle: proposed → approved → executing → succeeded
//
// Track 2 — Configured repo (xjeddah/MyShell):
//   - Has .gitwire.yml with triage enabled
//   - GitWire check → completed (neutral or success depending on AI review config)
//   - Triage action lifecycle: proposed → approved → executing → succeeded
//   - PR classified with type, size label, risk
//
// Prerequisites:
//   - gh CLI authenticated with push access to both repos
//   - GITWIRE_API_KEY set or hardcoded
//   - Production GitWire instance healthy

import { jest } from "@jest/globals";

const API_BASE = process.env.GITWIRE_API_URL || "https://gitwire.erlab.uk";
const API_KEY = process.env.GITWIRE_API_KEY || "5339e850a33c40f292e9e7ef6a70240fa566b21f38544b6d";

// ── Helpers ──────────────────────────────────────────────────────────────────

async function apiFetch(path, opts = {}) {
  const res = await fetch(API_BASE + path, {
    ...opts,
    headers: {
      Authorization: "Bearer " + API_KEY,
      Accept: "application/json",
      ...(opts.headers || {}),
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error("API " + res.status + ": " + body.slice(0, 200));
  }
  return res.json();
}

async function ghApi(path, opts = {}) {
  const res = await fetch("https://api.github.com/" + path.replace(/^\//, ""), {
    ...opts,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: "token " + process.env.GH_TOKEN,
      ...(opts.headers || {}),
    },
  });
  if (!res.status >= 400) {
    const body = await res.text();
    throw new Error("GitHub " + res.status + ": " + body.slice(0, 200));
  }
  return res.json();
}

async function exec(cmd) {
  const { execSync } = await import("child_process");
  return execSync(cmd, { encoding: "utf8" }).trim();
}

async function poll(fn, { timeout = 60000, interval = 3000, label = "poll" } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const result = await fn();
      return result;
    } catch (_e) {
      if (Date.now() - start + interval > timeout) throw _e;
      await new Promise((r) => setTimeout(r, interval));
    }
  }
  throw new Error(label + ": timed out after " + timeout + "ms");
}

// ── Test Suite ───────────────────────────────────────────────────────────────

describe("Full E2E Pipeline", function () {
  jest.setTimeout(300000); // 5 min per test

  const branch = "e2e-test-" + Date.now();
  const repos = {
    unconfigured: { owner: "Elephant-Rock-Lab", repo: "Super-Browser", base: "main" },
    configured:   { owner: "xjeddah", repo: "MyShell", base: "master" },
  };
  const prNumbers = {};
  const prShas = {};

  afterAll(async function () {
    // Cleanup: close PRs and delete branches
    for (const [track, { owner, repo }] of Object.entries(repos)) {
      const prNum = prNumbers[track];
      if (prNum) {
        try { await exec(`gh pr close ${prNum} --repo ${owner}/${repo} --delete-branch 2>&1`); } catch (_e) {}
      }
    }
  });

  // ── Track 1: Unconfigured repo ───────────────────────────────────────────

  describe("Track 1: Unconfigured repo (Super-Browser)", function () {

    it("creates a PR", async function () {
      const { owner, repo, base } = repos.unconfigured;
      await exec(`cd /tmp && rm -rf e2e-super-browser && git clone https://github.com/${owner}/${repo}.git e2e-super-browser 2>&1`);
      await exec(`cd /tmp/e2e-super-browser && git checkout -b ${branch} && echo "" >> README.md && git add README.md && git commit -m "e2e: full pipeline test" && git push origin HEAD 2>&1`);

      const output = await exec(`gh pr create --repo ${owner}/${repo} --head ${branch} --base ${base} --title "e2e: full pipeline test" --body "End-to-end validation of GitWire pipeline on unconfigured repo." 2>&1`);
      const match = output.match(/\/pull\/(\d+)/);
      expect(match).toBeTruthy();
      prNumbers.unconfigured = match[1];

      // Get head SHA
      const sha = await exec(`gh api repos/${owner}/${repo}/pulls/${prNumbers.unconfigured} --jq ".head.sha" 2>&1`);
      prShas.unconfigured = sha;
    });

    it("webhook delivery was recorded", async function () {
      await poll(async () => {
        const res = await apiFetch("/api/webhooks/deliveries?limit=10");
        const deliveries = res.data || res;
        const found = deliveries.find((d) =>
          d.repo === "Elephant-Rock-Lab/Super-Browser" &&
          d.event_name === "pull_request" &&
          d.action === "opened"
        );
        if (!found) throw new Error("webhook delivery not found");
        return found;
      }, { timeout: 30000, interval: 2000, label: "webhook delivery" });
    });

    it("GitWire check run finalized as neutral", async function () {
      const { owner, repo } = repos.unconfigured;
      await poll(async () => {
        const checks = await exec(`gh api repos/${owner}/${repo}/commits/${prShas.unconfigured}/check-runs --jq ".check_runs[] | select(.name == \\"GitWire\\") | .conclusion" 2>&1`);
        if (!checks || checks === "") throw new Error("GitWire check not finalized");
        return checks;
      }, { timeout: 60000, interval: 3000, label: "GitWire check finalization" });

      const check = await exec(`gh api repos/${owner}/${repo}/commits/${prShas.unconfigured}/check-runs --jq ".check_runs[] | select(.name == \\"GitWire\\") | {status, conclusion, title: .output.title}" 2>&1`);
      expect(check).toContain("completed");
      expect(check).toContain("neutral");
      expect(check).toContain("no review needed");
    });

    it("no gitwire/quality-gate check run exists", async function () {
      const { owner, repo } = repos.unconfigured;
      const checks = await exec(`gh api repos/${owner}/${repo}/commits/${prShas.unconfigured}/check-runs --jq ".check_runs[] | select(.name == \\"gitwire/quality-gate\\")" 2>&1`);
      expect(checks).toBe("");
    });

    it("triage action completed lifecycle", async function () {
      await poll(async () => {
        const res = await apiFetch("/api/actions?limit=20");
        const actions = res.data || res;
        const found = actions.find((a) =>
          a.repo_full_name === "Elephant-Rock-Lab/Super-Browser" &&
          a.pillar === "triage" &&
          a.status === "succeeded"
        );
        if (!found) throw new Error("triage action not found");
        return found;
      }, { timeout: 60000, interval: 3000, label: "triage action lifecycle" });
    });
  });

  // ── Track 2: Configured repo ─────────────────────────────────────────────

  describe("Track 2: Configured repo (MyShell)", function () {

    it("creates a PR", async function () {
      const { owner, repo, base } = repos.configured;
      const branch2 = branch + "-myshell";
      await exec(`cd /tmp && rm -rf e2e-myshell && git clone https://github.com/${owner}/${repo}.git e2e-myshell 2>&1`);
      await exec(`cd /tmp/e2e-myshell && git checkout -b ${branch2} && echo "" >> README.md && git add README.md && git commit -m "e2e: full pipeline test" && git push origin HEAD 2>&1`);

      const output = await exec(`gh pr create --repo ${owner}/${repo} --head ${branch2} --base ${base} --title "e2e: full pipeline test" --body "End-to-end validation of GitWire pipeline on configured repo." 2>&1`);
      const match = output.match(/\/pull\/(\d+)/);
      expect(match).toBeTruthy();
      prNumbers.configured = match[1];

      const sha = await exec(`gh api repos/${owner}/${repo}/pulls/${prNumbers.configured} --jq ".head.sha" 2>&1`);
      prShas.configured = sha;
    });

    it("webhook delivery was recorded", async function () {
      await poll(async () => {
        const res = await apiFetch("/api/webhooks/deliveries?limit=10");
        const deliveries = res.data || res;
        const found = deliveries.find((d) =>
          d.repo === "xjeddah/MyShell" &&
          d.event_name === "pull_request" &&
          d.action === "opened"
        );
        if (!found) throw new Error("webhook delivery not found");
        return found;
      }, { timeout: 30000, interval: 2000, label: "webhook delivery" });
    });

    it("GitWire check run finalized", async function () {
      const { owner, repo } = repos.configured;
      await poll(async () => {
        const checks = await exec(`gh api repos/${owner}/${repo}/commits/${prShas.configured}/check-runs --jq ".check_runs[] | select(.name == \\"GitWire\\") | .conclusion" 2>&1`);
        if (!checks || checks === "") throw new Error("GitWire check not finalized");
        return checks;
      }, { timeout: 60000, interval: 3000, label: "GitWire check finalization" });

      const check = await exec(`gh api repos/${owner}/${repo}/commits/${prShas.configured}/check-runs --jq ".check_runs[] | select(.name == \\"GitWire\\") | {status, conclusion}" 2>&1`);
      expect(check).toContain("completed");
    });

    it("triage action completed with classification", async function () {
      const action = await poll(async () => {
        const res = await apiFetch("/api/actions?limit=30");
        const actions = res.data || res;
        const found = actions.find((a) =>
          a.repo_full_name === "xjeddah/MyShell" &&
          a.pillar === "triage" &&
          a.status === "succeeded"
        );
        if (!found) throw new Error("triage action not found");
        return found;
      }, { timeout: 60000, interval: 3000, label: "triage action" });

      expect(action.action_type).toBeTruthy();
      expect(action.evidence).toBeTruthy();
    });
  });
});
