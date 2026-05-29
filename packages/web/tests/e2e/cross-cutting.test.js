// tests/e2e/cross-cutting.test.js
// X1-X4: Cross-cutting concerns — sanitization, rate limits, check dedup, provenance.

import { jest } from "@jest/globals";
import { apiFetch, exec, createBranch, createPR, closePR, waitForWebhook, getCheckRuns, poll } from "./helpers.js";

describe("X1: Webhook Payload Sanitization", function () {
  jest.setTimeout(60000);

  it("webhook delivery list has safe metadata (no raw payload)", async function () {
    const res = await apiFetch("/api/webhooks/deliveries?limit=20");
    const deliveries = res.data || res;
    expect(deliveries.length).toBeGreaterThan(0);
    // List endpoint returns safe metadata — no raw payload fields exposed
    for (const d of deliveries.slice(0, 5)) {
      expect(typeof d.event_name).toBe("string");
      expect(typeof d.repo).toBe("string");
      expect(typeof d.processed).toBe("boolean");
      // Raw payload is not included in list view
      expect(d.payload).toBeUndefined();
    }
  });
});

describe("X3: Check Run No-Duplicate", function () {
  jest.setTimeout(120000);

  it("opening a PR creates exactly one GitWire check run", async function () {
    const REPO = { owner: "Elephant-Rock-Lab", repo: "Super-Browser", base: "main" };
    const branch = "e2e-dedup-" + Date.now();
    let pr;
    try {
      await createBranch({ ...REPO, branch, commitMsg: "e2e: check dedup" });
      pr = await createPR({ ...REPO, branch, title: "e2e: check dedup" });

      await poll(async () => {
        const checks = await getCheckRuns(REPO.owner, REPO.repo, pr.sha);
        const gitwire = checks.filter((c) => c.name === "GitWire");
        if (gitwire.length === 0) throw new Error("no GitWire check yet");
        return gitwire;
      }, { timeout: 60000, interval: 3000, label: "GitWire check" });

      const checks = await getCheckRuns(REPO.owner, REPO.repo, pr.sha);
      const gitwire = checks.filter((c) => c.name === "GitWire");
      expect(gitwire.length).toBe(1);
    } finally {
      if (pr) closePR({ ...REPO, number: pr.number });
    }
  });
});

describe("X4: Quality Gate Opt-In Provenance", function () {
  jest.setTimeout(120000);

  it("unconfigured repo gets no quality gate check run", async function () {
    const REPO = { owner: "Elephant-Rock-Lab", repo: "Super-Browser", base: "main" };
    const branch = "e2e-provenance-" + Date.now();
    let pr;
    try {
      await createBranch({ ...REPO, branch, commitMsg: "e2e: provenance" });
      pr = await createPR({ ...REPO, branch, title: "e2e: provenance" });

      // Wait for GitWire check to finalize
      await poll(async () => {
        const checks = await getCheckRuns(REPO.owner, REPO.repo, pr.sha);
        const gitwire = checks.find((c) => c.name === "GitWire");
        if (!gitwire || gitwire.status !== "completed") throw new Error("not done");
        return gitwire;
      }, { timeout: 60000, interval: 3000, label: "GitWire check" });

      const checks = await getCheckRuns(REPO.owner, REPO.repo, pr.sha);
      const qg = checks.find((c) => c.name === "gitwire/quality-gate");
      expect(qg).toBeUndefined();
    } finally {
      if (pr) closePR({ ...REPO, number: pr.number });
    }
  });
});
