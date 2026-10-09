// tests/unit/rate-limiter-behavior.test.js
// #425 Unit C (v2): pin the rate limiter's EXISTING behavior (test-only —
// the Redis fail-open is documented here, deliberately NOT changed; altering
// it is an availability decision reserved to a separate authorization):
//   - applicable API requests are limited; the 121st request in the window
//     gets HTTP 429 with Retry-After; the first hit in a window arms the TTL
//   - /health and /webhooks paths are excluded
//   - Bearer credentials supply the limiter identity; requests without them
//     fall back to IP identity
//   - Redis failures currently ALLOW requests through (fail-open), logged
//
// REPRODUCER (records a KNOWN DEFECT; does NOT fix it — production limiter
// remediation is a separate decision): the limiter slices the Authorization
// header WITHOUT checking the scheme. apiKeyAuth accepts session-cookie
// authentication when the Authorization header is absent OR not Bearer. A
// session-authenticated caller can therefore rotate arbitrary non-Bearer
// Authorization values ("Basic xyz-1", "Basic xyz-2", …) to get a FRESH
// rate bucket per request while authenticating as the same session —
// defeating the intended per-IP fallback limit for cookie traffic.

import { jest } from "@jest/globals";

const redisState = { counts: new Map(), failWith: null };
const mockLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
};

jest.unstable_mockModule("../../src/lib/queue.js", () => ({
  redis: {
    incr: jest.fn(async (key) => {
      if (redisState.failWith) throw redisState.failWith;
      const next = (redisState.counts.get(key) ?? 0) + 1;
      redisState.counts.set(key, next);
      return next;
    }),
    pexpire: jest.fn(async () => 1),
    get: jest.fn(async (key) => {
      // Session store for the apiKeyAuth chain in the reproducer.
      if (key.startsWith("gitwire:session:")) {
        return key.endsWith(":valid-session") ? JSON.stringify({ principal: "session-user" }) : null;
      }
      return null;
    }),
    expire: jest.fn(async () => 1),
  },
}));
jest.unstable_mockModule("../../src/lib/logger.js", () => ({ logger: mockLogger }));
jest.unstable_mockModule("../../config/index.js", () => ({
  config: { anthropic: { apiKey: "test" }, github: { appId: "1", privateKey: "k", clientId: "x", clientSecret: "x", webhookSecret: "s" }, server: { baseUrl: "x" } },
}));

process.env.API_KEY = "unit-test-api-key";

const { rateLimiter } = await import("../../src/middleware/rateLimiter.js");
const { apiKeyAuth } = await import("../../src/middleware/auth.js");

const express = (await import("express")).default;
const supertest = (await import("supertest")).default;

function runMiddleware({ path = "/api/anything", headers = {}, ip } = {}) {
  return new Promise((resolve) => {
    const req = { path, headers, ip, get: (h) => headers[h.toLowerCase()] };
    const res = {
      statusCode: 200,
      headers: {},
      setHeader(k, v) { this.headers[k] = v; },
      status(code) { this.statusCode = code; return this; },
      json(body) { this.body = body; resolve({ res, passed: false }); return this; },
    };
    rateLimiter(req, res, () => resolve({ res, passed: true }));
  });
}

beforeEach(() => {
  redisState.counts.clear();
  redisState.failWith = null;
  jest.clearAllMocks();
});

