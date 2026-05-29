// tests/e2e/api-readiness.test.js
// A6: Readiness API.

import { jest } from "@jest/globals";
import { apiFetch } from "./helpers.js";

describe("A6: Readiness API", function () {
  jest.setTimeout(15000);

  it("GET /api/readiness returns fleet readiness", async function () {
    const res = await apiFetch("/api/readiness");
    expect(res.total_repos).toBeGreaterThan(0);
    expect(res.average_score).toBeGreaterThanOrEqual(0);
  });

  it("GET /api/readiness/:owner/:repo returns repo detail", async function () {
    const res = await apiFetch("/api/readiness/xjeddah/MyShell");
    expect(res.repo).toBe("xjeddah/MyShell");
    expect(res.score).toBeGreaterThanOrEqual(0);
    expect(res.checks).toBeTruthy();
  });
});
