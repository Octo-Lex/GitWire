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
    expect(pexpire).toHaveBeenCalledTimes(1);
    // The bucket key derives from the sliced header; the TTL is the pinned fact.
    expect(pexpire.mock.calls[0][0]).toContain("key-ttl");
    expect(pexpire.mock.calls[0][1]).toBe(60_000);
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

describe('REPRODUCER HISTORY (bypass FIXED by rate-limiter-identity remediation on this branch)', () => {
  // The original end-to-end reproducer (130 rotating Basic headers from one
  // session, all passing, 130 distinct buckets) documented the identity
  // defect that the Bearer-only derivation now closes. Full fixed-scenario
  // coverage lives in rate-limiter-identity.test.js; here we assert the
  // original attack no longer reproduces against the CURRENT middleware.
  function buildApp() {
    const app = express();
    app.use(rateLimiter);
    app.use(apiKeyAuth);
    app.get('/api/anything', (req, res) => res.json({ ok: true }));
    return app;
  }

  it('the original rotation attack now throttles: 121st request is 429 on ONE shared bucket', async () => {
    const app = buildApp();
    const sessionCookie = 'gitwire-session=valid-session';
    let last = 200;
    for (let i = 0; i < 130; i += 1) {
      const res = await supertest(app)
        .get('/api/anything')
        .set('Authorization', "Basic rotating-value-" + i)
        .set('Cookie', sessionCookie);
      last = res.status;
      if (res.status === 429) break;
    }
    expect(last).toBe(429);
    expect(redisState.counts.size).toBe(1); // the IP bucket, not per-header buckets
  });
});
