// tests/e2e/api-relay.test.js
// A5: GitHub Relay API. Tests cache stats, rate limits, cooldowns.

import { jest } from "@jest/globals";
import { apiFetch } from "./helpers.js";

describe("A5: GitHub Relay API", function () {
  jest.setTimeout(15000);

  it("GET /api/github-relay/stats returns cache statistics", async function () {
    const res = await apiFetch("/api/github-relay/stats");
    expect(res.data.cache_enabled).toBe(true);
    expect(typeof res.data.cache_keys).toBe("number");
  });

  it("GET /api/github-relay/rate-limits returns rate limit data", async function () {
    const res = await apiFetch("/api/github-relay/rate-limits");
    const limits = res.data || res;
    expect(Array.isArray(limits)).toBe(true);
    if (limits.length > 0) {
      const core = limits[0];
      expect(core.resource).toBe("core");
      expect(core.limit).toBeGreaterThan(0);
      expect(core.remaining).toBeGreaterThanOrEqual(0);
      expect(typeof core.used).toBe("number");
    }
  });

  it("GET /api/github-relay/cooldowns returns cooldown list", async function () {
    const res = await apiFetch("/api/github-relay/cooldowns");
    const cooldowns = res.data || res;
    expect(Array.isArray(cooldowns)).toBe(true);
  });
});
