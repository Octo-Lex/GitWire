// tests/unit/rate-limiter-identity.test.js
// Production remediation for the identity bypass reproduced in
// rate-limiter-behavior.test.js: limiter identity now recognizes ONLY a
// properly formed Bearer scheme; every other Authorization form (and its
// absence) falls back to the request IP — so rotating non-Bearer headers can
// no longer mint fresh buckets for a session-authenticated caller.
//
// The behavior pins (threshold, exclusions, fail-open) live in the behavior
// suite against the same middleware; this suite proves the identity contract
// change end-to-end and in the middleware directly.

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
    get: jest.fn(async (key) => {
      if (key.startsWith("gitwire:session:")) {
        return key.endsWith(":valid-session") ? JSON.stringify({ principal: "session-user" }) : null;
      }
      return null;
    }),
    expire: jest.fn(async () => 1),
  },
}));
jest.unstable_mockModule("../../src/lib/logger.js", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.unstable_mockModule("../../config/index.js", () => ({
  config: { anthropic: { apiKey: "test" }, github: { appId: "1", privateKey: "k", clientId: "x", clientSecret: "x", webhookSecret: "s" }, server: { baseUrl: "x" } },
}));

process.env.API_KEY = "unit-test-api-key";

const { rateLimiter } = await import("../../src/middleware/rateLimiter.js");
const { apiKeyAuth } = await import("../../src/middleware/auth.js");

const express = (await import("express")).default;
const supertest = (await import("supertest")).default;

function buildApp() {
  // Production mount order: limiter BEFORE authentication.
  const app = express();
  app.use(rateLimiter);
  app.use(apiKeyAuth);
  app.get("/api/anything", (req, res) => res.json({ ok: true }));
  return app;
}

beforeEach(() => {
  redisState.counts.clear();
  redisState.failWith = null;
  jest.clearAllMocks();
});

describe("REMEDIATION: rotating non-Bearer headers can no longer split buckets", () => {
  it("THE REPRODUCER SCENARIO, FIXED: 130 requests from one session with rotating Basic headers hit 429 at request 121", async () => {
    const app = buildApp();
    const sessionCookie = "gitwire-session=valid-session";
    let last = 200;
    for (let i = 0; i < 130; i += 1) {
      const res = await supertest(app)
        .get("/api/anything")
        .set("Authorization", `Basic rotating-value-${i}`)
        .set("Cookie", sessionCookie);
      if (i < 120) {
        expect(res.status).toBe(200);
      }
      last = res.status;
      if (res.status === 429) break;
    }
    expect(last).toBe(429);
    // ONE shared bucket (the request IP), not 130.
    expect(redisState.counts.size).toBe(1);
    expect([...redisState.counts.values()][0]).toBe(121);
  });

  it("header-absent session traffic shares the same IP bucket (unchanged semantics)", async () => {
    const app = buildApp();
    const sessionCookie = "gitwire-session=valid-session";
    let saw429 = false;
    for (let i = 0; i < 121; i += 1) {
      const res = await supertest(app).get("/api/anything").set("Cookie", sessionCookie);
      if (res.status === 429) { saw429 = true; break; }
      expect(res.status).toBe(200);
    }
    expect(saw429).toBe(true);
    expect(redisState.counts.size).toBe(1);
  });
});

describe('PRE-AUTH FIX: rotating invalid Bearer tokens on /api/auth/login shares ONE IP bucket', () => {
  // The limiter runs before authentication, so it cannot know a Bearer token
  // is invalid. The login route authenticates by request-body password — an
  // unauthenticated caller rotating syntactically-valid-but-random Bearer
  // values would otherwise mint a fresh bucket per password guess.
  function buildLoginApp() {
    const app = express();
    app.use(rateLimiter);
    app.use(express.json());
    // Minimal login route mirroring auth.js: 401 on wrong password.
    app.post('/api/auth/login', (req, res) => res.status(401).json({ error: 'Invalid password' }));
    return app;
  }

  it('END-TO-END: 130 login attempts with ROTATING random Bearer tokens hit 429 at request 121 on ONE shared bucket', async () => {
    const app = buildLoginApp();
    let last = 200;
    for (let i = 0; i < 130; i += 1) {
      const res = await supertest(app)
        .post('/api/auth/login')
        .set('Authorization', "Bearer random-guess-token-" + i)
        .send({ password: 'wrong-' + i });
      if (i < 120) {
        expect(res.status).toBe(401); // still reaches the route and fails auth
      }
      last = res.status;
      if (res.status === 429) break;
    }
    expect(last).toBe(429);
    expect(redisState.counts.size).toBe(1); // ONE shared IP bucket
    expect([...redisState.counts.values()][0]).toBe(121);
  });

  it('login attempts WITHOUT Bearer headers share the same single bucket (unchanged semantics)', async () => {
    const app = buildLoginApp();
    let saw429 = false;
    for (let i = 0; i < 121; i += 1) {
      const res = await supertest(app)
        .post('/api/auth/login')
        .send({ password: 'wrong' });
      if (res.status === 429) { saw429 = true; break; }
      expect(res.status).toBe(401);
    }
    expect(saw429).toBe(true);
    expect(redisState.counts.size).toBe(1);
  });

  it('NON-login /api paths still derive identity from a well-formed Bearer token', async () => {
    const app = buildLoginApp();
    app.get('/api/anything', (req, res) => res.json({ ok: true }));
    const res = await supertest(app)
      .get('/api/anything')
      .set('Authorization', 'Bearer some-token');
    expect(res.status).toBe(200);
    expect([...redisState.counts.keys()].join('|')).toContain('some-token');
  });
});

describe("identity derivation contract (middleware-level)", () => {
  function runMiddleware({ headers = {}, ip } = {}) {
    return new Promise((resolve) => {
      const req = { path: "/api/anything", headers, ip, get: (h) => headers[h.toLowerCase()] };
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

  it("a well-formed Bearer token IS the identity (case-insensitive scheme)", async () => {
    await runMiddleware({ headers: { authorization: "Bearer key-one" }, ip: "10.0.0.1" });
    await runMiddleware({ headers: { authorization: "Bearer key-two" }, ip: "10.0.0.1" });
    // Two distinct buckets for two distinct tokens from one IP.
    expect(redisState.counts.size).toBe(2);
    expect([...redisState.counts.keys()].join("|")).toContain("key-one");
    expect([...redisState.counts.keys()].join("|")).toContain("key-two");
    // A LOWERCASE scheme is not Bearer for apiKeyAuth (starts-with "Bearer "),
    // so it must not be Bearer for the limiter either — it falls to the IP.
    redisState.counts.clear();
    await runMiddleware({ headers: { authorization: "bearer key-lower" }, ip: "10.0.0.2" });
    expect([...redisState.counts.keys()]).toEqual(["ratelimit:10.0.0.2"]);
  });

  it.each([
    ["Basic value-1"],
    ["basic value-2"],
    ["Bearer"],                       // malformed: no token after scheme
    ["Bearer "],                      // malformed: whitespace only
    ["Bearer\tgap-token"],            // malformed: tab not matched by \\s+? (regex ^Bearer\\s+ — tab IS \\s; assert below)
    [""],                             // empty header value
  ])("non-Bearer or malformed header %j falls back to the IP bucket", async (authorization) => {
    redisState.counts.clear();
    const first = await runMiddleware({ headers: { authorization }, ip: "10.1.1.1" });
    expect(first.passed).toBe(true);
    // Whatever the header said, the bucket is the IP.
    expect([...redisState.counts.keys()]).toEqual(["ratelimit:10.1.1.1"]);
  });

  it("Bearer-key separation still works at the threshold: key A saturates, key B unaffected, IP unaffected", async () => {
    for (let i = 0; i < 120; i += 1) {
      await runMiddleware({ headers: { authorization: "Bearer key-sat" }, ip: "10.2.2.2" });
    }
    const saturated = await runMiddleware({ headers: { authorization: "Bearer key-sat" }, ip: "10.2.2.2" });
    expect(saturated.passed).toBe(false);
    const otherKey = await runMiddleware({ headers: { authorization: "Bearer key-other" }, ip: "10.2.2.2" });
    expect(otherKey.passed).toBe(true);
    const plainIp = await runMiddleware({ ip: "10.2.2.2" });
    expect(plainIp.passed).toBe(true);
  });
});
