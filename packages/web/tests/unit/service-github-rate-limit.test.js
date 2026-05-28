// tests/unit/service-github-rate-limit.test.js
// Unit tests for the GitHub rate limit tracking service.

import {
  parseRateHeaders,
  classifyError,
} from "../../src/services/githubRateLimit.js";

describe("githubRateLimit", function () {
  // ── parseRateHeaders ────────────────────────────────────────────────────

  describe("parseRateHeaders()", function () {
    it("parses valid rate limit headers", function () {
      const result = parseRateHeaders({
        "x-ratelimit-remaining": "4500",
        "x-ratelimit-limit":     "5000",
        "x-ratelimit-reset":     "1700000000",
        "x-ratelimit-resource":  "core",
        "x-ratelimit-used":      "500",
      });
      expect(result).toEqual({
        remaining:  4500,
        limit:      5000,
        resetAt:    1700000000,
        resource:   "core",
        used:       500,
        retryAfter: null,
      });
    });

    it("returns null for missing headers", function () {
      const result = parseRateHeaders({});
      expect(result).toBeNull();
    });

    it("parses Headers-like object with .get() method", function () {
      const headers = {
        get: function (k) {
          const map = {
            "x-ratelimit-remaining": "100",
            "x-ratelimit-limit":     "5000",
            "x-ratelimit-reset":     "1700000000",
          };
          return map[k] || null;
        },
      };
      const result = parseRateHeaders(headers);
      expect(result.remaining).toBe(100);
    });

    it("parses retry-after header", function () {
      const result = parseRateHeaders({
        "x-ratelimit-remaining": "0",
        "x-ratelimit-limit":     "5000",
        "x-ratelimit-reset":     "1700000000",
        "retry-after":           "60",
      });
      expect(result.retryAfter).toBe(60);
    });

    it("defaults resource to 'core'", function () {
      const result = parseRateHeaders({
        "x-ratelimit-remaining": "4500",
        "x-ratelimit-reset":     "1700000000",
      });
      expect(result.resource).toBe("core");
    });
  });

  // ── classifyError ────────────────────────────────────────────────────────

  describe("classifyError()", function () {
    it("401 → global cooldown (token invalid)", function () {
      const result = classifyError(401, {});
      expect(result.scope).toBe("global");
      expect(result.ttlMs).toBe(120_000);
      expect(result.reason).toBe("token_invalid");
    });

    it("403 with remaining=0 → resource cooldown (rate exhausted)", function () {
      const result = classifyError(403, {
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset":     String(Math.floor(Date.now() / 1000) + 30),
        "x-ratelimit-resource":  "core",
      });
      expect(result.scope).toBe("resource:core");
      expect(result.reason).toBe("rate_exhausted");
      expect(result.ttlMs).toBeGreaterThan(0);
    });

    it("403 with remaining>0 → global cooldown (forbidden)", function () {
      const result = classifyError(403, {
        "x-ratelimit-remaining": "4500",
      });
      expect(result.scope).toBe("global");
      expect(result.reason).toBe("forbidden");
    });

    it("429 → resource cooldown (rate limited)", function () {
      const result = classifyError(429, {
        "x-ratelimit-resource": "search",
      });
      expect(result.scope).toBe("resource:search");
      expect(result.reason).toBe("rate_limited");
    });

    it("429 with retry-after → uses retry-after duration", function () {
      const resetAt = Math.floor(Date.now() / 1000) + 60;
      const result = classifyError(429, {
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset":     String(resetAt),
        "x-ratelimit-resource":  "core",
        "retry-after":           "30",
      });
      expect(result.reason).toBe("rate_limited_retry_after");
      expect(result.ttlMs).toBe(30_000);
    });

    it("404 → no cooldown", function () {
      const result = classifyError(404, {});
      expect(result.scope).toBe("none");
      expect(result.ttlMs).toBe(0);
    });

    it("422 → no cooldown", function () {
      const result = classifyError(422, {});
      expect(result.scope).toBe("none");
    });

    it("500 → no cooldown (transient)", function () {
      const result = classifyError(500, {});
      expect(result.scope).toBe("none");
      expect(result.ttlMs).toBe(0);
    });

    it("502 → no cooldown (transient)", function () {
      const result = classifyError(502, {});
      expect(result.scope).toBe("none");
    });

    it("unknown status → no cooldown", function () {
      const result = classifyError(418, {});
      expect(result.scope).toBe("none");
    });
  });
});
