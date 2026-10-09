// tests/unit/webhook-body-limit.test.js
// #10 regressions: the webhook raw-body middleware enforces a streaming size
// cap. Oversized payloads are rejected with 413 DURING reading — before HMAC
// verification, JSON parsing, or dispatch — while accepted bodies reach the
// route byte-exact. Content-Length is an early-out only; actual bytes are
// the enforcement.

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

const { webhookRouter, express_raw_body_middleware } = await import("../../src/routes/webhooks.js");

const express = (await import("express")).default;
const supertest = (await import("supertest")).default;

function makeApp() {
  const app = express();
  app.use("/webhooks", webhookRouter);
  return app;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockWebhookApp.webhooks.verifyAndReceive.mockReset();
  mockRouteWebhookToQueue.mockReset();
  // Default: verifier performs a REAL HMAC-SHA256 check against the known
  // test secret, so "correctly signed" in these tests means cryptographically
  // valid, not mocked-accepted.
  mockWebhookApp.webhooks.verifyAndReceive.mockImplementation(
    async ({ payload, signature }) => {
      const expected =
        "sha256=" +
        createHmac("sha256", WEBHOOK_SECRET).update(payload).digest("hex");
      if (signature !== expected) {
        throw new Error("signature mismatch");
      }
      return undefined;
    },
  );
  mockRouteWebhookToQueue.mockResolvedValue(undefined);
});

describe("#10 — streaming body-size cap on the webhook route", () => {
  const app = makeApp();

  const VALID_HEADERS = {
    "x-github-event": "issues",
    "x-github-delivery": "d-1",
    "x-hub-signature-256": "sha256=fake",
    "content-type": "application/json",
  };
  const VALID_BODY = JSON.stringify({ action: "opened", issue: { number: 1 } });

  it("a CORRECTLY SIGNED delivery (real HMAC over the raw bytes) verifies and dispatches end-to-end", async () => {
    const body = JSON.stringify({ action: "opened", issue: { number: 7 } });
    const signature =
      "sha256=" + createHmac("sha256", WEBHOOK_SECRET).update(body).digest("hex");
    const res = await supertest(app)
      .post("/webhooks/github")
      .set({
        "x-github-event": "issues",
        "x-github-delivery": "d-signed",
        "x-hub-signature-256": signature,
        "content-type": "application/json",
      })
      .send(body);
    // The verifier in this suite performs a REAL HMAC comparison — 202 means
    // the signature was cryptographically valid over the byte-exact body,
    // and the event was dispatched (mocked queue).
    expect(res.status).toBe(202);
    expect(mockWebhookApp.webhooks.verifyAndReceive).toHaveBeenCalledTimes(1);
    expect(mockRouteWebhookToQueue).toHaveBeenCalledTimes(1);
  });

  it("an incorrectly signed delivery is rejected 401 (the verifier's real HMAC path)", async () => {
    const res = await supertest(app)
      .post("/webhooks/github")
      .set({
        "x-github-event": "issues",
        "x-github-delivery": "d-bad",
        "x-hub-signature-256": "sha256=" + "0".repeat(64),
        "content-type": "application/json",
      })
      .send('{"action":"opened"}');
    expect(res.status).toBe(401);
    expect(mockRouteWebhookToQueue).not.toHaveBeenCalled();
  });

  it("a valid-sized delivery passes the cap and reaches signature verification byte-exact", async () => {
    let seenPayload = null;
    mockWebhookApp.webhooks.verifyAndReceive.mockImplementation(async ({ payload }) => {
      seenPayload = payload;
    });
    const res = await supertest(app)
      .post("/webhooks/github")
      .set(VALID_HEADERS)
      .send(VALID_BODY);
    // The mocked verifier accepts, so the route 202s — the proof of byte-
    // exact passthrough is the payload the verifier received.
    expect(res.status).toBe(202);
    expect(mockWebhookApp.webhooks.verifyAndReceive).toHaveBeenCalledTimes(1);
    expect(seenPayload).toBe(VALID_BODY); // byte-exact passthrough
  });

  it("an oversized DECLARED Content-Length is rejected 413 without reading or verification", async () => {
    const res = await supertest(app)
      .post("/webhooks/github")
      .set({ ...VALID_HEADERS, "content-length": String(26 * 1024 * 1024) })
      .send("{}");
    expect(res.status).toBe(413);
    expect(mockWebhookApp.webhooks.verifyAndReceive).not.toHaveBeenCalled();
    expect(mockRouteWebhookToQueue).not.toHaveBeenCalled();
  });

  it("a client that DECLARES oversized but keeps uploading receives exactly one 413 and a close-connection disposition", async () => {
    // Declared-length rejection happens before any read; this client ignores
    // the response and streams its (declared-oversized) body anyway. The
    // middleware must have detached from the stream (no buffering) and set
    // connection: close so the socket reaps.
    const mw = express_raw_body_middleware();
    const req = new Readable({ read() {} });
    req.headers = { "content-length": String(26 * 1024 * 1024) };
    const json = jest.fn();
    const setHeader = jest.fn();
    const status = jest.fn(() => ({ json }));
    const res = { status, setHeader };
    const next = jest.fn();
    mw(req, res, next);
    await new Promise((r) => setImmediate(r));

    expect(status).toHaveBeenCalledTimes(1);
    expect(status).toHaveBeenCalledWith(413);
    expect(json).toHaveBeenCalledTimes(1);
    expect(setHeader).toHaveBeenCalledWith("connection", "close");
    expect(next).not.toHaveBeenCalled();

    // The client keeps transmitting after the 413: nothing may buffer.
    const before = process.memoryUsage().heapUsed; // informational only
    req.push(Buffer.alloc(1024 * 1024, 0x61));
    req.push(Buffer.alloc(1024 * 1024, 0x61));
    await new Promise((r) => setImmediate(r));
    expect(req.rawBody).toBeUndefined(); // nothing was ever concatenated
    expect(req.listenerCount("data")).toBe(0);
    expect(req.listenerCount("end")).toBe(1) // the swallow listener until termination;
    expect(req.listenerCount("error")).toBe(1) // the swallow listener until termination;
    void before;

    // And the HTTP-level behavior: a continuing-upload client still gets
    // exactly one 413 (the response was already complete).
    expect(status).toHaveBeenCalledTimes(1);
  });

  it("an oversized CHUNKED stream (no Content-Length) is cut off mid-read with 413 and no verification", async () => {
    // Streaming via .write() keeps the request chunked — no Content-Length
    // exists, so only the middleware's streaming byte counter can enforce.
    const req = supertest(app).post("/webhooks/github").set(VALID_HEADERS);
    const chunk = Buffer.alloc(1024 * 1024, 0x61);
    for (let i = 0; i < 26; i += 1) req.write(chunk);
    const res = await req;
    expect(res.status).toBe(413);
    expect(mockWebhookApp.webhooks.verifyAndReceive).not.toHaveBeenCalled();
    expect(mockRouteWebhookToQueue).not.toHaveBeenCalled();
  });

  it("an oversized request LACKING auth headers is still rejected 413 (not 400) — the cap fires before header checks", async () => {
    const res = await supertest(app)
      .post("/webhooks/github")
      .set("content-length", String(26 * 1024 * 1024))
      .send("{}");
    expect(res.status).toBe(413);
  });
});

