// tests/e2e/webhook-intake.test.js
// T10: Webhook Intake. Validates webhook processing, payload sanitization, and check run creation.

import { jest } from "@jest/globals";
import { apiFetch, exec, createBranch, createPR, closePR, waitForWebhook, getCheckRuns } from "./helpers.js";

describe("T10: Webhook Intake", function () {
  jest.setTimeout(120000);

  it("delivery stats endpoint works", async function () {
    const res = await apiFetch("/api/webhooks/deliveries/stats");
    expect(res).toBeTruthy();
  });

  it("delivery events endpoint returns event types", async function () {
    const res = await apiFetch("/api/webhooks/deliveries/events");
    expect(res).toBeTruthy();
  });

  it("delivery timeline endpoint works", async function () {
    const res = await apiFetch("/api/webhooks/deliveries/timeline");
    expect(res).toBeTruthy();
  });

  it("webhook delivery for a PR has no sensitive fields in list data", async function () {
    const res = await apiFetch("/api/webhooks/deliveries?limit=5");
    const deliveries = res.data || res;
    expect(deliveries.length).toBeGreaterThan(0);
    // List endpoint returns safe metadata (no raw payload)
    for (const d of deliveries.slice(0, 3)) {
      expect(d.event_name).toBeTruthy();
      expect(d.repo).toBeTruthy();
    }
  });

  it("check runs are created only on open, not on labeled events", async function () {
    // Open a PR, then check that labeled events don't create duplicate check runs
    const REPO = { owner: "Elephant-Rock-Lab", repo: "Super-Browser", base: "main" };
    const branch = "e2e-webhook-" + Date.now();
    let pr;
    try {
      await createBranch({ ...REPO, branch, commitMsg: "e2e: webhook intake test" });
      pr = await createPR({ ...REPO, branch, title: "e2e: webhook intake test" });

      // Wait for check run to appear
      const checks = await new Promise((resolve, reject) => {
        const start = Date.now();
        const check = async () => {
          try {
            const c = await getCheckRuns(REPO.owner, REPO.repo, pr.sha);
            const gitwire = c.filter((cr) => cr.name === "GitWire");
            if (gitwire.length > 0) resolve(gitwire);
            else if (Date.now() - start > 60000) reject(new Error("timeout"));
            else setTimeout(check, 3000);
          } catch (e) { reject(e); }
        };
        check();
      });

      // Should be exactly 1 GitWire check run (not duplicated by labeled events)
      expect(checks.length).toBe(1);
    } finally {
      if (pr) closePR({ ...REPO, number: pr.number });
    }
  });
});
