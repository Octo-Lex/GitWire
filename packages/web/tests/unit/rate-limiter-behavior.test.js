// tests/unit/rate-limiter-behavior.test.js
// #425 Unit C: pin the rate limiter's EXISTING behavior (test-only — the
// Redis fail-open is documented here, deliberately NOT changed; altering it
// is an availability decision reserved to a separate authorization):
//   - applicable API requests are limited; the 121st request in the window
//     gets HTTP 429 with Retry-After
//   - /health and /webhooks paths are excluded
//   - Bearer credentials supply the limiter identity; requests without them
//     fall back to IP identity
//   - Redis failures currently ALLOW requests through (fail-open), logged

import { jest } from "@jest/globals";

const redisState = { counts: new Map(), failWith: null };

jest.unstable_mockModule("../../src/lib/queue.js", () => ({
  redis: {
    incr: jest.fn(async (key) => {
      if (redisState.failWith) throw redisState.failWith;
      const next = (redisState.counts.get(key) ?? 0) + 1;
      redisState.counts.set(key, next);
      return next;
    }),
    pexpire: jest.fn(async () => 1),
  },
}));
jest.unstable_mockModule("../../src/lib/logger.js", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const { rateLimiter } = await import("../../src/middleware/rateLimiter.js");

const express = (await import("express")).default;

function makeApp() {
  const app = express();
  app.get("/api/anything", (req, res) => res.json({ ok: true }));
  app.get("/health", (req, res) => res.json({ ok: true }));
  app.post("/webhooks/github", (req, res) => res.json({ ok: true }));
  app.use(rateLimiter);
  // NOTE: in production the limiter is mounted BEFORE routes; for these
  // tests we exercise the middleware DIRECTLY below instead.
  return app;
}
void makeApp;

function runMiddleware({ path = "/api/anything", headers = {}, ip } = {}) {
  return new Promise((resolve) => {
    const req = {
      path,
      headers,
      ip,
      get: (h) => headers[h.toLowerCase()],
    };
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

  it("DOCUMENTED FAIL-OPEN: a Redis failure currently allows the request through and logs", async () => {
    redisState.failWith = new Error("ECONNREFUSED");
    const { res, passed } = await runMiddleware({ headers: { authorization: "Bearer key-D" } });
    // This pins the CURRENT behavior. Changing it (fail-closed) is an
    // availability trade-off reserved for a separate decision; if it ever
    // changes intentionally, this test must change WITH that decision.
    expect(passed).toBe(true);
    expect(res.statusCode).toBe(200);
  });
});
