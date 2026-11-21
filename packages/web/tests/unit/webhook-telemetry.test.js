// tests/unit/webhook-telemetry.test.js
// #10-A regressions (v4 lifecycle model): telemetry-only instrumentation
// of the webhook ingress. Retention accounting ends at HANDLER SETTLEMENT
// (the route's finally), never at transport termination post-handoff;
// overdue records are flagged, never force-released; retained_bytes is
// logical payload bytes. Three layers pinned:
//
// 1. Unit registry: exactly-once release, no negative counters, active ==
//    tracked ids, overdue flagging without removal, window rollover
//    seeding, duration accounting.
// 2. Middleware contract: transport events release ONLY pre-handoff; the
//    settle hook is the sole post-handoff release.
// 3. End-to-end (real-HMAC harness, same as webhook-body-limit.test.js):
//    every outcome class counted exactly once, gauges drain, admission
//    behavior byte-identical — plus the two maintainer-specified
//    regressions: client disconnect DURING ASYNC HANDLING (retention
//    stays active until settlement) and overdue-but-live handler (never
//    prematurely removed; evidence flagged unreliable).

import { jest } from "@jest/globals";
import { Readable } from "node:stream";
import { createHmac } from "node:crypto";

const WEBHOOK_SECRET = "unit-test-webhook-secret";
const mockWebhookApp = { webhooks: { verifyAndReceive: jest.fn() } };
const mockRouteWebhookToQueue = jest.fn(async () => undefined);

