// tests/e2e/issue-fix.test.js
// T5: Issue Fix. Creates an issue, comments /gitwire fix, validates the pipeline.

import { jest } from "@jest/globals";
import { exec, apiFetch, poll, waitForWebhook } from "./helpers.js";

const REPO = { owner: "xjeddah", repo: "MyShell" };

describe("T5: Issue Fix", function () {
  jest.setTimeout(180000);
  let issueNumber;

  afterAll(function () {
    if (issueNumber) {
      try { exec(`gh api repos/${REPO.owner}/${REPO.repo}/issues/${issueNumber} -X PATCH -f state=closed 2>&1`); } catch (_e) {}
    }
  });

  it("creates an issue with fix label", async function () {
    const output = exec(
      `gh api repos/${REPO.owner}/${REPO.repo}/issues -X POST -f title="e2e: fix test - typo in README" -f body="The word 'Wlecome' should be 'Welcome' in README.md line 1." --raw-field labels='["bug"]' 2>&1`
    );
    const parsed = JSON.parse(output);
    issueNumber = parsed.number;
    expect(issueNumber).toBeTruthy();

    await waitForWebhook(`${REPO.owner}/${REPO.repo}`, "issues", "opened", { timeout: 30000 });
  });

  it("comments /gitwire fix to trigger fix pipeline", async function () {
    exec(
      `gh api repos/${REPO.owner}/${REPO.repo}/issues/${issueNumber}/comments -X POST -f body="/gitwire fix" 2>&1`
    );

    await waitForWebhook(`${REPO.owner}/${REPO.repo}`, "issue_comment", "created", { timeout: 30000 });
  });

  it("issue_fix action reaches terminal state", async function () {
    await poll(async () => {
      const res = await apiFetch("/api/actions?limit=30");
      const actions = res.data || res;
      const found = actions.find((a) =>
        a.repo_full_name === `${REPO.owner}/${REPO.repo}` &&
        a.pillar === "issue_fix" &&
        ["succeeded", "failed", "rejected", "cancelled"].includes(a.status)
      );
      if (!found) throw new Error("issue_fix action not found in terminal state");
      return found;
    }, { timeout: 180000, interval: 5000, label: "issue_fix terminal state" });
  });
});
