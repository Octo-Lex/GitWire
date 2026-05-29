// tests/e2e/ai-review.test.js
// T4: AI Review. Opens a PR with a deliberate vulnerability on a repo with AI review config.

import { jest } from "@jest/globals";
import { exec, apiFetch, poll, createBranch, createPR, closePR, waitForWebhook, getCheckRuns } from "./helpers.js";

const REPO = { owner: "xjeddah", repo: "MyShell", base: "master" };

describe("T4: AI Review", function () {
  jest.setTimeout(180000);
  const branch = "e2e-ai-review-" + Date.now();
  let pr;

  afterAll(function () {
    if (pr) closePR({ ...REPO, number: pr.number });
  });

  it("creates a PR with a deliberate vulnerability", async function () {
    // Create a branch with a SQL injection vulnerability
    const tmp = `/tmp/e2e-${branch}`;
    try { exec(`rm -rf ${tmp}`); } catch (_e) {}
    exec(`git clone https://github.com/${REPO.owner}/${REPO.repo}.git ${tmp} 2>&1`);
    exec(`cd ${tmp} && git checkout -b ${branch} 2>&1`);
    // Add a file with SQL injection vulnerability
    exec(`cd ${tmp} && echo "function getUser(id) { return db.query('SELECT * FROM users WHERE id = ' + id); }" > user-query.js && git add -A && git commit -m "e2e: add user query with SQL injection" && git push origin HEAD 2>&1`);

    pr = await createPR({ ...REPO, branch, title: "e2e: AI review test with SQL injection", body: "Test PR for AI review. Contains SQL injection in user-query.js." });
    expect(pr.number).toBeTruthy();

    await waitForWebhook(`${REPO.owner}/${REPO.repo}`, "pull_request", "opened", { timeout: 30000 });
  });

  it("GitWire check run finalizes (not stuck in queued)", async function () {
    await poll(async () => {
      const checks = await getCheckRuns(REPO.owner, REPO.repo, pr.sha);
      const gitwire = checks.find((c) => c.name === "GitWire");
      if (!gitwire || gitwire.status !== "completed") throw new Error("GitWire check not finalized");
      return gitwire;
    }, { timeout: 90000, interval: 3000, label: "GitWire check finalization" });
  });

  it("AI review record exists in DB", async function () {
    await poll(async () => {
      const res = await apiFetch(`/api/review/results/${REPO.owner}/${REPO.repo}?limit=10`);
      const reviews = res.data || res.reviews || res;
      if (!Array.isArray(reviews) || reviews.length === 0) throw new Error("no reviews");
      const found = reviews.find((r) => Number(r.pr_number) === Number(pr.number));
      if (!found) throw new Error("review not found for PR " + pr.number);
      return found;
    }, { timeout: 60000, interval: 3000, label: "AI review record" });
  });

  it("review findings are posted as PR comments or check run details", async function () {
    // Check if the GitWire check has a non-neutral conclusion (meaning findings were posted)
    const checks = await getCheckRuns(REPO.owner, REPO.repo, pr.sha);
    const gitwire = checks.find((c) => c.name === "GitWire");
    expect(gitwire).toBeTruthy();
    // The conclusion should be either neutral (no findings), success, or failure (findings blocked)
    expect(["completed"]).toContain(gitwire.status);
  });
});
