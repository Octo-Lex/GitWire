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

const { rateLimiter, deriveLimiterIdentity } = await import("../../src/middleware/rateLimiter.js");
const { apiKeyAuth } = await import("../../src/middleware/auth.js");
const { extractBearerToken } = await import("../../src/middleware/bearerToken.js");

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

  it('TRAILING-SLASH and case variants of the login path are ALSO IP-keyed (no mint on /api/auth/login/)', async () => {
    const app = buildLoginApp();
    const variants = ["/api/auth/login/", "/API/AUTH/LOGIN", "/api/auth/Login/"];
    for (const path of variants) {
      redisState.counts.clear();
      await supertest(app)
        .post(path)
        .set("Authorization", "Bearer slash-variant-token")
        .send({ password: "wrong" });
      // Whatever the route did with the variant (401 or 404), the limiter
      // bucket must be the IP — never the token.
      const keys = [...redisState.counts.keys()];
      expect(keys.length).toBe(1);
      expect(keys[0]).not.toContain("slash-variant-token");
    }
  });

  it('AUTH-CHECK: rotating Bearer tokens with a valid session cookie shares ONE IP bucket (429 at 121)', async () => {
    const app = buildLoginApp();
    // /api/auth/check accepts session cookies via Redis — mounted before
    // apiKeyAuth, so rotating Bearer headers would mint buckets per request.
    app.get('/api/auth/check', (req, res) => res.json({ authenticated: true }));
    const sessionCookie = 'gitwire-session=valid-session';
    let last = 200;
    for (let i = 0; i < 130; i += 1) {
      const res = await supertest(app)
        .get('/api/auth/check')
        .set('Authorization', 'Bearer check-rotating-' + i)
        .set('Cookie', sessionCookie);
      if (i < 120) {
        expect(res.status).toBe(200);
      }
      last = res.status;
      if (res.status === 429) break;
    }
    expect(last).toBe(429);
    expect(redisState.counts.size).toBe(1);
    expect([...redisState.counts.values()][0]).toBe(121);
  });

  it('BOOTSTRAP-STATE: anonymous rotating Bearer headers share ONE IP bucket (429 at 121)', async () => {
    const app = buildLoginApp();
    // /api/bootstrap/state runs a DB query anonymously — mounted before
    // apiKeyAuth.
    app.get('/api/bootstrap/state', (_req, res) => res.json({ bootstrapped: true }));
    let last = 200;
    for (let i = 0; i < 130; i += 1) {
      const res = await supertest(app)
        .get('/api/bootstrap/state')
        .set('Authorization', 'Bearer bootstrap-rotating-' + i);
      if (i < 120) {
        expect(res.status).toBe(200);
      }
      last = res.status;
      if (res.status === 429) break;
    }
    expect(last).toBe(429);
    expect(redisState.counts.size).toBe(1);
    expect([...redisState.counts.values()][0]).toBe(121);
  });

  it('FAMILY VARIANTS: every /api/auth/* and /api/bootstrap/* path (case, trailing slash, subpaths) keys on the IP', async () => {
    const paths = [
      '/api/auth/logout', '/API/AUTH/LOGIN/', '/api/auth/Check',
      '/api/bootstrap/first', '/API/BOOTSTRAP/state/', '/api/bootstrap',
      '/api/auth', '/api/auth/',
    ];
    const app = buildLoginApp();
    for (const path of paths) {
      redisState.counts.clear();
      await supertest(app)
        .get(path)
        .set('Authorization', 'Bearer family-variant-token');
      const keys = [...redisState.counts.keys()];
      expect(keys.length).toBe(1);
      expect(keys[0]).not.toContain('family-variant-token');
    }
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

  it('a well-formed case-sensitive "Bearer " scheme token IS the identity (exactly apiKeyAuth recognition)', async () => {
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
    ["Bearer\tgap-token"],            // malformed: tab is not the literal-space separator of the shared
                                      // recognizer ("Bearer " via extractBearerToken) — apiKeyAuth rejects
                                      // it with 401, so the limiter must bucket it as anonymous IP too
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

describe("CONTRACT: apiKeyAuth and deriveLimiterIdentity share one Bearer recognizer (bearerToken.js)", () => {
  // The two mechanisms were previously unlinked copies kept in sync only by
  // comments. Both now call extractBearerToken(), so this corpus pins the
  // ONE recognition rule both depend on: a header authenticates (given a
  // valid key) exactly when the shared recognizer extracts a token, and the
  // limiter keys on that token exactly when the same recognizer extracts
  // one. Divergence in either direction is a test failure, not a silent
  // bucket-rotation regression.

  const VALID_KEY = "unit-test-api-key"; // process.env.API_KEY set at module load (auth.js keys Set)

  async function authAccepts(authorization) {
    let accepted = false;
    const req = {
      path: "/api/repos", // not auth-skipped, not pre-auth-family
      headers: authorization === undefined ? {} : { authorization },
      ip: "10.9.9.9",
    };
    const res = { status() { return this; }, json() { return this; } };
    await apiKeyAuth(req, res, () => { accepted = true; });
    return accepted;
  }

  it.each([
    ["Bearer unit-test-api-key", "unit-test-api-key", true],
    ["Bearer   unit-test-api-key   ", "unit-test-api-key", true], // trim() tolerates surrounding whitespace AFTER the scheme
    ["Bearer not-the-key", "not-the-key", false], // recognized form, invalid key → 401, identity still the token
    ["bearer unit-test-api-key", "", false],      // lowercase scheme is not Bearer for EITHER mechanism
    ["BEARER unit-test-api-key", "", false],      // case-sensitive scheme
    ["Bearer\tunit-test-api-key", "", false],     // tab is not the literal-space separator
    ["Basic unit-test-api-key", "", false],
    ["Bearer", "", false],
    ["Bearer ", "", false],                       // whitespace-only token
    ["", "", false],
    [undefined, "", false],
  ])("corpus %j → token %j, apiKeyAuth accepts: %s", async (authorization, expectedToken, expectedAccept) => {
    // The shared recognizer decides both behaviors from one input.
    expect(extractBearerToken(authorization)).toBe(expectedToken);
    await expect(authAccepts(authorization)).resolves.toBe(expectedAccept);

    // Limiter identity (ordinary path): the token when the recognizer found
    // one, otherwise the IP. A recognized-but-invalid token ("Bearer
    // not-the-key") still mints its own bucket — authentication and throttle
    // identity are intentionally coupled ONLY on pre-auth families, where
    // the override below forces the IP.
    const identity = deriveLimiterIdentity({
      path: "/api/repos",
      headers: authorization === undefined ? {} : { authorization },
      ip: "10.9.9.9",
    });
    expect(identity).toBe(expectedToken || "10.9.9.9");
  });

  it("PRE-AUTH OVERRIDE: even a well-formed valid Bearer keys the IP on /api/auth/* and /api/bootstrap/*", () => {
    for (const path of ["/api/auth/login", "/api/auth/check", "/api/bootstrap/state", "/api/bootstrap/first"]) {
      const identity = deriveLimiterIdentity({
        path,
        headers: { authorization: `Bearer ${VALID_KEY}` },
        ip: "10.9.9.9",
      });
      expect(identity).toBe("10.9.9.9");
    }
  });
});
