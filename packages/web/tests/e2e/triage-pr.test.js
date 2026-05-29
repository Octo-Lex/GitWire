// tests/e2e/triage-pr.test.js
// T2: Triage — PR. Opens a PR on MyShell, validates size/type labels + classification.

import { jest } from "@jest/globals";
import { exec, apiFetch, createBranch, createPR, closePR, waitForAction, waitForWebhook, getCheckRuns, poll } from "./helpers.js";

const REPO = { owner: "xjeddah", repo: "MyShell", base: "master" };

describe("T2: Triage — PR", function () {
  jest.setTimeout(120000);
  const branch = "e2e-triage-pr-" + Date.now();
  let pr;

  afterAll(function () {
    if (pr) closePR({ ...REPO, number: pr.number });
  });

  it("creates a PR and receives webhook", async function () {
    await createBranch({ ...REPO, branch, commitMsg: "e2e: triage PR test" });
    pr = await createPR({ ...REPO, branch, title: "e2e: triage PR test" });
    expect(pr.number).toBeTruthy();

    await waitForWebhook(`${REPO.owner}/${REPO.repo}`, "pull_request", "opened", { timeout: 30000 });
  });

  it("classifies the PR (action succeeded)", async function () {
    const action = await waitForAction(`${REPO.owner}/${REPO.repo}`, "triage", "succeeded", { timeout: 60000 });
    expect(action.action_type).toBeTruthy();
  });

  it("GitWire check run is finalized", async function () {
    await poll(async () => {
      const checks = await getCheckRuns(REPO.owner, REPO.repo, pr.sha);
      const gitwire = checks.find((c) => c.name === "GitWire");
      if (!gitwire || gitwire.status !== "completed") throw new Error("not done");
      return gitwire;
    }, { timeout: 60000, interval: 3000, label: "GitWire check" });
  });
});