jest.unstable_mockModule("../../src/lib/github.js", () => ({
  getWebhookApp: jest.fn(() => mockWebhookApp),
  getInstallationClient: jest.fn(),
  forEachInstallation: jest.fn(),
  forEachRepo: jest.fn(),
}));
jest.unstable_mockModule("../../src/lib/queue.js", () => ({
  webhookQueue: { add: jest.fn() },
  triageQueue: { add: jest.fn() },
  redis: { get: jest.fn(), set: jest.fn(), setex: jest.fn(), incr: jest.fn(), pexpire: jest.fn() },
}));
jest.unstable_mockModule("../../src/lib/db.js", () => ({ db: { query: jest.fn(async () => ({ rows: [] })) } }));
jest.unstable_mockModule("../../src/lib/logger.js", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.unstable_mockModule("../../src/lib/webhookHandlers/index.js", () => ({
  routeWebhookToQueue: mockRouteWebhookToQueue,
}));

const {
  webhookRouter,
  express_raw_body_middleware,
} = await import("../../src/routes/webhooks.js");
const {
  webhookTelemetryBegin,
  webhookTelemetryBytes,
  webhookTelemetryBodyComplete,
  webhookTelemetryRelease,
  webhookTelemetrySnapshot,
  __webhookTelemetryResetForTests,
  __webhookTelemetryTestBackdateInflight,
  __webhookTelemetryTestBackdateWindow,
} = await import("../../src/lib/webhookTelemetry.js");

const express = (await import("express")).default;
const supertest = (await import("supertest")).default;

function makeApp() {
  const app = express();
  app.use("/webhooks", webhookRouter);
  return app;
}

function sign(payload) {
  return "sha256=" + createHmac("sha256", WEBHOOK_SECRET).update(payload).digest("hex");
}

beforeEach(() => {
  jest.clearAllMocks();
  mockWebhookApp.webhooks.verifyAndReceive.mockReset();
  mockRouteWebhookToQueue.mockReset();
  mockWebhookApp.webhooks.verifyAndReceive.mockImplementation(
    async ({ payload, signature }) => {
      if (signature !== sign(payload)) throw new Error("signature mismatch");
      return undefined;
    },
  );
  mockRouteWebhookToQueue.mockResolvedValue(undefined);
  __webhookTelemetryResetForTests();
});

// Handler-storing res stub + stream req, for driving the middleware
// directly with deterministic body/handler/transport timing.
function makeReqRes() {
  const stream = new Readable({ read() {} });
  const req = Object.assign(stream, {
    headers: {},
    on: stream.on.bind(stream),
    removeListener: stream.removeListener.bind(stream),
    resume: stream.resume.bind(stream),
  });
  const res = {
    statusCode: 0, headers: {}, writableEnded: false,
    setHeader(k, v) { this.headers[k] = v; },
    status(c) { this.statusCode = c; return { json: () => {} }; },
    on(ev, fn) { (this._h ||= {})[ev] ||= []; this._h[ev].push(fn); return this; },
    emit(ev) { (this._h?.[ev] || []).forEach((f) => f()); },
    finish() { this.writableEnded = true; this.emit("finish"); this.emit("close"); },
    destroyOnly() { this.emit("close"); },
  };
  return { req, res };
}

describe("UNIT — accounting contract (lib/webhookTelemetry.js)", () => {
  it("active equals tracked ids; retained bytes equal their sum; semantics surfaced", () => {
    const a = webhookTelemetryBegin();
    const b = webhookTelemetryBegin();
    webhookTelemetryBytes(a, 100);
    webhookTelemetryBytes(b, 250);
    const snap = webhookTelemetrySnapshot();
    expect(snap.active_requests).toBe(2);
    expect(snap.retained_bytes).toBe(350);
    expect(snap.semantics).toBe("logical_payload_bytes");
    expect(snap.integrity.active_matches_inflight).toBe(true);
    expect(snap.high_water.current_window.active_requests).toBeGreaterThanOrEqual(2);
  });

  it("exactly-once release: the second release is a no-op, never a double decrement", () => {
    const a = webhookTelemetryBegin();
    expect(webhookTelemetryRelease(a, "completed")).toBe(true);
    expect(webhookTelemetryRelease(a, "completed")).toBe(false);
    const snap = webhookTelemetrySnapshot();
    expect(snap.active_requests).toBe(0);
    expect(snap.outcomes.completed).toBe(1); // counted ONCE
  });

  it("unknown-id release and garbage-proof byte accounting never drive counters negative", () => {
    expect(webhookTelemetryRelease(999, "completed")).toBe(false);
    const a = webhookTelemetryBegin();
    webhookTelemetryBytes(a, -5);   // ignored
    webhookTelemetryBytes(a, 0);    // ignored
    webhookTelemetryBytes(999, 10); // unknown id, ignored
    webhookTelemetryRelease(a, "completed");
    const snap = webhookTelemetrySnapshot();
    expect(snap.active_requests).toBe(0);
    expect(snap.retained_bytes).toBe(0);
    expect(snap.outcomes.completed).toBe(1);
  });

  it("durations: streaming recorded at body-complete, retention at release; unknown outcome maps to error", () => {
    const a = webhookTelemetryBegin();
    webhookTelemetryBodyComplete(a);
    webhookTelemetryBodyComplete(a); // idempotent
    webhookTelemetryRelease(a, "nonsense-bucket");
    const snap = webhookTelemetrySnapshot();
    expect(snap.durations_ms.streaming.count).toBe(1);
    expect(snap.durations_ms.retention.count).toBe(1);
    expect(snap.outcomes.error).toBe(1);
  });

  it("OVERDUE (A2): an overdue-but-live record is NEVER removed — flagged, kept in gauges, evidence marked unreliable", () => {
    const a = webhookTelemetryBegin();
    webhookTelemetryBytes(a, 4096);
    __webhookTelemetryTestBackdateInflight(a, 601_000); // past OVERDUE_MS
    let snap = webhookTelemetrySnapshot();
    // Accounting preserved: still active, still retained.
    expect(snap.active_requests).toBe(1);
    expect(snap.retained_bytes).toBe(4096);
    // Overdue surfaced explicitly, evidence explicitly unreliable.
    expect(snap.integrity.overdue_requests).toBe(1);
    expect(snap.integrity.overdue_retained_bytes).toBe(4096);
    expect(snap.integrity.evidence_reliable).toBe(false);

    // Settlement still works later — the record was never deleted.
    expect(webhookTelemetryRelease(a, "completed")).toBe(true);
    snap = webhookTelemetrySnapshot();
    expect(snap.active_requests).toBe(0);
    expect(snap.retained_bytes).toBe(0);
    expect(snap.integrity.overdue_requests).toBe(0);
    expect(snap.integrity.evidence_reliable).toBe(true);
  });

  it("young records are never flagged overdue", () => {
    const a = webhookTelemetryBegin();
    __webhookTelemetryTestBackdateInflight(a, 299_000); // under requestTimeout
    const snap = webhookTelemetrySnapshot();
    expect(snap.active_requests).toBe(1);
    expect(snap.integrity.overdue_requests).toBe(0);
    expect(snap.integrity.evidence_reliable).toBe(true);
    webhookTelemetryRelease(a, "completed");
  });

  it("WINDOW ROLLOVER with in-flight requests: the new window is seeded from current gauges, not zero", () => {
    const a = webhookTelemetryBegin();
    const b = webhookTelemetryBegin();
    webhookTelemetryBytes(a, 1000);
    webhookTelemetryBytes(b, 2000);
    __webhookTelemetryTestBackdateWindow(61_000);
    const snap = webhookTelemetrySnapshot();
    expect(snap.active_requests).toBe(2);
    expect(snap.retained_bytes).toBe(3000);
    expect(snap.high_water.current_window.active_requests).toBe(2);
    expect(snap.high_water.current_window.retained_bytes).toBe(3000);
    expect(snap.high_water.recent_windows).toHaveLength(1);
    webhookTelemetryRelease(a, "completed");
    webhookTelemetryRelease(b, "completed");
  });
});

describe("MIDDLEWARE CONTRACT — transport vs handler settlement (A1)", () => {
  it("PRE-HANDOFF transport termination releases (rejection paths own no handler)", () => {
    const { req, res } = makeReqRes();
    express_raw_body_middleware()(req, res, jest.fn());
    req.emit("data", Buffer.alloc(10));
    // A responded rejection (e.g. the streaming 413) terminates transport.
    res.status(413);
    res.finish();
    const snap = webhookTelemetrySnapshot();
    expect(snap.active_requests).toBe(0);
    expect(snap.retained_bytes).toBe(0);
    expect(snap.outcomes.rejected_413).toBe(1);
  });

  it("A1 REGRESSION: client disconnect while the async handler still holds the body does NOT release accounting", () => {
    const { req, res } = makeReqRes();
    const handlerStarted = jest.fn();
    // The "handler" that next() invokes and never settles until told.
    const handler = () => { handlerStarted(); };
    express_raw_body_middleware()(req, res, handler);
    req.emit("data", Buffer.alloc(2048));
    req.emit("end"); // body complete -> handoff -> handler runs, retains body
    expect(handlerStarted).toHaveBeenCalledTimes(1);
    expect(typeof req.webhookTelemetrySettle).toBe("function");

    // Client disconnects mid-handler: transport close must NOT release.
    res.destroyOnly();
    let snap = webhookTelemetrySnapshot();
    expect(snap.active_requests).toBe(1);            // handler still owns the body
    expect(snap.retained_bytes).toBe(2048);          // memory still retained
    expect(snap.integrity.evidence_reliable).toBe(true);

    // Handler settles (finally): NOW the accounting releases, classified
    // aborted because the response never ended.
    req.webhookTelemetrySettle();
    snap = webhookTelemetrySnapshot();
    expect(snap.active_requests).toBe(0);
    expect(snap.retained_bytes).toBe(0);
    expect(snap.outcomes.aborted).toBe(1);
    expect(snap.integrity.active_matches_inflight).toBe(true);
  });

  it("handler that completes and responds after the disconnect classifies by terminal status", () => {
    const { req, res } = makeReqRes();
    express_raw_body_middleware()(req, res, jest.fn());
    req.emit("data", Buffer.alloc(64));
    req.emit("end");
    res.destroyOnly();           // client gone mid-handler
    res.status(202);             // handler finished its work anyway
    res.writableEnded = true;
    req.webhookTelemetrySettle();
    const snap = webhookTelemetrySnapshot();
    expect(snap.outcomes.completed).toBe(1);
    expect(snap.active_requests).toBe(0);
  });
});

describe("END-TO-END — every outcome counted exactly once; admission behavior unchanged", () => {
  const app = makeApp();

  it("successful signed delivery: completed outcome, gauges return to zero, bytes and durations recorded", async () => {
    const payload = JSON.stringify({ action: "opened", issue: { number: 1 } });
    const res = await supertest(app)
      .post("/webhooks/github")
      .set("x-github-event", "issues")
      .set("x-github-delivery", "tel-ok-1")
      .set("x-hub-signature-256", sign(payload))
      .set("content-type", "application/json")
      .send(payload);
    expect(res.status).toBe(202); // admission behavior unchanged

    const snap = webhookTelemetrySnapshot();
    expect(snap.active_requests).toBe(0);
    expect(snap.retained_bytes).toBe(0);
    expect(snap.outcomes.completed).toBe(1);
    expect(snap.high_water.current_window.retained_bytes).toBeGreaterThanOrEqual(Buffer.byteLength(payload));
    expect(snap.durations_ms.streaming.count).toBe(1);
    expect(snap.durations_ms.retention.count).toBe(1);
    expect(snap.integrity.active_matches_inflight).toBe(true);
  });

  it("400 (missing headers): counted via handler settlement (post-handoff)", async () => {
    const payload = "{}";
    await supertest(app)
      .post("/webhooks/github")
      .set("content-type", "application/json")
      .send(payload);
    const snap = webhookTelemetrySnapshot();
    expect(snap.outcomes.rejected_400).toBe(1);
    expect(snap.active_requests).toBe(0);
    expect(snap.high_water.current_window.retained_bytes).toBeGreaterThanOrEqual(Buffer.byteLength(payload));
  });

  it("401 (bad signature): counted, byte-complete body released at settlement", async () => {
    const payload = JSON.stringify({ some: "payload" });
    const res = await supertest(app)
      .post("/webhooks/github")
      .set("x-github-event", "issues")
      .set("x-github-delivery", "tel-401-1")
      .set("x-hub-signature-256", "sha256=deadbeef")
      .set("content-type", "application/json")
      .send(payload);
    expect(res.status).toBe(401);
    const snap = webhookTelemetrySnapshot();
    expect(snap.outcomes.rejected_401).toBe(1);
    expect(snap.active_requests).toBe(0);
    expect(snap.retained_bytes).toBe(0);
    expect(snap.durations_ms.streaming.count).toBe(1);
  });

  it("413 via declared Content-Length: counted pre-handoff with ZERO retained bytes", async () => {
    const res = await supertest(app)
      .post("/webhooks/github")
      .set("x-github-event", "issues")
      .set("x-github-delivery", "tel-413-decl")
      .set("x-hub-signature-256", "sha256=x")
      .set("content-type", "application/json")
      .set("content-length", String(26 * 1024 * 1024));
    expect(res.status).toBe(413);
    const snap = webhookTelemetrySnapshot();
    expect(snap.outcomes.rejected_413).toBe(1);
    expect(snap.active_requests).toBe(0);
    expect(snap.retained_bytes).toBe(0);
    expect(snap.high_water.current_window.retained_bytes).toBe(0); // never buffered
  });

  it("413 via streaming over-cap: pre-handoff release; retained bytes peaked at the cap", async () => {
    const mw = express_raw_body_middleware();
    const req = new Readable({ read() {} });
    req.headers = {};
    const json = jest.fn();
    const res = {
      statusCode: 0, headers: {}, writableEnded: false,
      setHeader(k, v) { this.headers[k] = v; },
      status(c) { this.statusCode = c; return { json }; },
      on(ev, fn) { (this._h ||= {})[ev] ||= []; this._h[ev].push(fn); return this; },
      emit(ev) { (this._h?.[ev] || []).forEach((f) => f()); },
      finish() { this.writableEnded = true; this.emit("finish"); this.emit("close"); },
    };
    mw(req, res, jest.fn());

    req.push(Buffer.alloc(25 * 1024 * 1024));
    await new Promise((r) => setImmediate(r));
    let snap = webhookTelemetrySnapshot();
    expect(snap.active_requests).toBe(1);
    expect(snap.retained_bytes).toBe(25 * 1024 * 1024);
    expect(snap.high_water.current_window.retained_bytes).toBe(25 * 1024 * 1024);

    req.push(Buffer.alloc(2)); // crosses the cap
    await new Promise((r) => setImmediate(r));
    expect(res.statusCode).toBe(413);
    expect(json).toHaveBeenCalledTimes(1);

    res.finish(); // transport termination, pre-handoff -> releases
    snap = webhookTelemetrySnapshot();
    expect(snap.outcomes.rejected_413).toBe(1);
    expect(snap.active_requests).toBe(0);
    expect(snap.retained_bytes).toBe(0);
    expect(snap.durations_ms.streaming.count).toBe(0); // body never completed
    expect(snap.durations_ms.retention.count).toBe(1);
  });

  it("OVERLAPPING requests: high-water concurrency >= 2 while both are in flight, then exact drain", () => {
    const middleware = express_raw_body_middleware();
    const a = makeReqRes();
    const b = makeReqRes();

    middleware(a.req, a.res, () => {});
    middleware(b.req, b.res, () => {});
    a.req.emit("data", Buffer.alloc(100));
    b.req.emit("data", Buffer.alloc(100));

    let snap = webhookTelemetrySnapshot();
    expect(snap.active_requests).toBe(2);
    expect(snap.retained_bytes).toBe(200);
    expect(snap.high_water.current_window.active_requests).toBeGreaterThanOrEqual(2);

    // A completes body (handoff), its handler responds and settles; B held.
    a.req.emit("end");
    a.res.status(202);
    a.res.finish(); // transport end post-handoff: does NOT release
    a.req.webhookTelemetrySettle();
    snap = webhookTelemetrySnapshot();
    expect(snap.active_requests).toBe(1);
    expect(snap.retained_bytes).toBe(100);
    expect(snap.outcomes.completed).toBe(1);

    // B aborts mid-stream (pre-handoff): transport event releases.
    b.req.emit("aborted");
    snap = webhookTelemetrySnapshot();
    expect(snap.active_requests).toBe(0);
    expect(snap.retained_bytes).toBe(0);
    expect(snap.outcomes.aborted).toBe(1);
    expect(snap.integrity.active_matches_inflight).toBe(true);
  });

  it("stream error mid-body: next(err) path released by transport termination (pre-handoff)", async () => {
    const { req, res } = makeReqRes();
    const next = jest.fn();
    express_raw_body_middleware()(req, res, next);
    req.emit("data", Buffer.alloc(10));
    req.emit("error", new Error("socket blew up"));
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ message: "socket blew up" })); // admission behavior unchanged

    let snap = webhookTelemetrySnapshot();
    expect(snap.active_requests).toBe(1); // held until the error response terminates
    expect(snap.retained_bytes).toBe(10);

    res.status(500);
    res.finish(); // Express error handler's terminal response
    snap = webhookTelemetrySnapshot();
    expect(snap.outcomes.error).toBe(1);
    expect(snap.active_requests).toBe(0);
    expect(snap.retained_bytes).toBe(0);
  });

  it("REAL DISCONNECT during body streaming: released as aborted (pre-handoff, res close)", async () => {
    const http = (await import("node:http")).default;
    const net = (await import("node:net")).default;
    const delay = (ms) => new Promise((r) => setTimeout(r, ms));
    const server = http.createServer((req, res) => {
      express_raw_body_middleware()(req, res, () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
      });
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const port = server.address().port;

    const sock = net.connect(port, "127.0.0.1");
    sock.write("POST / HTTP/1.1\r\nHost: t\r\nContent-Length: 100\r\n\r\npartial-body");
    await delay(200); // chunk buffered, mid-stream (pre-handoff)
    sock.destroy();   // premature disconnect

    await delay(300);
    const snap = webhookTelemetrySnapshot();
    expect(snap.outcomes.aborted).toBe(1);
    expect(snap.active_requests).toBe(0);
    expect(snap.retained_bytes).toBe(0);
    expect(snap.integrity.active_matches_inflight).toBe(true);

    server.close();
    await delay(50);
  });

  it("A1 INTEGRATION: real route held at a deferred dependency — client disconnect after body completion keeps accounting active until the production finally settles it", async () => {
    const http = (await import("node:http")).default;
    const net = (await import("node:net")).default;
    const delay = (ms) => new Promise((r) => setTimeout(r, ms));

    // The production route awaits routeWebhookToQueue(); hold it.
    let releaseDependency;
    const dependency = new Promise((r) => { releaseDependency = r; });
    mockRouteWebhookToQueue.mockReturnValue(dependency);

    const app = makeApp();
    const server = http.createServer(app);
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const port = server.address().port;

    const payload = JSON.stringify({ action: "opened", issue: { number: 7 } });
    const body = Buffer.from(payload);
    const sock = net.connect(port, "127.0.0.1");
    sock.write(
      "POST /webhooks/github HTTP/1.1\r\nHost: t\r\n" +
      "Content-Type: application/json\r\n" +
      "Content-Length: " + body.length + "\r\n" +
      "x-github-event: issues\r\nx-github-delivery: a1-integration\r\n" +
      "x-hub-signature-256: " + sign(payload) + "\r\n\r\n"
    );
    sock.write(body);

    // Wait until the route is genuinely parked on the deferred dependency.
    await new Promise((r) => setTimeout(r, 300));
    expect(mockRouteWebhookToQueue).toHaveBeenCalledTimes(1);
    let snap = webhookTelemetrySnapshot();
    expect(snap.active_requests).toBe(1);       // body complete, handler running
    expect(snap.retained_bytes).toBe(body.length);
    expect(snap.durations_ms.streaming.count).toBe(1);

    // Client disconnects AFTER body completion. The production finally has
    // NOT run (the handler is still awaiting), so accounting must remain.
    sock.destroy();
    await delay(250);
    snap = webhookTelemetrySnapshot();
    expect(snap.active_requests).toBe(1);       // handler still owns the body
    expect(snap.retained_bytes).toBe(body.length);
    expect(snap.integrity.active_matches_inflight).toBe(true);

    // Dependency resolves -> the route's own finally releases (no manual
    // settle anywhere in this test).
    releaseDependency();
    await delay(400);
    snap = webhookTelemetrySnapshot();
    expect(snap.active_requests).toBe(0);
    expect(snap.retained_bytes).toBe(0);
    const total = Object.values(snap.outcomes).reduce((a, b) => a + b, 0);
    expect(total).toBe(1);                      // exactly one terminal outcome

    server.close();
    await delay(50);
  });

  // NOTE (A3 route-level variant, deliberately not a route integration
  // test): an uncaught exception in the async route handler surfaces, under
  // Express 4, as an unhandledRejection with no HTTP response — pre-existing
  // behavior this unit must not change and the maintainer explicitly scoped
  // out of telemetry corrections. The route's catch wiring
  // (settle(err) -> rethrow) is therefore pinned by (a) the SETTLEMENT
  // CLASSIFICATION tests below exercising the production hook with an
  // error argument, and (b) the route source itself, where the catch is
  // visible and reviewed. Driving a real unhandledRejection through
  // supertest would hang the request (no response is ever produced) and
  // fail the suite on jest's own unhandled-rejection reporting — testing
  // Express 4 semantics, not this unit's classification.
});

