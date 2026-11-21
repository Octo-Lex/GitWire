// tests/unit/webhook-telemetry.test.js
// #10-A regressions: telemetry-only instrumentation of the webhook raw-body
// middleware. Two jobs:
//
// 1. The unit registry's accounting contract: exactly-once release, no
//    negative counters, active == tracked ids, retained bytes == sum of
//    tracked buffers, window/lifetime high-water marks.
// 2. The instrumented middleware end-to-end (same real-HMAC harness style
//    as webhook-body-limit.test.js): every outcome class — completion, 400
//    (missing headers), 401 (bad signature), both 413 paths (declared
//    early-out and streaming over-cap), and abnormal termination — is
//    counted exactly once, gauges return to zero, and ADMISSION BEHAVIOR
//    IS UNCHANGED (status codes and bodies byte-identical to the
//    uninstrumented contract pinned by the body-limit suite).

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
  redis: { get: jest.fn(), set: jest.fn(), incr: jest.fn(), pexpire: jest.fn() },
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

describe("UNIT — accounting contract (lib/webhookTelemetry.js)", () => {
  it("active equals tracked ids; retained bytes equal their sum", () => {
    const a = webhookTelemetryBegin();
    const b = webhookTelemetryBegin();
    webhookTelemetryBytes(a, 100);
    webhookTelemetryBytes(b, 250);
    const snap = webhookTelemetrySnapshot();
    expect(snap.active_requests).toBe(2);
    expect(snap.retained_bytes).toBe(350);
    expect(snap.integrity.active_matches_inflight).toBe(true);
    expect(snap.high_water.current_window.active_requests).toBeGreaterThanOrEqual(2);
    expect(snap.high_water.current_window.retained_bytes).toBeGreaterThanOrEqual(350);
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

  it("REAPER: an inflight record whose termination signal never arrived is force-released, counted, and never silent", () => {
    const a = webhookTelemetryBegin();
    webhookTelemetryBytes(a, 4096);
    __webhookTelemetryTestBackdateInflight(a, 601_000); // past MAX_INFLIGHT_MS
    const snap = webhookTelemetrySnapshot();            // snapshot triggers the reaper
    expect(snap.active_requests).toBe(0);
    expect(snap.retained_bytes).toBe(0);
    expect(snap.outcomes.reaped).toBe(1);               // distinct bucket, not aborted
    expect(snap.outcomes.aborted).toBe(0);
    expect(snap.integrity.reaped_stale).toBe(1);        // visible, not silent
    expect(snap.integrity.active_matches_inflight).toBe(true);
    // A live-record release after a reap is still exactly-once.
    expect(webhookTelemetryRelease(a, "aborted")).toBe(false);
  });

  it("WINDOW ROLLOVER with in-flight requests: the new window is seeded from current gauges, not zero", () => {
    const a = webhookTelemetryBegin();
    const b = webhookTelemetryBegin();
    webhookTelemetryBytes(a, 1000);
    webhookTelemetryBytes(b, 2000);
    // Force the 60s window to roll over with both requests still in flight.
    __webhookTelemetryTestBackdateWindow(61_000);
    const snap = webhookTelemetrySnapshot(); // triggers rollover + reseed
    expect(snap.active_requests).toBe(2);
    expect(snap.retained_bytes).toBe(3000);
    // The fresh window immediately reflects the sustained load.
    expect(snap.high_water.current_window.active_requests).toBe(2);
    expect(snap.high_water.current_window.retained_bytes).toBe(3000);
    expect(snap.high_water.recent_windows).toHaveLength(1);
    webhookTelemetryRelease(a, "completed");
    webhookTelemetryRelease(b, "completed");
  });

  it("REAPER spares young records (live requests are never force-released)", () => {
    const a = webhookTelemetryBegin();
    __webhookTelemetryTestBackdateInflight(a, 299_000); // under requestTimeout
    const snap = webhookTelemetrySnapshot();
    expect(snap.active_requests).toBe(1);
    expect(snap.integrity.reaped_stale).toBe(0);
    webhookTelemetryRelease(a, "completed");
  });
});

describe("MIDDLEWARE — every outcome counted exactly once; admission behavior unchanged", () => {
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
    // Admission behavior: unchanged contract (202 accepted, enqueued).
    expect(res.status).toBe(202);

    const snap = webhookTelemetrySnapshot();
    expect(snap.active_requests).toBe(0);
    expect(snap.retained_bytes).toBe(0);
    expect(snap.outcomes.completed).toBe(1);
    expect(snap.retained_bytes).toBe(0); // all buffers released
    expect(snap.high_water.current_window.retained_bytes).toBeGreaterThanOrEqual(Buffer.byteLength(payload));
    expect(snap.durations_ms.streaming.count).toBe(1);
    expect(snap.durations_ms.retention.count).toBe(1);
    expect(snap.integrity.active_matches_inflight).toBe(true);
  });

  it("400 (missing headers): counted, body bytes still accounted and released", async () => {
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

  it("401 (bad signature): counted, byte-complete body released", async () => {
    const payload = JSON.stringify({ some: "payload" });
    const res = await supertest(app)
      .post("/webhooks/github")
      .set("x-github-event", "issues")
      .set("x-github-delivery", "tel-401-1")
      .set("x-hub-signature-256", "sha256=deadbeef")
      .set("content-type", "application/json")
      .send(payload);
    expect(res.status).toBe(401); // admission behavior unchanged
    const snap = webhookTelemetrySnapshot();
    expect(snap.outcomes.rejected_401).toBe(1);
    expect(snap.active_requests).toBe(0);
    expect(snap.retained_bytes).toBe(0);
    expect(snap.durations_ms.streaming.count).toBe(1);
  });

  it("413 via declared Content-Length: counted with ZERO retained bytes (nothing is read)", async () => {
    const res = await supertest(app)
      .post("/webhooks/github")
      .set("x-github-event", "issues")
      .set("x-github-delivery", "tel-413-decl")
      .set("x-hub-signature-256", "sha256=x")
      .set("content-type", "application/json")
      .set("content-length", String(26 * 1024 * 1024));
    expect(res.status).toBe(413); // admission behavior unchanged
    const snap = webhookTelemetrySnapshot();
    expect(snap.outcomes.rejected_413).toBe(1);
    expect(snap.active_requests).toBe(0);
    expect(snap.retained_bytes).toBe(0);
    expect(snap.high_water.current_window.retained_bytes).toBe(0); // never buffered
  });

  it("413 via streaming over-cap: counted; retained bytes peaked at the cap before release", async () => {
    const mw = express_raw_body_middleware();
    const req = new Readable({ read() {} });
    req.headers = {};
    const json = jest.fn();
    const res = {
      statusCode: 0, headers: {}, writableEnded: false,
      setHeader(k, v) { this.headers[k] = v; },
      status(c) { this.statusCode = c; return { json }; },
      on(ev, fn) { (this._h ||= {})[ev] ||= []; this._h[ev].push(fn); return this; },
      finish() { this.writableEnded = true; (this._h?.finish || []).forEach((f) => f()); },
    };
    const next = jest.fn();
    mw(req, res, next);

    // One chunk at the cap (buffered), then the chunk that crosses it (413).
    req.push(Buffer.alloc(25 * 1024 * 1024));
    await new Promise((r) => setImmediate(r));
    let snap = webhookTelemetrySnapshot();
    expect(snap.active_requests).toBe(1);
    expect(snap.retained_bytes).toBe(25 * 1024 * 1024);
    expect(snap.high_water.current_window.retained_bytes).toBe(25 * 1024 * 1024);

    req.push(Buffer.alloc(2));
    await new Promise((r) => setImmediate(r));
    expect(res.statusCode).toBe(413); // admission behavior unchanged
    expect(json).toHaveBeenCalledTimes(1);

    // Response terminates -> exactly-once release with the 413 outcome.
    res.finish();
    snap = webhookTelemetrySnapshot();
    expect(snap.outcomes.rejected_413).toBe(1);
    expect(snap.active_requests).toBe(0);
    expect(snap.retained_bytes).toBe(0);
    // Streaming never completed for a rejected body.
    expect(snap.durations_ms.streaming.count).toBe(0);
    expect(snap.durations_ms.retention.count).toBe(1);
  });

  it("OVERLAPPING requests: high-water concurrency >= 2 while both are in flight, then exact drain", async () => {
    // Two requests whose bodies complete at controlled times: drive the
    // middleware directly with paused streams so overlap is deterministic.
    const mk = () => {
      const stream = new Readable({ read() {} });
      const req = Object.assign(stream, {
        headers: { "content-length": "100" },
        on: stream.on.bind(stream),
        removeListener: stream.removeListener.bind(stream),
        resume: stream.resume.bind(stream),
      });
      const res = {
        statusCode: 200,
        headers: {},
        writableEnded: false,
        setHeader(k, v) { this.headers[k] = v; },
        status(c) { this.statusCode = c; return this; },
        json() { return this; },
        on(ev, fn) { (this._h ||= {})[ev] ||= []; this._h[ev].push(fn); return this; },
        finish() { this.writableEnded = true; (this._h?.finish || []).forEach((f) => f()); },
      };
      return { req, res };
    };

    const middleware = express_raw_body_middleware();
    const a = mk();
    const b = mk();

    // Admit both, deliver one chunk to each (bodies now retained).
    middleware(a.req, a.res, () => {});
    middleware(b.req, b.res, () => {});
    a.req.emit("data", Buffer.alloc(100));
    b.req.emit("data", Buffer.alloc(100));

    let snap = webhookTelemetrySnapshot();
    expect(snap.active_requests).toBe(2);
    expect(snap.retained_bytes).toBe(200);
    expect(snap.high_water.current_window.active_requests).toBeGreaterThanOrEqual(2);

    // First completes (body end + response finish), second still held.
    a.req.emit("end");
    a.res.finish();
    snap = webhookTelemetrySnapshot();
    expect(snap.active_requests).toBe(1);
    expect(snap.retained_bytes).toBe(100);
    expect(snap.outcomes.completed).toBe(1);

    // Abnormal termination of the second: aborted before any response.
    b.req.emit("aborted");
    snap = webhookTelemetrySnapshot();
    expect(snap.active_requests).toBe(0);
    expect(snap.retained_bytes).toBe(0);
    expect(snap.outcomes.aborted).toBe(1);
    expect(snap.integrity.active_matches_inflight).toBe(true);
  });

  it("REAL DISCONNECT: a client socket destroyed mid-body is released as aborted (no finish; res close)", async () => {
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
    await delay(200); // chunk buffered, request in flight
    sock.destroy();   // premature disconnect: no response, no finish

    await delay(300); // res 'close' propagation
    const snap = webhookTelemetrySnapshot();
    expect(snap.outcomes.aborted).toBe(1);
    expect(snap.active_requests).toBe(0);
    expect(snap.retained_bytes).toBe(0);
    expect(snap.integrity.active_matches_inflight).toBe(true);

    server.close();
    await delay(50);
  });

  it("stream error mid-body: outcome error (Express error path), exactly-once release", async () => {
    const stream = new Readable({ read() {} });
    const req = Object.assign(stream, {
      headers: {},
      on: stream.on.bind(stream),
      removeListener: stream.removeListener.bind(stream),
      resume: stream.resume.bind(stream),
    });
    const res = {
      statusCode: 200, headers: {}, writableEnded: false,
      setHeader(k, v) { this.headers[k] = v; },
      status(c) { this.statusCode = c; return this; },
      json() { return this; },
      on(ev, fn) { (this._h ||= {})[ev] ||= []; this._h[ev].push(fn); return this; },
      finish() { this.writableEnded = true; (this._h?.finish || []).forEach((f) => f()); },
    };
    const next = jest.fn();
    express_raw_body_middleware()(req, res, next);
    req.emit("data", Buffer.alloc(10));
    req.emit("error", new Error("socket blew up"));
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ message: "socket blew up" })); // admission behavior unchanged

    // Held until Express's error handler terminates the response.
    let snap = webhookTelemetrySnapshot();
    expect(snap.active_requests).toBe(1);
    expect(snap.retained_bytes).toBe(10);

    // The error handler's terminal response finishes the request → release
    // with the 5xx outcome bucket.
    res.status(500);
    res.finish();
    snap = webhookTelemetrySnapshot();
    expect(snap.outcomes.error).toBe(1);
    expect(snap.active_requests).toBe(0);
    expect(snap.retained_bytes).toBe(0);
  });
});
