// tests/e2e/api-gates.test.js
// A4: Quality Gates API. Tests CRUD, evaluation, and provenance.

import { jest } from "@jest/globals";
import { apiFetch } from "./helpers.js";

describe("A4: Quality Gates API", function () {
  jest.setTimeout(30000);
  let gateName;

  afterAll(async function () {
    if (gateName) {
      try { await apiFetch(`/api/gates/xjeddah/MyShell/${gateName}`, { method: "DELETE" }); } catch (_e) {}
    }
  });

  it("GET /api/gates returns fleet summary", async function () {
    const res = await apiFetch("/api/gates");
    expect(res).toHaveProperty("total_repos");
    expect(res).toHaveProperty("repos");
  });

  it("GET /api/gates/:owner/:repo returns repo gates", async function () {
    const res = await apiFetch("/api/gates/xjeddah/MyShell");
    expect(res).toHaveProperty("gates");
    expect(res).toHaveProperty("total");
  });

  it("unconfigured repo has zero gates", async function () {
    const res = await apiFetch("/api/gates/Elephant-Rock-Lab/Super-Browser");
    expect(res.gates).toEqual([]);
    expect(res.total).toBe(0);
  });

  it("POST creates a gate", async function () {
    gateName = "e2e-test-gate-" + Date.now();
    const res = await apiFetch("/api/gates/xjeddah/MyShell", {
      method: "POST",
      body: JSON.stringify({
        name: gateName,
        conditions: [{ metric: "ci_failure_rate_7d", operator: "<", threshold: 0.5 }],
        block_on_fail: false,
      }),
    });
    expect(res).toBeTruthy();
  });

  it("GET /api/gates/:owner/:repo/metrics returns metrics", async function () {
    const res = await apiFetch("/api/gates/xjeddah/MyShell/metrics");
    expect(res).toBeTruthy();
  });

  it("DELETE removes the gate", async function () {
    if (gateName) {
      const res = await apiFetch(`/api/gates/xjeddah/MyShell/${gateName}`, { method: "DELETE" });
      expect(res).toBeTruthy();
      gateName = null;
    }
  });
});