describe("SETTLEMENT CLASSIFICATION — exceptional vs transport outcomes (A3)", () => {
  it("an exceptional settlement (handler threw, no client abort) records error, not aborted", () => {
    const { req, res } = makeReqRes();
    express_raw_body_middleware()(req, res, jest.fn());
    req.emit("data", Buffer.alloc(128));
    req.emit("end"); // handoff

    // The route's catch invokes the settle hook with the error BEFORE the
    // finally's argumentless settle (which no-ops). Response never written,
    // client never disconnected — a pure backend failure.
    req.webhookTelemetrySettle(new Error("backend failure"));
    req.webhookTelemetrySettle(); // finally — no-op (exactly-once)

    const snap = webhookTelemetrySnapshot();
    expect(snap.outcomes.error).toBe(1);
    expect(snap.outcomes.aborted).toBe(0);
    expect(snap.active_requests).toBe(0);
  });

  it("a client abort with NO exception still records aborted (classification unchanged)", () => {
    const { req, res } = makeReqRes();
    express_raw_body_middleware()(req, res, jest.fn());
    req.emit("data", Buffer.alloc(128));
    req.emit("end");
    res.destroyOnly();      // client gone, response never written
    req.webhookTelemetrySettle();
    const snap = webhookTelemetrySnapshot();
    expect(snap.outcomes.aborted).toBe(1);
    expect(snap.outcomes.error).toBe(0);
  });
});