describe("#10 — late stream errors after rejection (both paths)", () => {
  it('DECLARED-LENGTH path: a stream error arriving AFTER the 413 is swallowed — no uncaught throw, no second response, cleanup runs', async () => {
    const mw = express_raw_body_middleware();
    const req = new Readable({ read() {} });
    req.headers = { "content-length": String(26 * 1024 * 1024) };
    const json = jest.fn();
    const setHeader = jest.fn();
    const status = jest.fn(() => ({ json }));
    const res = { status, setHeader };
    const next = jest.fn();
    mw(req, res, next);
    await new Promise((r) => setImmediate(r));
    expect(status).toHaveBeenCalledWith(413);

    // Late error on the drained stream — must not throw uncaught and must
    // not produce a second response or a next() call.
    req.destroy(new Error('ECONNRESET mid-drain'));
    await new Promise((r) => setImmediate(r));
    expect(status).toHaveBeenCalledTimes(1);
    expect(json).toHaveBeenCalledTimes(1);
    expect(next).not.toHaveBeenCalled();
    // The swallow listener removed itself on error.
    expect(req.listenerCount('error')).toBe(0);
  });

  it('STREAMING path: a stream error arriving AFTER the mid-stream 413 is swallowed the same way', async () => {
    const mw = express_raw_body_middleware();
    const req = new Readable({ read() {} });
    req.headers = {};
    const json = jest.fn();
    const setHeader = jest.fn();
    const status = jest.fn(() => ({ json }));
    const res = { status, setHeader };
    const next = jest.fn();
    mw(req, res, next);
    req.push(Buffer.alloc(26 * 1024 * 1024 + 1));
    await new Promise((r) => setImmediate(r));
    expect(status).toHaveBeenCalledWith(413);

    req.destroy(new Error('ECONNRESET after cutoff'));
    await new Promise((r) => setImmediate(r));
    expect(status).toHaveBeenCalledTimes(1);
    expect(json).toHaveBeenCalledTimes(1);
    expect(next).not.toHaveBeenCalled();
    expect(req.listenerCount('error')).toBe(0);
  });

  it('clean END after the mid-stream 413 also removes the swallow listener (no leak)', async () => {
    const mw = express_raw_body_middleware();
    const req = new Readable({ read() {} });
    req.headers = {};
    const res = { status: jest.fn(() => ({ json: jest.fn() })), setHeader: jest.fn() };
    mw(req, res, jest.fn());
    req.push(Buffer.alloc(26 * 1024 * 1024 + 1));
    await new Promise((r) => setImmediate(r));
    req.push(null); // graceful end of the (drained) stream
    await new Promise((r) => setImmediate(r));
    expect(req.listenerCount('error')).toBe(0);
    expect(req.listenerCount('end')).toBe(0);
  });
});

