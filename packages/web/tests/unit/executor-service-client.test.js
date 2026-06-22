// Tests for the executor-service HTTP client (v0.23.0 Task 3).
//
// The client wraps GET /health (POST /v1/validate is Task 5, not here).
// Tests inject a fake fetch via _setFetchForTests so no real network is hit.

import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import {
  fetchExecutorServiceHealth,
  _setFetchForTests,
} from "../../src/lib/executorServiceClient.js";

function makeHealthResponse(overrides = {}) {
  return {
    status: "ok",
    executor_service_id: "executor-service",
    executor_service_version: "1.0.0",
    executor_service_instance_id: "test-instance-id",
    deployment_mode: "compose-local",
    container_runtime: "docker",
    runtime_version: "29.5.0",
    validator_image_ref: "registry.example.com/v@sha256:" + "a".repeat(64),
    validator_image_digest: "sha256:" + "a".repeat(64),
    ready: true,
    ...overrides,
  };
}

// Build a fake fetch that responds with the given JSON body + status.
function fakeFetch(body, status = 200) {
  return async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  });
}

describe("fetchExecutorServiceHealth — success path", () => {
  beforeEach(() => _setFetchForTests(fakeFetch(makeHealthResponse())));
  afterEach(() => _setFetchForTests(null));

  it("returns the parsed health body", async () => {
    const r = await fetchExecutorServiceHealth({ url: "http://x:3003" });
    expect(r.executor_service_id).toBe("executor-service");
    expect(r.ready).toBe(true);
  });

  it("preserves all 10 documented fields", async () => {
    const r = await fetchExecutorServiceHealth({ url: "http://x:3003" });
    for (const f of [
      "status", "executor_service_id", "executor_service_version",
      "executor_service_instance_id", "deployment_mode",
      "container_runtime", "runtime_version",
      "validator_image_ref", "validator_image_digest", "ready",
    ]) {
      expect(r).toHaveProperty(f);
    }
  });
});

describe("fetchExecutorServiceHealth — URL + auth wiring", () => {
  let capturedUrl, capturedInit;
  beforeEach(() => {
    capturedUrl = null;
    capturedInit = null;
    _setFetchForTests(async (url, init) => {
      capturedUrl = url;
      capturedInit = init;
      return { ok: true, status: 200, json: async () => makeHealthResponse() };
    });
  });
  afterEach(() => _setFetchForTests(null));

  it("calls GET <url>/health", async () => {
    await fetchExecutorServiceHealth({ url: "http://executor:3003" });
    expect(capturedUrl).toBe("http://executor:3003/health");
  });

  it("uses method GET", async () => {
    await fetchExecutorServiceHealth({ url: "http://executor:3003" });
    expect(capturedInit.method).toBe("GET");
  });

  it("sends the bearer token when provided", async () => {
    await fetchExecutorServiceHealth({ url: "http://executor:3003", token: "secret" });
    expect(capturedInit.headers.Authorization).toBe("Bearer secret");
  });

  it("omits Authorization when no token is set", async () => {
    await fetchExecutorServiceHealth({ url: "http://executor:3003" });
    expect(capturedInit.headers.Authorization).toBeUndefined();
  });

  it("sets a bounded timeout (AbortSignal, not infinite)", async () => {
    await fetchExecutorServiceHealth({ url: "http://executor:3003" });
    expect(capturedInit.signal).toBeInstanceOf(AbortSignal);
  });
});

describe("fetchExecutorServiceHealth — failure modes", () => {
  afterEach(() => _setFetchForTests(null));

  it("returns reachable:false shape on non-200 (e.g. 503)", async () => {
    _setFetchForTests(fakeFetch({}, 503));
    const r = await fetchExecutorServiceHealth({ url: "http://x:3003" });
    expect(r.reachable).toBe(false);
  });

  it("returns reachable:false shape on network error (fetch rejects)", async () => {
    _setFetchForTests(async () => { throw new Error("ECONNREFUSED"); });
    const r = await fetchExecutorServiceHealth({ url: "http://x:3003" });
    expect(r.reachable).toBe(false);
  });

  it("returns reachable:false shape on abort/timeout", async () => {
    _setFetchForTests(async () => {
      const err = new Error("aborted");
      err.name = "AbortError";
      throw err;
    });
    const r = await fetchExecutorServiceHealth({ url: "http://x:3003" });
    expect(r.reachable).toBe(false);
  });

  it("never throws — always returns a shaped object (probe contract)", async () => {
    _setFetchForTests(async () => { throw new Error("boom"); });
    // The function must not reject even when fetch throws; it returns a
    // reachable:false object so the probe contract holds.
    const r = await fetchExecutorServiceHealth({ url: "http://x:3003" });
    expect(typeof r).toBe("object");
    expect(r.reachable).toBe(false);
  });
});

describe("fetchExecutorServiceHealth — seam safety", () => {
  it("_setFetchForTests(null) restores real fetch (does not throw on shape)", () => {
    _setFetchForTests(null);
    // We can't assert the real result (no service in unit tests), only that
    // the function returns a shaped object rather than crashing the module.
    // Use a deliberately-bad URL so the real fetch fails fast, then verify
    // the function returns reachable=false instead of throwing.
    return expect(
      fetchExecutorServiceHealth({ url: "http://127.0.0.1:1" })
    ).resolves.toMatchObject({ reachable: false });
  });
});
