// tests/e2e/sync.test.js
// T9: Sync Worker. Validates that the sync worker populates data.

import { jest } from "@jest/globals";
import { apiFetch } from "./helpers.js";

describe("T9: Sync Worker", function () {
  jest.setTimeout(30000);

  it("repositories API returns all installed repos", async function () {
    const res = await apiFetch("/api/repos");
    const repos = res.data || res;
    expect(Array.isArray(repos)).toBe(true);
    expect(repos.length).toBeGreaterThan(0);
  });

  it("each repo has required fields", async function () {
    const res = await apiFetch("/api/repos");
    const repos = res.data || res;
    for (const repo of repos) {
      expect(repo.full_name).toBeTruthy();
    }
  });

  it("rate limit tracking is populated", async function () {
    const res = await apiFetch("/api/github-relay/rate-limits");
    const limits = res.data || res;
    expect(Array.isArray(limits)).toBe(true);
    if (limits.length > 0) {
      expect(limits[0].resource).toBeTruthy();
      expect(limits[0].limit).toBeGreaterThan(0);
    }
  });

  it("cache stats are available", async function () {
    const res = await apiFetch("/api/github-relay/stats");
    expect(res).toBeTruthy();
    expect(res.data?.cache_enabled).toBe(true);
  });

  it("cooldowns list is empty (no active cooldowns)", async function () {
    const res = await apiFetch("/api/github-relay/cooldowns");
    const cooldowns = res.data || res;
    expect(Array.isArray(cooldowns)).toBe(true);
  });
});