describe("#10 — earlier listeners survive the declared-length rejection (no blanket removal)", () => {
  it("listeners registered BEFORE this middleware remain installed after the declared-length 413", async () => {
    const mw = express_raw_body_middleware();
    const req = new Readable({ read() {} });
    req.headers = { "content-length": String(26 * 1024 * 1024) };
    // Simulate an earlier middleware / framework instrumentation listener.
    const probeData = () => {};
    const probeEnd = () => {};
    const probeError = () => {};
    req.on("data", probeData);
    req.on("end", probeEnd);
    req.on("error", probeError);

    const res = { status: jest.fn(() => ({ json: jest.fn() })), setHeader: jest.fn() };
    mw(req, res, jest.fn());
    await new Promise((r) => setImmediate(r));

    expect(res.status).toHaveBeenCalledWith(413);
    // All three pre-existing listeners survive — the rejection removes
    // nothing it did not attach itself.
    expect(req.listenerCount("data")).toBe(1);
    expect(req.listenerCount("end")).toBe(2); // probe + swallow
    expect(req.listenerCount("error")).toBe(2); // probe + swallow
    expect(req.listeners("data")[0]).toBe(probeData);
    expect(req.listeners("end")).toContain(probeEnd);
    expect(req.listeners("error")).toContain(probeError);
  });
});

describe("#10 — middleware-level stream semantics", () => {
  it("a body exactly AT the cap passes the early Content-Length check and merges byte-exact", async () => {
    const mw = express_raw_body_middleware();
    const req = new Readable({ read() {} });
    req.headers = { "content-length": String(25 * 1024 * 1024) };
    const res = { status: jest.fn(() => ({ json: jest.fn() })), setHeader: jest.fn() };
    const next = jest.fn();
    mw(req, res, next);
    req.push(Buffer.from("{}"));
    req.push(null);
    await new Promise((r) => setImmediate(r));
    expect(res.status).not.toHaveBeenCalledWith(413);
    expect(next).toHaveBeenCalledTimes(1);
    expect(req.rawBody.toString()).toBe("{}");
  });

  it("a stream error after data aborts cleanly via next(err) with no duplicate settlement", async () => {
    const mw = express_raw_body_middleware();
    const req = new Readable({ read() {} });
    req.headers = {};
    const res = { status: jest.fn(() => ({ json: jest.fn() })), setHeader: jest.fn() };
    const next = jest.fn();
    mw(req, res, next);
    req.push(Buffer.from("part"));
    const err = new Error("ECONNRESET");
    req.destroy(err);
    await new Promise((r) => setImmediate(r));
    expect(next).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledWith(err);
    expect(res.status).not.toHaveBeenCalled();
    // No lingering listeners remain attached.
    expect(req.listenerCount("data")).toBe(0);
    expect(req.listenerCount("end")).toBe(0);
    expect(req.listenerCount("error")).toBe(0);
  });

  it("oversized mid-stream termination responds 413 exactly once, drains, and detaches all listeners", async () => {
    const mw = express_raw_body_middleware();
    const req = new Readable({ read() {} });
    req.headers = {};
    const json = jest.fn();
    const setHeader = jest.fn();
    const status = jest.fn(() => ({ json }));
    const res = { status, setHeader };
    const next = jest.fn();
    mw(req, res, next);
    req.push(Buffer.alloc(26 * 1024 * 1024 + 1));
    await new Promise((r) => setImmediate(r));
    expect(status).toHaveBeenCalledTimes(1);
    expect(status).toHaveBeenCalledWith(413);
    expect(json).toHaveBeenCalledTimes(1);
    expect(setHeader).toHaveBeenCalledWith("connection", "close");
    expect(next).not.toHaveBeenCalled();
    // Draining (not buffering): the stream flows with no data listener.
    expect(req.listenerCount("data")).toBe(0);
    expect(req.listenerCount("end")).toBe(1) // the swallow listener until termination;
    expect(req.listenerCount("error")).toBe(1) // the swallow listener until termination;
  });
});
