// tests/unit/webhook-body-limit.test.js
// #10 regressions: the webhook raw-body middleware enforces a streaming size
// cap. Oversized payloads are rejected with 413 DURING reading — before HMAC
// verification, JSON parsing, or dispatch — while accepted bodies reach the
// route byte-exact. Content-Length is an early-out only; actual bytes are
// the enforcement.

import { jest } from "@jest/globals";
import { Readable } from "node:stream";

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
  mockWebhookApp.webhooks.verifyAndReceive.mockResolvedValue(undefined);
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
    expect(req.listenerCount("end")).toBe(0);
    expect(req.listenerCount("error")).toBe(0);
  });
});