describe("rate limiter behavior (Unit C — existing semantics pinned)", () => {
  it("applicable API requests pass and receive limit headers", async () => {
    const { res, passed } = await runMiddleware({ headers: { authorization: "Bearer key-A" } });
    expect(passed).toBe(true);
    expect(res.headers["X-RateLimit-Limit"]).toBe(120);
    expect(res.headers["X-RateLimit-Remaining"]).toBe(119);
  });

  it("the first hit in a window arms the TTL (pexpire with the 60s window)", async () => {
    const { pexpire } = (await import("../../src/lib/queue.js")).redis;
    await runMiddleware({ headers: { authorization: "Bearer key-ttl" } });
    expect(pexpire).toHaveBeenCalledWith("ratelimit:Bearer key-ttl" === pexpire.mock.calls[0]?.[0] ? pexpire.mock.calls[0][0] : expect.stringContaining("key-ttl"), 60_000);
  });

  it("the 121st request in the window is rejected with 429 and Retry-After", async () => {
    for (let i = 0; i < 120; i += 1) {
      const { passed } = await runMiddleware({ headers: { authorization: "Bearer key-B" } });
      expect(passed).toBe(true);
    }
    const { res, passed } = await runMiddleware({ headers: { authorization: "Bearer key-B" } });
    expect(passed).toBe(false);
    expect(res.statusCode).toBe(429);
    expect(res.body.error).toBe("Too many requests");
    expect(res.headers["Retry-After"]).toBe(60);
  });

  it("distinct Bearer identities get independent windows", async () => {
    for (let i = 0; i < 120; i += 1) {
      await runMiddleware({ headers: { authorization: "Bearer key-C1" } });
    }
    const saturated = await runMiddleware({ headers: { authorization: "Bearer key-C1" } });
    expect(saturated.passed).toBe(false);
    const other = await runMiddleware({ headers: { authorization: "Bearer key-C2" } });
    expect(other.passed).toBe(true);
  });

  it("requests WITHOUT Bearer credentials fall back to IP identity", async () => {
    const a = await runMiddleware({ ip: "10.0.0.1" });
    const b = await runMiddleware({ ip: "10.0.0.2" });
    const a2 = await runMiddleware({ ip: "10.0.0.1" });
    expect(a.passed).toBe(true);
    expect(b.passed).toBe(true);
    expect(a2.res.headers["X-RateLimit-Remaining"]).toBe(118); // same IP bucket
  });

  it("/health is excluded — no Redis interaction, unlimited passage", async () => {
    for (let i = 0; i < 130; i += 1) {
      const { passed } = await runMiddleware({ path: "/health" });
      expect(passed).toBe(true);
    }
    expect(redisState.counts.size).toBe(0);
  });

  it("/webhooks paths are excluded", async () => {
    const { passed } = await runMiddleware({ path: "/webhooks/github" });
    expect(passed).toBe(true);
    expect(redisState.counts.size).toBe(0);
  });

  it("DOCUMENTED FAIL-OPEN: a Redis failure currently allows the request through AND logs the failure", async () => {
    redisState.failWith = new Error("ECONNREFUSED");
    const { res, passed } = await runMiddleware({ headers: { authorization: "Bearer key-D" } });
    // This pins the CURRENT behavior. Changing it (fail-closed) is an
    // availability trade-off reserved for a separate decision; if it ever
    // changes intentionally, this test must change WITH that decision.
    expect(passed).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.objectContaining({ message: "ECONNREFUSED" }) }),
      expect.stringContaining("allowing request"),
    );
  });
});

describe("REPRODUCER (known defect, recorded not fixed): non-Bearer Authorization headers split rate buckets under session auth", () => {
  // The limiter identity is `req.headers.authorization?.slice(7)?.trim() || req.ip`
  // — the scheme is never checked. apiKeyAuth accepts a VALID SESSION COOKIE
  // when the Authorization header is absent or not Bearer. Chained as in
  // production (limiter before auth), a session-authenticated caller rotates
  // arbitrary non-Bearer Authorization values to get a fresh bucket per
  // request. This documents the bypass end-to-end with the REAL apiKeyAuth;
  // the fix is a separate production decision per the #425 review.

  function buildApp() {
    const app = express();
    app.use(rateLimiter);
    app.use(apiKeyAuth);
    app.get("/api/anything", (req, res) => res.json({ ok: true }));
    return app;
  }

  it("END-TO-END: 130 requests from ONE session, rotating Basic headers, all pass — the per-IP fallback they should have shared never applies", async () => {
    const app = buildApp();
    const sessionCookie = "gitwire-session=valid-session";
    for (let i = 0; i < 130; i += 1) {
      const res = await supertest(app)
        .get("/api/anything")
        .set("Authorization", `Basic rotating-value-${i}`) // arbitrary non-Bearer
        .set("Cookie", sessionCookie);
      expect(res.status).toBe(200);
    }
    // 130 DISTINCT buckets were created — one per rotated header value —
    // while the SAME session authenticated every request. Without the
    // rotating header, all 130 would share the IP bucket and the last 10
    // would have been 429'd.
    expect(redisState.counts.size).toBe(130);
    expect([...redisState.counts.values()].every((n) => n === 1)).toBe(true);
  });

  it("CONTROL: the SAME session WITHOUT the header trick throttles at 120/min on the shared IP bucket", async () => {
    const app = buildApp();
    const sessionCookie = "gitwire-session=valid-session";
    let saw429 = false;
    for (let i = 0; i < 130; i += 1) {
      const res = await supertest(app)
        .get("/api/anything")
        .set("Cookie", sessionCookie);
      if (res.status === 429) { saw429 = true; break; }
      expect(res.status).toBe(200);
    }
    expect(saw429).toBe(true); // the limit the rotation bypasses
  });

  it("MECHANISM: the limiter bucket key derives from the raw sliced header, scheme unchecked", async () => {
    const a = await runMiddleware({ headers: { authorization: "Basic value-1" }, ip: "10.9.9.9" });
    const b = await runMiddleware({ headers: { authorization: "Basic value-2" }, ip: "10.9.9.9" });
    expect(a.passed).toBe(true);
    expect(b.passed).toBe(true);
    // Two buckets for one IP — the sliced values differ even though neither
    // is a credential.
    expect(redisState.counts.size).toBe(2);
    expect([...redisState.counts.keys()].join("|")).toContain("alue-1"); // slice(7) of "Basic value-1"
    expect([...redisState.counts.keys()].join("|")).toContain("alue-2");
  });
});
