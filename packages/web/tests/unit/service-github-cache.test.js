// tests/unit/service-github-cache.test.js
// Unit tests for the GitHub API cache service.

import { classifyRoute, cacheKey } from "../../src/services/githubCache.js";

describe("githubCache", function () {
  // ── classifyRoute ────────────────────────────────────────────────────────

  describe("classifyRoute()", function () {
    it("classifies PR files route", function () {
      const result = classifyRoute("/repos/acme/app/pulls/42/files");
      expect(result.kind).toBe("pulls_files");
      expect(result.ttl).toBe(30);
    });

    it("classifies PR view route", function () {
      const result = classifyRoute("/repos/acme/app/pulls/42");
      expect(result.kind).toBe("pulls");
      expect(result.ttl).toBe(30);
    });

    it("classifies check runs route", function () {
      const result = classifyRoute("/repos/acme/app/commits/abc123/check-runs");
      expect(result.kind).toBe("check_runs");
      expect(result.ttl).toBe(15);
    });

    it("classifies actions runs route", function () {
      const result = classifyRoute("/repos/acme/app/actions/runs");
      expect(result.kind).toBe("actions_runs");
      expect(result.ttl).toBe(15);
    });

    it("classifies issue view route", function () {
      const result = classifyRoute("/repos/acme/app/issues/7");
      expect(result.kind).toBe("issues");
      expect(result.ttl).toBe(60);
    });

    it("classifies bare repo view", function () {
      const result = classifyRoute("/repos/acme/app");
      expect(result.kind).toBe("repositories");
      expect(result.ttl).toBe(300);
    });

    it("classifies git trees route", function () {
      const result = classifyRoute("/repos/acme/app/git/trees/main");
      expect(result.kind).toBe("git_trees");
      expect(result.ttl).toBe(300);
    });

    it("classifies contents route", function () {
      const result = classifyRoute("/repos/acme/app/contents/src/index.js");
      expect(result.kind).toBe("contents");
      expect(result.ttl).toBe(120);
    });

    it("classifies unknown repo sub-resources with repo fallback", function () {
      // Unknown sub-resource falls back to repo view TTL
      const result = classifyRoute("/repos/acme/app/something-unknown");
      expect(result.ttl).toBe(300);
    });

    it("classifies non-repo paths", function () {
      const result = classifyRoute("/orgs/acme/members");
      expect(result.kind).toBe("other");
      expect(result.ttl).toBe(60);
    });
  });

  // ── cacheKey ─────────────────────────────────────────────────────────────

  describe("cacheKey()", function () {
    it("produces deterministic keys for same input", function () {
      const k1 = cacheKey("GET", "/repos/acme/app/pulls/42", { per_page: 100 });
      const k2 = cacheKey("GET", "/repos/acme/app/pulls/42", { per_page: 100 });
      expect(k1).toBe(k2);
    });

    it("produces different keys for different paths", function () {
      const k1 = cacheKey("GET", "/repos/acme/app/pulls/42");
      const k2 = cacheKey("GET", "/repos/acme/app/pulls/43");
      expect(k1).not.toBe(k2);
    });

    it("produces different keys for different methods", function () {
      const k1 = cacheKey("GET", "/repos/acme/app/pulls/42");
      const k2 = cacheKey("POST", "/repos/acme/app/pulls/42");
      // POST methods won't be cached, but keys should still differ
      expect(k1).not.toBe(k2);
    });

    it("ignores query order", function () {
      const k1 = cacheKey("GET", "/path", { a: "1", b: "2" });
      const k2 = cacheKey("GET", "/path", { b: "2", a: "1" });
      expect(k1).toBe(k2);
    });

    it("prefixes with gitwire:ghcache:", function () {
      const k = cacheKey("GET", "/repos/acme/app");
      expect(k.startsWith("gitwire:ghcache:")).toBe(true);
    });
  });
});
